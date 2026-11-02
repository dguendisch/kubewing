package source

import (
	"context"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// apiError is the server's message for a failed request that still matches
// apierrors' checks (IsNotFound, IsForbidden …).
type apiError struct {
	msg string
	err error
}

func (e apiError) Error() string { return e.msg }
func (e apiError) Unwrap() error { return e.err }

// GetObject reads one full object by resource name ("shoots.core.gardener.cloud").
// A missing one is a NotFound error (apierrors.IsNotFound).
func (o *ClusterOpener) GetObject(ctx context.Context, cluster, resource, namespace, name string) (*unstructured.Unstructured, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return nil, err
	}
	res, err := c.Resolve(resource)
	if err != nil {
		return nil, err
	}
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
		return nil, apiError{statusError(b, err).Error(), err}
	}
	return decodeObject(b)
}

// ListObjects lists full objects by resource name ("" namespace = all), paged.
func (o *ClusterOpener) ListObjects(ctx context.Context, cluster, resource, namespace, fieldSel string) ([]*unstructured.Unstructured, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return nil, err
	}
	res, err := c.Resolve(resource)
	if err != nil {
		return nil, err
	}
	return c.listPaged(ctx, res, namespace, "", fieldSel)
}
