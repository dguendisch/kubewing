package logs

import (
	"bytes"
	"io"
	"slices"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/source"
)

// containerInfo is one of a pod's containers, with whether it is currently
// running per the pod status.
type containerInfo struct {
	name    string
	running bool
	// hasState is whether the container is running or terminated; a
	// container the kubelet hasn't reported yet (no status) is not loggable.
	hasState bool
	// reported is whether the pod status lists the container at all (waiting too).
	reported bool
	// hasPrevious is whether a previous instance terminated (lastState), so
	// its logs can be read (kubectl logs -p): a crash-looping container's.
	hasPrevious bool
}

// loggable reports whether logs can be read: the container has a state
// (running or terminated). A purely waiting container (ImagePullBackOff) has
// no readable log yet, so following it would just error in a loop. For the
// previous instance's logs every reported container counts (a crash-looping
// one waits): one without a previous instance says so instead.
func (c containerInfo) loggable(previous bool) bool {
	if previous {
		return c.reported
	}
	return c.hasState
}

// containers lists a pod's regular, init, sidecar and ephemeral containers in
// spec order, with their running state from the pod status. It reads an
// unstructured pod directly, so internal/logs needs no typed pod.
func containers(obj *unstructured.Unstructured) []containerInfo {
	o := obj.Object
	type st struct {
		running, hasState, hasPrevious bool
	}
	states := map[string]st{}
	for _, f := range []string{"containerStatuses", "initContainerStatuses", "ephemeralContainerStatuses"} {
		list, _, _ := unstructured.NestedSlice(o, "status", f)
		for _, s := range list {
			m, _ := s.(map[string]any)
			name, _, _ := unstructured.NestedString(m, "name")
			if name == "" {
				continue
			}
			state, _, _ := unstructured.NestedMap(m, "state")
			_, running := state["running"]
			_, terminated := state["terminated"]
			last, _, _ := unstructured.NestedMap(m, "lastState")
			_, prev := last["terminated"]
			states[name] = st{running: running, hasState: running || terminated, hasPrevious: prev}
		}
	}
	var out []containerInfo
	for _, f := range []string{"containers", "initContainers", "ephemeralContainers"} {
		list, _, _ := unstructured.NestedSlice(o, "spec", f)
		for _, c := range list {
			m, _ := c.(map[string]any)
			name, _, _ := unstructured.NestedString(m, "name")
			if name == "" {
				continue
			}
			cs, ok := states[name]
			out = append(out, containerInfo{name: name, running: cs.running, hasState: cs.hasState, reported: ok, hasPrevious: cs.hasPrevious})
		}
	}
	return out
}

// ContainerNames lists the distinct container names of pods (regular, init,
// sidecar and ephemeral) in first-seen order: the containers a tailer of
// them could follow.
func ContainerNames(pods []source.Item) []string {
	var out []string
	for _, it := range pods {
		if it.Object == nil {
			continue
		}
		for _, c := range containers(it.Object) {
			if !slices.Contains(out, c.name) {
				out = append(out, c.name)
			}
		}
	}
	return out
}

// lineWriter turns the raw byte stream of one container's logs into lines,
// splits off kubectl's RFC 3339 timestamp prefix, and forwards each to the
// tailer. A line longer than cap is truncated with a marker. It is the
// io.Writer handed to Actor.Logs.
type lineWriter struct {
	tailer *Tailer
	f      *follower
	cap    int
	buf    []byte
}

func (w *lineWriter) Write(p []byte) (int, error) {
	n := len(p)
	w.buf = append(w.buf, p...)
	for {
		i := bytes.IndexByte(w.buf, '\n')
		if i < 0 {
			if len(w.buf) > w.cap {
				// an over-long line with no newline yet: emit the capped part
				w.emit(w.buf[:w.cap], true)
				w.buf = w.buf[:0]
			}
			break
		}
		line := w.buf[:i]
		w.emit(line, false)
		w.buf = w.buf[i+1:]
	}
	return n, nil
}

// flush emits whatever is buffered without a trailing newline (the stream
// ended mid-line).
func (w *lineWriter) flush() {
	if len(w.buf) > 0 {
		w.emit(w.buf, false)
		w.buf = w.buf[:0]
	}
}

func (w *lineWriter) emit(line []byte, truncated bool) {
	s := strings.TrimRight(string(line), "\r")
	ts, text := splitTimestamp(s)
	if truncated {
		text += " …(truncated)"
	}
	w.tailer.emit(w.f, ts, text)
}

// splitTimestamp separates kubectl's leading RFC 3339 timestamp (as produced
// by --timestamps) from the rest of the line. If the first space-delimited
// token doesn't parse as a timestamp, the whole line is the text.
func splitTimestamp(s string) (ts, text string) {
	first, rest, ok := strings.Cut(s, " ")
	if !ok {
		return "", s
	}
	if !looksLikeTimestamp(first) {
		return "", s
	}
	return first, rest
}

// looksLikeTimestamp is a cheap check for an RFC 3339 timestamp without a
// full parse: starts with "YYYY-MM-DDT" and ends in "Z" or an offset.
func looksLikeTimestamp(s string) bool {
	if len(s) < 20 || s[4] != '-' || s[7] != '-' || s[10] != 'T' {
		return false
	}
	last := s[len(s)-1]
	return last == 'Z' || strings.ContainsAny(s[19:], "+-")
}

var _ io.Writer = (*lineWriter)(nil)
