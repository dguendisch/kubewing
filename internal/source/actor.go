package source

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8stypes "k8s.io/apimachinery/pkg/types"
)

// Actor performs object actions. Callers go through the safety model
// (internal/safety) first; implementations do no policy checks themselves.
type Actor interface {
	// ContextName resolves a pane's cluster ("" = current) to the context
	// name the safety policy matches against.
	ContextName(cluster string) (string, error)
	// Describe renders `kubectl describe` output (including events).
	Describe(ctx context.Context, cluster string, res Resolved, namespace, name string) (string, error)
	// Delete deletes one object. uid is a precondition: an object recreated
	// under the same name in the meantime is never deleted.
	Delete(ctx context.Context, cluster string, res Resolved, namespace, name string, uid k8stypes.UID) error
	// Exec runs cmd in a pod container with a TTY until it exits or ctx ends.
	Exec(ctx context.Context, cluster, namespace, pod, container string, cmd []string, s ExecStreams) error
	// Debug adds an ephemeral container to a pod, like `kubectl debug -it`,
	// waits until it runs and attaches to it with a TTY until it exits or ctx
	// ends. The container stays in the pod spec (terminated) afterwards.
	Debug(ctx context.Context, cluster, namespace, pod string, d DebugSpec, s ExecStreams) error
	// PortForward forwards local ports on 127.0.0.1 to a pod ("8080:80",
	// ":80" for a random local port) until Stop.
	PortForward(ctx context.Context, cluster, namespace, pod string, ports []string) (*Forward, error)
}

// ExecStreams are the TTY streams of an exec session.
type ExecStreams struct {
	Stdin  io.Reader
	Stdout io.Writer
	// Resize delivers terminal size changes; closed when the session ends.
	Resize <-chan TerminalSize
}

// DebugSpec describes a debug container.
type DebugSpec struct {
	// Name of the new ephemeral container (unique in the pod).
	Name  string
	Image string
	// Target shares that container's process namespace ("" = none).
	Target string
	// Profile is a kubectl debug --profile value (general, netadmin …).
	Profile string
	// Started is called once the container runs, before attaching.
	Started func()
	// Progress reports what happens until then, one line each: the
	// container's waiting reason and the kubelet's events for it (Pulling
	// image …, Pulled …), as kubectl debug shows them.
	Progress func(line string)
}

// TerminalSize is a terminal's size in cells.
type TerminalSize struct{ Cols, Rows uint16 }

// Port is one forwarded port.
type Port struct {
	Local  uint16 `json:"local"`
	Remote uint16 `json:"remote"`
}

// Forward is a running port-forward.
type Forward struct {
	Ports []Port
	// Done is closed when the forward ends (Stop, pod gone, connection lost);
	// Err then tells why (nil after Stop).
	Done <-chan struct{}
	Err  func() error
	Stop func()
}

// ContextName implements Actor.
func (o *ClusterOpener) ContextName(cluster string) (string, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return "", err
	}
	return c.Context, nil
}

// Delete implements Actor.
func (o *ClusterOpener) Delete(ctx context.Context, cluster string, res Resolved, namespace, name string, uid k8stypes.UID) error {
	c, err := o.cluster(cluster)
	if err != nil {
		return err
	}
	return c.Delete(ctx, res, namespace, name, uid)
}

// Delete deletes one object with a UID precondition and background
// propagation (kubectl's default).
func (c *Cluster) Delete(ctx context.Context, res Resolved, namespace, name string, uid k8stypes.UID) error {
	rc, err := c.restClient(res.GVR.GroupVersion())
	if err != nil {
		return err
	}
	bg := metav1.DeletePropagationBackground
	opts := metav1.DeleteOptions{
		TypeMeta:          metav1.TypeMeta{Kind: "DeleteOptions", APIVersion: "v1"},
		PropagationPolicy: &bg,
	}
	if uid != "" {
		opts.Preconditions = &metav1.Preconditions{UID: &uid}
	}
	body, err := json.Marshal(opts)
	if err != nil {
		return err
	}
	req := rc.Delete().Resource(res.GVR.Resource).Name(name).Body(body).SetHeader("Content-Type", "application/json")
	if res.Namespaced {
		req = req.Namespace(namespace)
	}
	if b, err := req.DoRaw(ctx); err != nil {
		return fmt.Errorf("delete %s/%s: %w", res.GVR.Resource, name, statusError(b, err))
	}
	return nil
}

// statusError prefers the API server's Status message: the raw serializer
// can't decode Status, so client-go's own error only names the HTTP reason.
func statusError(body []byte, err error) error {
	var st metav1.Status
	if json.Unmarshal(body, &st) == nil && st.Kind == "Status" && st.Message != "" {
		return errors.New(st.Message)
	}
	return err
}
