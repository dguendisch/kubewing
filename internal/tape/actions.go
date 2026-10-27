package tape

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"maps"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/yaml"

	"github.com/dguendisch/kubewing/internal/source"
)

// Describe implements source.Actor: an object's "describe" annotation
// (kubewing.test/describe) if set, else a kubectl-like summary.
func (o *Opener) Describe(_ context.Context, _ string, res source.Resolved, namespace, name string) (string, error) {
	for _, t := range o.Tapes {
		obj := t.find(namespace, name, "")
		if obj == nil {
			continue
		}
		u := obj.Item().Object
		if d := u.GetAnnotations()["kubewing.test/describe"]; d != "" {
			return d, nil
		}
		var b strings.Builder
		fmt.Fprintf(&b, "Name:         %s\n", u.GetName())
		if ns := u.GetNamespace(); ns != "" {
			fmt.Fprintf(&b, "Namespace:    %s\n", ns)
		}
		labels := u.GetLabels()
		keys := make([]string, 0, len(labels))
		for k := range labels {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		fmt.Fprintf(&b, "Labels:       ")
		for i, k := range keys {
			if i > 0 {
				b.WriteString("\n              ")
			}
			fmt.Fprintf(&b, "%s=%s", k, labels[k])
		}
		if len(keys) == 0 {
			b.WriteString("<none>")
		}
		status, _ := yaml.Marshal(u.Object["status"])
		fmt.Fprintf(&b, "\nStatus:\n%s", indent(string(status), "  "))
		// each describe is a "look": an event whose count and age change per
		// look, so the describe diff has a real change (count) and noise (age)
		o.mu.Lock()
		if o.looks == nil {
			o.looks = map[string]int{}
		}
		o.looks[namespace+"/"+name]++
		n := o.looks[namespace+"/"+name]
		o.mu.Unlock()
		b.WriteString("Events:\n")
		b.WriteString("  Type    Reason  Age                From     Message\n")
		b.WriteString("  ----    ------  ----               ----     -------\n")
		fmt.Fprintf(&b, "  Normal  Looked  %-17s  kubewing  described in a test\n", fmt.Sprintf("%ds (x%d over %dm)", n*7, n, n))
		return b.String(), nil
	}
	return "", fmt.Errorf("%s %q not found", strings.ToLower(res.Kind), name)
}

func indent(s, pre string) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	for i := range lines {
		lines[i] = pre + lines[i]
	}
	return strings.Join(lines, "\n") + "\n"
}

// Exec implements source.Actor: a tiny line-echo shell. "exit [n]" ends
// the session with that code, ⌃D at an empty prompt ends it like a real
// shell; "size" prints the last terminal size, "seq N" prints 1…N.
func (o *Opener) Exec(ctx context.Context, _, namespace, pod, container string, _ []string, s source.ExecStreams) error {
	var mu sync.Mutex
	size := source.TerminalSize{}
	go func() {
		for sz := range s.Resize {
			mu.Lock()
			size = sz
			mu.Unlock()
		}
	}()
	prompt := fmt.Sprintf("%s:%s$ ", pod, container)
	fmt.Fprintf(s.Stdout, "tape shell in %s/%s\r\n%s", namespace, pod, prompt)
	lines := make(chan string)
	go func() {
		defer close(lines)
		r := bufio.NewReader(s.Stdin)
		var line []byte
		for {
			c, err := r.ReadByte()
			if err != nil {
				return
			}
			switch c {
			case '\r', '\n':
				fmt.Fprint(s.Stdout, "\r\n")
				lines <- string(line)
				line = line[:0]
			case 0x7f: // backspace
				if len(line) > 0 {
					line = line[:len(line)-1]
					fmt.Fprint(s.Stdout, "\b \b")
				}
			case 0x04: // ⌃D: EOF on an empty line, ignored otherwise
				if len(line) == 0 {
					return
				}
			default:
				line = append(line, c)
				_, _ = s.Stdout.Write([]byte{c}) // a TTY echoes
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case l, ok := <-lines:
			if !ok {
				return nil // stdin ended: the shell is done
			}
			f := strings.Fields(l)
			switch {
			case len(f) > 0 && f[0] == "exit":
				code := 0
				if len(f) > 1 {
					code, _ = strconv.Atoi(f[1])
				}
				if code != 0 {
					return ExitError(code)
				}
				return nil
			case len(f) == 2 && f[0] == "seq": // "seq N": N numbered lines (scrollback tests)
				n, _ := strconv.Atoi(f[1])
				var b strings.Builder
				for i := 1; i <= n; i++ {
					fmt.Fprintf(&b, "%d\r\n", i)
				}
				fmt.Fprint(s.Stdout, b.String())
			case len(f) > 0 && f[0] == "size":
				mu.Lock()
				fmt.Fprintf(s.Stdout, "%dx%d\r\n", size.Cols, size.Rows)
				mu.Unlock()
			case len(f) > 0:
				fmt.Fprintf(s.Stdout, "%s\r\n", l)
			}
			fmt.Fprint(s.Stdout, prompt)
		}
	}
}

// Debug implements source.Actor: one pull progress line, then the echo
// shell in the debug container (prompt pod:name). The pod is not changed.
// An image starting with "fail/" fails like one that can't be pulled.
func (o *Opener) Debug(ctx context.Context, cluster, namespace, pod string, d source.DebugSpec, s source.ExecStreams) error {
	if d.Progress != nil {
		d.Progress(fmt.Sprintf("Pulling: Pulling image %q", d.Image))
	}
	if strings.HasPrefix(d.Image, "fail/") {
		return fmt.Errorf("debug container %s: ImagePullBackOff: Back-off pulling image %q", d.Name, d.Image)
	}
	if d.Started != nil {
		d.Started()
	}
	fmt.Fprintf(s.Stdout, "debug %s (%s, profile %s, target %q)\r\n", d.Name, d.Image, d.Profile, d.Target)
	return o.Exec(ctx, cluster, namespace, pod, d.Name, nil, s)
}

// OpsPod implements source.Actor: the pod's manifest is kept (OpsPods,
// until the session ends, as a real cluster deletes it), one progress line,
// then the echo shell (prompt node:ops-pod-…). Images "fail/…" don't pull.
func (o *Opener) OpsPod(ctx context.Context, cluster string, p source.OpsPodSpec, s source.ExecStreams) error {
	o.mu.Lock()
	if o.opsPods == nil {
		o.opsPods = map[string]*corev1.Pod{}
	}
	o.opsPods[p.Namespace+"/"+p.Name] = p.Manifest()
	o.mu.Unlock()
	defer func() {
		o.mu.Lock()
		delete(o.opsPods, p.Namespace+"/"+p.Name)
		o.mu.Unlock()
	}()
	if p.Progress != nil {
		p.Progress(fmt.Sprintf("Pulling: Pulling image %q", p.Image))
	}
	if strings.HasPrefix(p.Image, "fail/") {
		return fmt.Errorf("container %s: ImagePullBackOff: Back-off pulling image %q", source.OpsPodContainer, p.Image)
	}
	if p.Started != nil {
		p.Started()
	}
	fmt.Fprintf(s.Stdout, "ops pod %s (%s) runs %q\r\n", p.Name, p, strings.Join(source.OpsPodShell(p.Chroot), " "))
	return o.Exec(ctx, cluster, p.Namespace, p.Node, p.Name, nil, s)
}

// OpsPods are the ops pods that currently exist, by namespace/name (tests).
func (o *Opener) OpsPods() map[string]*corev1.Pod {
	o.mu.Lock()
	defer o.mu.Unlock()
	return maps.Clone(o.opsPods)
}

// Logs implements source.Actor: it emits the pod's "kubewing.test/logs"
// annotation, one line per newline, each with a synthetic RFC 3339 timestamp
// (one second apart) like `kubectl logs --timestamps`. The container name is
// substituted for "%c", so a multi-container pod's lines are distinguishable.
// If "kubewing.test/logs-follow" is set it then emits "<container> tick N" on
// a ticker scaled by Speed until ctx ends; otherwise it blocks until ctx ends
// (a real follow of a still-running container never returns on its own).
func (o *Opener) Logs(ctx context.Context, _, namespace, pod, container string, lo source.LogOptions, w io.Writer) error {
	var ann map[string]string
	for _, t := range o.Tapes {
		if obj := t.find(namespace, pod, ""); obj != nil {
			ann = obj.Item().Object.GetAnnotations()
			break
		}
	}
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var lines []string
	if raw := ann["kubewing.test/logs"]; raw != "" {
		lines = strings.Split(strings.TrimRight(raw, "\n"), "\n")
	}
	if lo.TailLines != nil && int64(len(lines)) > *lo.TailLines {
		lines = lines[int64(len(lines))-*lo.TailLines:]
	}
	for i, l := range lines {
		ts := base.Add(time.Duration(i) * time.Second)
		if lo.SinceTime != nil && !ts.After(*lo.SinceTime) {
			continue
		}
		l = strings.ReplaceAll(l, "%c", container)
		if _, err := fmt.Fprintf(w, "%s %s\n", ts.Format(time.RFC3339Nano), l); err != nil {
			return err
		}
	}
	if ann["kubewing.test/logs-follow"] == "" {
		<-ctx.Done()
		return nil
	}
	speed := o.Speed
	if speed <= 0 {
		speed = 1
	}
	tick := time.NewTicker(time.Duration(float64(time.Second) / speed))
	defer tick.Stop()
	n := len(lines)
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
			ts := base.Add(time.Duration(n) * time.Second)
			if _, err := fmt.Fprintf(w, "%s %s tick %d\n", ts.Format(time.RFC3339Nano), container, n); err != nil {
				return err
			}
			n++
		}
	}
}

// ExitError is a non-zero exit of the tape shell (mirrors exec's CodeExitError).
type ExitError int

func (e ExitError) Error() string   { return fmt.Sprintf("command terminated with exit code %d", int(e)) }
func (e ExitError) ExitStatus() int { return int(e) }

// PortForward implements source.Actor: reports the requested ports (a
// random local port for ":remote") without listening. Like an unprivileged
// process on macOS/Linux it can't bind local ports below 1024.
func (o *Opener) PortForward(_ context.Context, _, _, _ string, ports []string) (*source.Forward, error) {
	f := &source.Forward{}
	for i, p := range ports {
		local, remote, ok := strings.Cut(p, ":")
		if !ok {
			local, remote = p, p
		}
		r, err := strconv.ParseUint(remote, 10, 16)
		if err != nil {
			return nil, fmt.Errorf("port %q: %w", p, err)
		}
		l, _ := strconv.ParseUint(local, 10, 16)
		if l == 0 {
			l = uint64(40000 + i)
		}
		if l < 1024 {
			return nil, fmt.Errorf("unable to listen on port %d: listen tcp4 127.0.0.1:%d: bind: permission denied", l, l)
		}
		f.Ports = append(f.Ports, source.Port{Local: uint16(l), Remote: uint16(r)})
	}
	done := make(chan struct{})
	var once sync.Once
	f.Done = done
	f.Stop = func() { once.Do(func() { close(done) }) }
	f.Err = func() error { return nil }
	return f, nil
}
