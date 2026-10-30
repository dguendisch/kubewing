package source

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// Metrics reads current resource usage (kubectl top) from metrics.k8s.io.
// The API can't be watched, so callers poll it. Implemented by real
// clusters and tapes.
type Metrics interface {
	// Usage lists the usage of a source's pods or nodes (kind "Pod" or
	// "Node"; its namespace and label selector apply), keyed by
	// namespace/name ("/name" for nodes). A cluster without
	// metrics-server, or no permission for it, is ErrNoMetrics wrapped
	// with the reason.
	Usage(ctx context.Context, cluster string, k Key, kind string) (map[string]Usage, error)
}

// Usage is one object's current usage, summed over its containers.
type Usage struct {
	// CPU in millicores, Memory in bytes.
	CPU    int64
	Memory int64
}

// ErrNoMetrics: the cluster serves no usage (no metrics-server, or forbidden).
var ErrNoMetrics = errors.New("metrics unavailable")

var metricsGV = schema.GroupVersion{Group: "metrics.k8s.io", Version: "v1beta1"}

// Usage implements Metrics.
func (o *ClusterOpener) Usage(ctx context.Context, cluster string, k Key, kind string) (map[string]Usage, error) {
	c, err := o.cluster(cluster)
	if err != nil {
		return nil, err
	}
	return c.Usage(ctx, kind, k.Namespace, k.LabelSelector)
}

// Usage lists pod or node metrics.
func (c *Cluster) Usage(ctx context.Context, kind, namespace, labelSel string) (map[string]Usage, error) {
	rc, err := c.restClient(metricsGV)
	if err != nil {
		return nil, err
	}
	res := "pods"
	if kind == "Node" {
		res = "nodes"
	}
	req := rc.Get().Resource(res).SetHeader("Accept", "application/json")
	if res == "pods" && namespace != "" && namespace != "*" {
		req = req.Namespace(namespace)
	}
	if labelSel != "" {
		req = req.Param("labelSelector", labelSel)
	}
	body, err := req.DoRaw(ctx)
	if err != nil {
		if apierrors.IsNotFound(err) || apierrors.IsForbidden(err) || apierrors.IsServiceUnavailable(err) {
			return nil, fmt.Errorf("%w: %v", ErrNoMetrics, statusError(body, err))
		}
		return nil, statusError(body, err)
	}
	return decodeUsage(body)
}

// metricsList is a PodMetricsList or NodeMetricsList: pods have
// containers, nodes a usage of their own.
type metricsList struct {
	Items []struct {
		Metadata struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
		} `json:"metadata"`
		Usage      map[string]resource.Quantity `json:"usage"`
		Containers []struct {
			Usage map[string]resource.Quantity `json:"usage"`
		} `json:"containers"`
	} `json:"items"`
}

func decodeUsage(body []byte) (map[string]Usage, error) {
	var l metricsList
	if err := json.Unmarshal(body, &l); err != nil {
		return nil, fmt.Errorf("metrics: %w", err)
	}
	out := make(map[string]Usage, len(l.Items))
	for _, it := range l.Items {
		u := addUsage(Usage{}, it.Usage)
		for _, c := range it.Containers {
			u = addUsage(u, c.Usage)
		}
		out[it.Metadata.Namespace+"/"+it.Metadata.Name] = u
	}
	return out, nil
}

func addUsage(u Usage, q map[string]resource.Quantity) Usage {
	if cpu, ok := q["cpu"]; ok {
		u.CPU += cpu.MilliValue()
	}
	if mem, ok := q["memory"]; ok {
		u.Memory += mem.Value()
	}
	return u
}
