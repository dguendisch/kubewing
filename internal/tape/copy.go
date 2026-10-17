package tape

import "k8s.io/apimachinery/pkg/runtime"

// YAML decodes integers as int64/float64 already, but DeepCopyJSON panics on
// plain int; normalize first.
func runtimeDeepCopy(m map[string]any) map[string]any {
	return runtime.DeepCopyJSON(fixNumbers(m).(map[string]any))
}

func fixNumbers(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = fixNumbers(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = fixNumbers(e)
		}
		return out
	case int:
		return int64(x)
	case float64:
		if x == float64(int64(x)) {
			return int64(x)
		}
		return x
	}
	return v
}
