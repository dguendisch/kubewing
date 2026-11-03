package bridge

import (
	"context"
	"fmt"

	"github.com/dguendisch/kubewing/internal/safety"
	"github.com/dguendisch/kubewing/internal/source"
)

// terminalTarget is what a prepared local terminal opens on.
type terminalTarget struct{ cluster, namespace string }

// PrepareTerminal checks a local terminal on a cluster ("" = current)
// against the safety policy: it holds the context's credentials, so a
// read-only context refuses it and a rule can ask first (confirm: [terminal]).
// namespace ("" = the context's own) becomes the shell's kubeconfig namespace.
func (s *Service) PrepareTerminal(cluster, namespace string) (safety.Pending, error) {
	if s.opts.Actor == nil {
		return safety.Pending{}, fmt.Errorf("%s is not available", safety.Terminal)
	}
	ctxName, err := s.contextName(cluster)
	if err != nil {
		return safety.Pending{}, err
	}
	a := safety.Action{Kind: safety.Terminal, Context: ctxName, Resource: "terminal", Namespace: namespace, Name: ctxName}
	return s.guard.Prepare(a, terminalTarget{cluster: cluster, namespace: namespace})
}

// TerminalResult describes a started local terminal.
type TerminalResult struct {
	Session   string `json:"session"`
	Context   string `json:"context"`
	Namespace string `json:"namespace,omitempty"`
}

// TerminalStart redeems a prepared terminal and starts the local shell.
func (s *Service) TerminalStart(token string, cols, rows int) (TerminalResult, error) {
	a, target, err := s.guard.Redeem(token, safety.Terminal)
	if err != nil {
		return TerminalResult{}, err
	}
	t := target.(terminalTarget)
	id := s.startSession(cols, rows, func(ctx context.Context, st source.ExecStreams) error {
		return s.opts.Actor.Shell(ctx, t.cluster, t.namespace, st)
	})
	return TerminalResult{Session: id, Context: a.Context, Namespace: t.namespace}, nil
}
