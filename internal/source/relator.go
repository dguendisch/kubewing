package source

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// Relator reads what the jump menu needs to follow relations between
// objects (owners, owned, references): metadata only, except where a
// reference is matched by a spec field no field selector covers (List). Resources
// are named as a pipeline names them ("replicasets.apps"). Implemented by
// real clusters and tapes.
type Relator interface {
	// ResolveKind maps an ownerReference's apiVersion + kind to the
	// resource name a pipeline uses, and whether it is namespaced.
	ResolveKind(cluster, apiVersion, kind string) (resource string, namespaced bool, err error)
	// GetMetadata reads one object's metadata. A missing object is a
	// NotFound error (apierrors.IsNotFound).
	GetMetadata(ctx context.Context, cluster, resource, namespace, name string) (*unstructured.Unstructured, error)
	// ListMetadata lists objects' metadata ("" namespace = all).
	ListMetadata(ctx context.Context, cluster, resource, namespace, labelSel, fieldSel string) ([]*unstructured.Unstructured, error)
	// List lists full objects ("" namespace = all), for small types only
	// (volume attachments).
	List(ctx context.Context, cluster, resource, namespace string) ([]*unstructured.Unstructured, error)
	// CRD reads the CustomResourceDefinition of a custom kind (for its
	// scale subresource); NotFound for built-in kinds.
	CRD(ctx context.Context, cluster, apiVersion, kind string) (*unstructured.Unstructured, error)
}

// metadataAccept asks for PartialObjectMetadata of one object.
const metadataAccept = "application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1,application/json"

var crdGVRes = Resolved{GVR: crdGVR}

// ResolveKind implements Relator.
func (o *ClusterOpener) ResolveKind(cluster, apiVersion, kind string) (string, bool, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return "", false, err
	}
	res, err := c.ResolveKind(apiVersion, kind)
	if err != nil {
		return "", false, err
	}
	return qualified(res.GVR), res.Namespaced, nil
}

// GetMetadata implements Relator.
func (o *ClusterOpener) GetMetadata(ctx context.Context, cluster, resource, namespace, name string) (*unstructured.Unstructured, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return nil, err
	}
	res, err := c.Resolve(resource)
	if err != nil {
		return nil, err
	}
	return c.GetMetadata(ctx, res, namespace, name)
}

// ListMetadata implements Relator.
func (o *ClusterOpener) ListMetadata(ctx context.Context, cluster, resource, namespace, labelSel, fieldSel string) ([]*unstructured.Unstructured, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return nil, err
	}
	res, err := c.Resolve(resource)
	if err != nil {
		return nil, err
	}
	return c.ListMetadata(ctx, res, namespace, labelSel, fieldSel)
}

// List implements Relator.
func (o *ClusterOpener) List(ctx context.Context, cluster, resource, namespace string) ([]*unstructured.Unstructured, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return nil, err
	}
	res, err := c.Resolve(resource)
	if err != nil {
		return nil, err
	}
	return c.listPaged(ctx, res, namespace, "", "")
}

// CRD implements Relator.
func (o *ClusterOpener) CRD(ctx context.Context, cluster, apiVersion, kind string) (*unstructured.Unstructured, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return nil, err
	}
	res, err := c.ResolveKind(apiVersion, kind)
	if err != nil {
		return nil, err
	}
	if res.GVR.Group == "" {
		return nil, apierrors.NewNotFound(schema.GroupResource{Group: crdGVR.Group, Resource: crdGVR.Resource}, kind)
	}
	return c.Get(ctx, crdGVRes, "", res.GVR.Resource+"."+res.GVR.Group)
}

func qualified(gvr schema.GroupVersionResource) string {
	if gvr.Group == "" {
		return gvr.Resource
	}
	return gvr.Resource + "." + gvr.Group
}

// ResolveKind maps apiVersion + kind to a resource via the RESTMapper, so
// CRD kinds work like built-ins (a miss refreshes discovery once). A group
// without a version ("rbac.authorization.k8s.io/") maps to its preferred one.
func (c *Cluster) ResolveKind(apiVersion, kind string) (Resolved, error) {
	gv, err := schema.ParseGroupVersion(apiVersion)
	if err != nil {
		return Resolved{}, err
	}
	gk := schema.GroupKind{Group: gv.Group, Kind: kind}
	m, err := c.mapper.RESTMapping(gk, gv.Version)
	if err != nil {
		c.deferred.Reset() // maybe a new CRD
		if m, err = c.mapper.RESTMapping(gk, gv.Version); err != nil {
			return Resolved{}, err
		}
	}
	return Resolved{GVR: m.Resource, Kind: kind, Namespaced: m.Scope.Name() == meta.RESTScopeNameNamespace}, nil
}

// GetMetadata reads one object as PartialObjectMetadata.
func (c *Cluster) GetMetadata(ctx context.Context, res Resolved, namespace, name string) (*unstructured.Unstructured, error) {
	rc, err := c.restClient(res.GVR.GroupVersion())
	if err != nil {
		return nil, err
	}
	req := rc.Get().Resource(res.GVR.Resource).Name(name).SetHeader("Accept", metadataAccept)
	if res.Namespaced {
		req = req.Namespace(namespace)
	}
	b, err := req.DoRaw(ctx)
	if err != nil {
		return nil, err // a StatusError: callers check apierrors.IsNotFound
	}
	return decodeObject(b)
}

// ListMetadata lists objects as metadata-only table rows, paged.
func (c *Cluster) ListMetadata(ctx context.Context, res Resolved, namespace, labelSel, fieldSel string) ([]*unstructured.Unstructured, error) {
	res.Metadata = true
	return c.listPaged(ctx, res, namespace, labelSel, fieldSel)
}

// listPaged lists objects as table rows (metadata only if res.Metadata), paged.
func (c *Cluster) listPaged(ctx context.Context, res Resolved, namespace, labelSel, fieldSel string) ([]*unstructured.Unstructured, error) {
	rc, err := c.restClient(res.GVR.GroupVersion())
	if err != nil {
		return nil, err
	}
	var out []*unstructured.Unstructured
	cont := ""
	for {
		req := c.request(rc, res, namespace, labelSel, fieldSel).Param("limit", "500")
		if cont != "" {
			req = req.Param("continue", cont)
		}
		body, err := req.DoRaw(ctx)
		if err != nil {
			return nil, fmt.Errorf("list %s: %w", res.GVR.Resource, statusError(body, err))
		}
		t, err := decodeTableOrList(body)
		if err != nil {
			return nil, fmt.Errorf("list %s: %w", res.GVR.Resource, err)
		}
		for _, it := range t.items {
			out = append(out, it.Object)
		}
		if cont = t.cont; cont == "" {
			return out, nil
		}
	}
}
