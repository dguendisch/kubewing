package source

import (
	"context"
	"fmt"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	kjson "k8s.io/apimachinery/pkg/util/json"
)

// Get implements Actor.
func (o *ClusterOpener) Get(ctx context.Context, cluster string, res Resolved, namespace, name string) (*unstructured.Unstructured, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return nil, err
	}
	return c.Get(ctx, res, namespace, name)
}

// GetManaged implements Actor.
func (o *ClusterOpener) GetManaged(ctx context.Context, cluster string, res Resolved, namespace, name string) (*unstructured.Unstructured, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return nil, err
	}
	return c.GetManaged(ctx, res, namespace, name)
}

// Patch implements Actor.
func (o *ClusterOpener) Patch(ctx context.Context, cluster string, res Resolved, namespace, name string, patch []byte, dryRun bool) (*unstructured.Unstructured, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return nil, err
	}
	return c.Patch(ctx, res, namespace, name, patch, dryRun)
}

// Get reads one object from the API server (not a watch cache), without
// managedFields.
func (c *Cluster) Get(ctx context.Context, res Resolved, namespace, name string) (*unstructured.Unstructured, error) {
	u, err := c.GetManaged(ctx, res, namespace, name)
	if err != nil {
		return nil, err
	}
	StripManagedFields(u)
	return u, nil
}

// GetManaged is Get with metadata.managedFields kept (for the blame).
func (c *Cluster) GetManaged(ctx context.Context, res Resolved, namespace, name string) (*unstructured.Unstructured, error) {
	rc, err := c.restClient(res.GVR.GroupVersion())
	if err != nil {
		return nil, err
	}
	req := rc.Get().Resource(res.GVR.Resource).Name(name)
	if res.Namespaced {
		req = req.Namespace(namespace)
	}
	b, err := req.DoRaw(ctx)
	if err != nil {
		return nil, fmt.Errorf("get %s/%s: %w", res.GVR.Resource, name, statusError(b, err))
	}
	u := &unstructured.Unstructured{}
	if err := kjson.Unmarshal(b, &u.Object); err != nil {
		return nil, err
	}
	return u, nil
}

// Patch sends a JSON merge patch (RFC 7386) and returns the object as the
// server stored it, or would store it with dryRun (admission and defaults
// applied, nothing persisted).
func (c *Cluster) Patch(ctx context.Context, res Resolved, namespace, name string, patch []byte, dryRun bool) (*unstructured.Unstructured, error) {
	rc, err := c.restClient(res.GVR.GroupVersion())
	if err != nil {
		return nil, err
	}
	req := rc.Patch("application/merge-patch+json").Resource(res.GVR.Resource).Name(name).Body(patch).Param("fieldManager", "kubewing")
	if res.Namespaced {
		req = req.Namespace(namespace)
	}
	if dryRun {
		req = req.Param("dryRun", "All")
	}
	b, err := req.DoRaw(ctx)
	if err != nil {
		return nil, fmt.Errorf("patch %s/%s: %w", res.GVR.Resource, name, statusError(b, err))
	}
	return decodeObject(b)
}

// Scale implements Actor.
func (o *ClusterOpener) Scale(ctx context.Context, cluster string, res Resolved, namespace, name string, replicas int64) error {
	c, err := o.cluster(cluster)
	if err != nil {
		return err
	}
	return c.Scale(ctx, res, namespace, name, replicas)
}

// Scale merge-patches spec.replicas of the scale subresource, which any
// workload with one (deployments, stateful sets, custom resources) serves
// as an autoscaling/v1 Scale, whatever its own schema.
func (c *Cluster) Scale(ctx context.Context, res Resolved, namespace, name string, replicas int64) error {
	rc, err := c.restClient(res.GVR.GroupVersion())
	if err != nil {
		return err
	}
	patch := fmt.Appendf(nil, `{"spec":{"replicas":%d}}`, replicas)
	req := rc.Patch("application/merge-patch+json").Resource(res.GVR.Resource).Name(name).SubResource("scale").Body(patch).Param("fieldManager", "kubewing")
	if res.Namespaced {
		req = req.Namespace(namespace)
	}
	if b, err := req.DoRaw(ctx); err != nil {
		return fmt.Errorf("scale %s/%s: %w", res.GVR.Resource, name, statusError(b, err))
	}
	return nil
}

func decodeObject(b []byte) (*unstructured.Unstructured, error) {
	u := &unstructured.Unstructured{}
	if err := kjson.Unmarshal(b, &u.Object); err != nil {
		return nil, err
	}
	StripManagedFields(u)
	return u, nil
}
