package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/safety"
)

// RestartedAtAnnotation is the pod template annotation kubectl rollout
// restart sets: a new value is a new template, so the controller rolls
// every pod.
const RestartedAtAnnotation = "kubectl.kubernetes.io/restartedAt"

// restartable says why a row can't be rolled, "" if it can: the apps/v1
// workloads kubectl rollout restart knows, a deployment only unpaused (its
// controller ignores template changes while paused; kubectl refuses too).
func restartable(r row) string {
	obj := r.item.Object
	if obj == nil || obj.GetAPIVersion() != "apps/v1" {
		return fmt.Sprintf("%s can't be restarted", strings.ToLower(r.kind()))
	}
	switch r.kind() {
	case "Deployment":
		if paused, _, _ := unstructured.NestedBool(obj.Object, "spec", "paused"); paused {
			return "deployment is paused"
		}
	case "StatefulSet", "DaemonSet":
	default:
		return fmt.Sprintf("%s can't be restarted", strings.ToLower(r.kind()))
	}
	return ""
}

// Restart redeems a prepared restart and rolls the row's pods, as kubectl
// rollout restart does: a merge patch of the restartedAt annotation on the
// pod template, with the prepared UID (a recreated object is refused).
func (s *Service) Restart(token string) error {
	a, target, err := s.guard.Redeem(token, safety.Restart)
	if err != nil {
		return err
	}
	r := target.(row)
	patch, err := restartPatch(s.opts.Clock.Now(), a.UID)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := s.opts.Actor.Patch(ctx, r.cluster, r.res, a.Namespace, a.Name, patch, false); err != nil {
		return fmt.Errorf("restart %s: %w", a.Name, err)
	}
	s.refreshAfter(r)
	return nil
}

func restartPatch(now time.Time, uid string) ([]byte, error) {
	md := map[string]any{}
	if uid != "" {
		md["uid"] = uid
	}
	tmpl := map[string]any{"metadata": map[string]any{"annotations": map[string]any{RestartedAtAnnotation: now.Format(time.RFC3339)}}}
	return json.Marshal(map[string]any{"metadata": md, "spec": map[string]any{"template": tmpl}})
}
