package source

import (
	"fmt"

	corev1 "k8s.io/api/core/v1"
)

// debugSecurityContext is the security context kubectl debug's --profile
// gives an ephemeral container (k8s.io/kubectl/pkg/cmd/debug/profiles.go,
// the "ephemeral" style; ported because that package drags in kubectl's CLI).
func debugSecurityContext(profile string) (*corev1.SecurityContext, error) {
	switch profile {
	case "", "general":
		return &corev1.SecurityContext{Capabilities: &corev1.Capabilities{Add: []corev1.Capability{"SYS_PTRACE"}}}, nil
	case "baseline":
		return nil, nil
	case "restricted":
		return &corev1.SecurityContext{
			RunAsNonRoot:             ptr(true),
			Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
			AllowPrivilegeEscalation: ptr(false),
			SeccompProfile:           &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
		}, nil
	case "netadmin":
		return &corev1.SecurityContext{Capabilities: &corev1.Capabilities{Add: []corev1.Capability{"NET_ADMIN", "NET_RAW"}}}, nil
	case "sysadmin":
		return &corev1.SecurityContext{Privileged: ptr(true)}, nil
	}
	return nil, fmt.Errorf("unknown debug profile %q", profile)
}

func ptr[T any](v T) *T { return &v }
