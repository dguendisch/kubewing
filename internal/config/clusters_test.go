package config

import (
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

func TestClusters(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "kw")
	s := OpenClusters(dir)
	at := time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)
	for i := range MaxClusters + 5 {
		if err := s.Add(Cluster{Kubeconfig: []string{"/k"}, Context: fmt.Sprint("c", i), Used: at.Add(time.Duration(i) * time.Hour)}); err != nil {
			t.Fatal(err)
		}
	}
	shoot := Cluster{Garden: "g", Namespace: "garden-p", Shoot: "s", Context: "g/shoot--p--s", Used: at.Add(200 * time.Hour)}
	_ = s.Add(shoot)
	got := s.List()
	if len(got) != MaxClusters || got[0].Shoot != "s" || got[1].Context != "c104" || got[MaxClusters-1].Context != "c6" {
		t.Fatalf("list: %d, first %+v, last %+v", len(got), got[0], got[len(got)-1])
	}
	// the same target by its project's name is the same cluster: moved up, not repeated
	_ = s.Add(Cluster{Kubeconfig: []string{"/k"}, Context: "c50", Used: at.Add(300 * time.Hour)})
	again := Cluster{Garden: "g", Project: "p", Namespace: "garden-p", Shoot: "s", Used: at.Add(400 * time.Hour)}
	_ = s.Add(again)
	got = OpenClusters(dir).List()
	if len(got) != MaxClusters || got[0].Project != "p" || got[1].Context != "c50" {
		t.Errorf("reloaded: %d %+v %+v", len(got), got[0], got[1])
	}
	// the control plane is another cluster
	if (Cluster{Garden: "g", Namespace: "garden-p", Shoot: "s", ControlPlane: true}).Same(shoot) {
		t.Error("control plane same as shoot")
	}
	// within a minute: not written again
	_ = s.Add(Cluster{Garden: "g", Project: "p", Namespace: "garden-p", Shoot: "s", Used: at.Add(400*time.Hour + time.Second)})
	if !s.List()[0].Used.Equal(again.Used) {
		t.Error("rewritten within a minute")
	}
	_ = s.Remove(Cluster{Kubeconfig: []string{"/k"}, Context: "c50"})
	if got := OpenClusters(dir).List(); len(got) != MaxClusters-1 || got[1].Context == "c50" {
		t.Errorf("removed: %d %+v", len(got), got[1])
	}
	if err := OpenClusters("").Add(shoot); err != nil {
		t.Errorf("in memory: %v", err)
	}
}
