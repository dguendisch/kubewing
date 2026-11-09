package bridge

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/dguendisch/kubewing/internal/gardener"
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
		sid, cleanup := s.gardenctlSession(t.cluster, t.namespace)
		defer cleanup()
		return s.opts.Actor.Shell(ctx, t.cluster, t.namespace, []string{"GCTL_SESSION_ID=" + sid}, st)
	})
	return TerminalResult{Session: id, Context: a.Context, Namespace: t.namespace}, nil
}

// gardenctlSession is a gardenctl session of the shell's own (not the
// terminal kubewing was launched from, whose target `gardenctl target` would
// move), targeting the pane's Gardener cluster if it is one, so gardenctl's
// commands (provider-env, ssh, kubectl-env) work on it right away. Removed
// when the shell ends.
func (s *Service) gardenctlSession(cluster, namespace string) (string, func()) {
	dir := ""
	var t gardener.Target
	if s.opts.Gardener != nil {
		dir = s.opts.Gardener.ShellSessions
		t, _ = s.gardenctlTarget(cluster, namespace)
	}
	id, cleanup, err := gardener.NewSession(dir, t)
	if err != nil {
		// the shell without a target rather than none
		log.Printf("terminal: gardenctl target %+v: %v", t, err)
		id, cleanup, _ = gardener.NewSession("", gardener.Target{})
	}
	return id, cleanup
}

// gardenctlTarget is the Gardener target a pane (cluster, namespace) shows,
// as `gardenctl target` would name it: a shoot; a control plane (also a
// shoot's namespace on a seed); a seed; a garden, with the project of the
// pane's namespace. Found as ⌘⇧P finds it (opened by ⌘⇧O or ⌘J, else by its
// kubeconfig), a garden also by its API server.
func (s *Service) gardenctlTarget(cluster, namespace string) (gardener.Target, bool) {
	s.mu.Lock()
	t, ok := s.opened[openedKey(cluster, namespace, true)]
	if !ok {
		t, ok = s.opened[openedKey(cluster, "", false)]
	}
	s.mu.Unlock()
	if !ok {
		t, ok = targetOfKubeconfig(cluster)
	}
	if !ok {
		cfg, err := s.gardenConfig()
		if err != nil {
			return gardener.Target{}, false
		}
		g, isGarden := s.gardenOf(cfg, cluster)
		if !isGarden {
			return gardener.Target{}, false
		}
		t, ok = gardener.Target{Garden: g.Identity}, true
	}
	switch {
	case t.ControlPlane, t.Shoot != "" && t.Seed == "":
		return gardener.Target{Garden: t.Garden, Project: t.ProjectName(), Shoot: t.Shoot, ControlPlane: t.ControlPlane, Seed: t.Seed}, true
	case t.Seed != "":
		// a seed: a shoot's namespace there is its control plane (gardenctl's context namespace if the pane shows all)
		if namespace == "" {
			if gl, isGl := source.GardenloginOf(cluster); isGl {
				namespace = gl.Namespace
			}
		}
		if project, shoot, isCP := gardener.ShootOfNamespace(namespace); isCP {
			return gardener.Target{Garden: t.Garden, Project: project, Shoot: shoot, ControlPlane: true, Seed: t.Seed}, true
		}
		return gardener.Target{Garden: t.Garden, Seed: t.Seed}, true
	default:
		// a garden: the project of the pane's namespace, else the one opened
		if namespace != "" {
			t.Project, t.Namespace = "", namespace
			if namespace != "garden" && !strings.HasPrefix(namespace, "garden-") {
				t.Namespace = ""
			}
		}
		return gardener.Target{Garden: t.Garden, Project: t.ProjectName()}, true
	}
}
