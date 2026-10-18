package tape

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"sync"

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
		b.WriteString("Events:       <none>\n")
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
// the session with that code; "size" prints the last terminal size.
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
				return io.EOF
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

// ExitError is a non-zero exit of the tape shell (mirrors exec's CodeExitError).
type ExitError int

func (e ExitError) Error() string   { return fmt.Sprintf("command terminated with exit code %d", int(e)) }
func (e ExitError) ExitStatus() int { return int(e) }

// PortForward implements source.Actor: reports the requested ports (a
// random local port for ":remote") without listening.
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
		f.Ports = append(f.Ports, source.Port{Local: uint16(l), Remote: uint16(r)})
	}
	done := make(chan struct{})
	var once sync.Once
	f.Done = done
	f.Stop = func() { once.Do(func() { close(done) }) }
	f.Err = func() error { return nil }
	return f, nil
}
