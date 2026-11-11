package source

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/httpstream"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/tools/remotecommand"
	"k8s.io/client-go/transport/spdy"
	"k8s.io/kubectl/pkg/describe"

	corev1 "k8s.io/api/core/v1"
)

// Describe implements Actor.
func (o *ClusterOpener) Describe(ctx context.Context, cluster string, res Resolved, namespace, name string) (string, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return "", err
	}
	return c.Describe(ctx, res, namespace, name)
}

// Describe renders kubectl's describe output: the typed describer for
// built-in kinds, the generic one (fields + events) for CRDs.
func (c *Cluster) Describe(_ context.Context, res Resolved, namespace, name string) (string, error) {
	gvk, err := c.mapper.KindFor(res.GVR)
	if err != nil {
		return "", err
	}
	m, err := c.mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return "", err
	}
	d, ok := describe.DescriberFor(gvk.GroupKind(), c.Config)
	if !ok {
		if d, ok = describe.GenericDescriberFor(m, c.Config); !ok {
			return "", fmt.Errorf("no describer for %s", gvk.Kind)
		}
	}
	if m.Scope.Name() != meta.RESTScopeNameNamespace {
		namespace = ""
	}
	return d.Describe(namespace, name, describe.DescriberSettings{ShowEvents: true, ChunkSize: 500})
}

// Exec implements Actor.
func (o *ClusterOpener) Exec(ctx context.Context, cluster, namespace, pod, container string, cmd []string, s ExecStreams) error {
	c, err := o.cluster(cluster)
	if err != nil {
		return err
	}
	return c.Exec(ctx, namespace, pod, container, cmd, s)
}

// Exec runs cmd with a TTY, like `kubectl exec -it`: WebSocket first, SPDY
// as fallback for older API servers and proxies.
func (c *Cluster) Exec(ctx context.Context, namespace, pod, container string, cmd []string, s ExecStreams) error {
	cs, err := kubernetes.NewForConfigAndClient(c.Config, c.http)
	if err != nil {
		return err
	}
	req := cs.CoreV1().RESTClient().Post().Resource("pods").Namespace(namespace).Name(pod).SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{Container: container, Command: cmd, Stdin: true, Stdout: true, TTY: true}, scheme.ParameterCodec)
	ex, err := executor(c.Config, req.URL())
	if err != nil {
		return err
	}
	return ex.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdin: s.Stdin, Stdout: s.Stdout, Tty: true, TerminalSizeQueue: sizeQueue(s.Resize),
	})
}

func executor(cfg *rest.Config, u *url.URL) (remotecommand.Executor, error) {
	spdyExec, err := remotecommand.NewSPDYExecutor(cfg, "POST", u)
	if err != nil {
		return nil, err
	}
	wsExec, err := remotecommand.NewWebSocketExecutor(cfg, "GET", u.String())
	if err != nil {
		return nil, err
	}
	return remotecommand.NewFallbackExecutor(wsExec, spdyExec, func(err error) bool {
		return httpstream.IsUpgradeFailure(err) || httpstream.IsHTTPSProxyError(err)
	})
}

type sizeQueue <-chan TerminalSize

func (q sizeQueue) Next() *remotecommand.TerminalSize {
	if q == nil {
		return nil
	}
	s, ok := <-q
	if !ok {
		return nil
	}
	return &remotecommand.TerminalSize{Width: s.Cols, Height: s.Rows}
}

// Logs implements Actor.
func (o *ClusterOpener) Logs(ctx context.Context, cluster, namespace, pod, container string, lo LogOptions, w io.Writer) error {
	c, err := o.cluster(cluster)
	if err != nil {
		return err
	}
	return c.Logs(ctx, namespace, pod, container, lo, w)
}

// Logs follows a container's logs, like `kubectl logs -f --timestamps`, and
// copies them to w until the stream ends or ctx is cancelled (NoFollow: like
// `kubectl logs --timestamps`, until what is there is read; Previous: the
// previous instance's, as `kubectl logs -p`).
func (c *Cluster) Logs(ctx context.Context, namespace, pod, container string, lo LogOptions, w io.Writer) error {
	cs, err := kubernetes.NewForConfigAndClient(c.Config, c.http)
	if err != nil {
		return err
	}
	opts := &corev1.PodLogOptions{
		Container:    container,
		Follow:       !lo.NoFollow,
		Timestamps:   true,
		TailLines:    lo.TailLines,
		SinceSeconds: lo.SinceSeconds,
		Previous:     lo.Previous,
	}
	if lo.SinceTime != nil {
		opts.SinceTime = &metav1.Time{Time: *lo.SinceTime}
	}
	stream, err := cs.CoreV1().Pods(namespace).GetLogs(pod, opts).Stream(ctx)
	if err != nil {
		return err
	}
	defer stream.Close()
	_, err = io.Copy(w, stream)
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

// PortForward implements Actor.
func (o *ClusterOpener) PortForward(ctx context.Context, cluster, namespace, pod string, ports []string) (*Forward, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return nil, err
	}
	return c.PortForward(ctx, namespace, pod, ports)
}

// PortForward forwards on 127.0.0.1 only, like `kubectl port-forward`:
// SPDY tunneled over WebSocket first, plain SPDY as fallback.
func (c *Cluster) PortForward(ctx context.Context, namespace, pod string, ports []string) (*Forward, error) {
	cs, err := kubernetes.NewForConfigAndClient(c.Config, c.http)
	if err != nil {
		return nil, err
	}
	u := cs.CoreV1().RESTClient().Post().Resource("pods").Namespace(namespace).Name(pod).SubResource("portforward").URL()
	transport, upgrader, err := spdy.RoundTripperFor(c.Config)
	if err != nil {
		return nil, err
	}
	dialer := spdy.NewDialer(upgrader, &http.Client{Transport: transport}, "POST", u)
	tunnel, err := portforward.NewSPDYOverWebsocketDialer(u, c.Config)
	if err != nil {
		return nil, err
	}
	dialer = portforward.NewFallbackDialer(tunnel, dialer, func(err error) bool {
		return httpstream.IsUpgradeFailure(err) || httpstream.IsHTTPSProxyError(err)
	})
	stop, ready := make(chan struct{}), make(chan struct{})
	var errOut strings.Builder
	fw, err := portforward.NewOnAddresses(dialer, []string{"127.0.0.1"}, ports, stop, ready, io.Discard, &syncWriter{w: &errOut})
	if err != nil {
		return nil, err
	}
	done := make(chan struct{})
	var mu sync.Mutex
	var runErr error
	go func() {
		err := fw.ForwardPorts()
		mu.Lock()
		runErr = err
		mu.Unlock()
		close(done)
	}()
	select {
	case <-ready:
	case <-done:
		mu.Lock()
		defer mu.Unlock()
		if runErr == nil {
			runErr = errors.New("port-forward ended before it was ready")
		}
		return nil, runErr
	case <-ctx.Done():
		close(stop)
		return nil, ctx.Err()
	}
	fp, err := fw.GetPorts()
	if err != nil {
		close(stop)
		return nil, err
	}
	var once sync.Once
	f := &Forward{Done: done, Stop: func() { once.Do(func() { close(stop) }) }}
	f.Err = func() error {
		mu.Lock()
		defer mu.Unlock()
		return runErr
	}
	for _, p := range fp {
		f.Ports = append(f.Ports, Port{Local: p.Local, Remote: p.Remote})
	}
	return f, nil
}

type syncWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (s *syncWriter) Write(b []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.w.Write(b)
}
