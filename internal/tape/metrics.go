package tape

import (
	"context"
	"fmt"
	"strings"

	"k8s.io/apimachinery/pkg/api/resource"

	"github.com/dguendisch/kubewing/internal/source"
)

// Usage implements source.Metrics from the tape's metrics, honoring the
// source's namespace (label selectors are ignored).
func (o *Opener) Usage(_ context.Context, _ string, k source.Key, _ string) (map[string]source.Usage, error) {
	t, ok := o.Tapes[k.Resource]
	if !ok || t.Metrics == nil {
		return nil, fmt.Errorf("%w: the server could not find the requested resource", source.ErrNoMetrics)
	}
	out := map[string]source.Usage{}
	for key, u := range t.Metrics {
		if ns, _, _ := strings.Cut(key, "/"); k.Namespace != "" && k.Namespace != "*" && ns != "" && ns != k.Namespace {
			continue
		}
		cpu, err := resource.ParseQuantity(u.CPU)
		if err != nil {
			return nil, fmt.Errorf("metrics %s: cpu: %w", key, err)
		}
		mem, err := resource.ParseQuantity(u.Memory)
		if err != nil {
			return nil, fmt.Errorf("metrics %s: memory: %w", key, err)
		}
		out[key] = source.Usage{CPU: cpu.MilliValue(), Memory: mem.Value()}
	}
	return out, nil
}
