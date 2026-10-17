package view

import (
	"fmt"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/source"
)

func benchItem(i, gen int) source.Item {
	u := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{"name": fmt.Sprintf("pod-%05d", i), "namespace": "ns", "uid": fmt.Sprintf("u%d", i)},
		"spec":     map[string]any{"gen": int64(gen)},
	}}
	return source.Item{Object: u}
}

func benchView(b *testing.B, n int) *View {
	v, err := New(pipeline.Pipeline{Source: pipeline.Source{Resource: "pods", Namespace: "ns"},
		Render: pipeline.Render{Columns: []pipeline.Column{{Name: "NAME", Path: "metadata.name"}, {Name: "GEN", Path: "spec.gen"}}}}, Options{})
	if err != nil {
		b.Fatal(err)
	}
	items := make([]source.Item, n)
	for i := range items {
		items[i] = benchItem(i, 0)
	}
	v.Apply(source.Event{Type: source.Relist, Items: items}, t0)
	v.SetViewport(100, 50)
	return v
}

func BenchmarkApply(b *testing.B) {
	v := benchView(b, 10000)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		v.Apply(source.Event{Type: source.Modified, Item: benchItem(i%10000, i)}, t0.Add(time.Duration(i)))
	}
}

func BenchmarkFrame10k(b *testing.B) {
	v := benchView(b, 10000)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		v.Apply(source.Event{Type: source.Modified, Item: benchItem(i%10000, i)}, t0)
		v.Frame(t0.Add(time.Duration(i)))
	}
}
