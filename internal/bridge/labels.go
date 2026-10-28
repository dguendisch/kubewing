package bridge

import (
	"context"
	"sort"
	"time"

	"k8s.io/apimachinery/pkg/labels"

	"github.com/dguendisch/kubewing/internal/view"
)

// labelsWait bounds the metadata list behind label completion.
const labelsWait = 10 * time.Second

// LabelCounts is label selector completion: label keys, or one key's
// values, with how many of Objects have them, most common first.
type LabelCounts struct {
	Items   []view.ValueCount `json:"items"`
	Objects int               `json:"objects"`
}

// Labels lists the label keys (key "") or a key's values among the
// objects of the pane's source that match others: the draft selector's
// requirements other than the one being completed. So the applied
// selector doesn't limit them: with app=web applied, app= offers every
// app. When others is at least as strict as the applied selector the
// pane's objects are enough (or when it shows the past, which a list
// can't); otherwise a metadata-only list of the source fetches the rest.
// An unparsable others, or a failed list, falls back to the pane's
// objects as they are.
func (s *Service) Labels(paneID, key, others string) (LabelCounts, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return LabelCounts{}, err
	}
	sel, err := labels.Parse(others)
	pn.mu.Lock()
	src := pn.p.Source
	local := err != nil || view.Narrower(others, src.LabelSelector) || !pn.view.At().IsZero()
	sets := pn.view.Labels()
	pn.mu.Unlock()
	if err != nil {
		sel = labels.Everything()
	}
	if !local {
		if listed, ok := s.listLabels(src.Cluster, src.Resource, src.Namespace, others, src.FieldSelector); ok {
			sets = listed
		}
	}
	return countLabels(sets, sel, key), nil
}

// listLabels lists the label sets of a source's objects (metadata only).
func (s *Service) listLabels(cluster, resource, namespace, labelSel, fieldSel string) ([]labels.Set, bool) {
	rel, err := s.relator()
	if err != nil {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), labelsWait)
	defer cancel()
	list, err := rel.ListMetadata(ctx, cluster, resource, namespace, labelSel, fieldSel)
	if err != nil {
		return nil, false
	}
	sets := make([]labels.Set, len(list))
	for i, it := range list {
		sets[i] = labels.Set(it.GetLabels())
	}
	return sets, true
}

// countLabels counts the keys (key "") or key's values of the sets sel
// matches, most common first, at most 200.
func countLabels(sets []labels.Set, sel labels.Selector, key string) LabelCounts {
	counts := map[string]int{}
	out := LabelCounts{Items: []view.ValueCount{}}
	for _, set := range sets {
		if !sel.Matches(set) {
			continue
		}
		out.Objects++
		if key == "" {
			for k := range set {
				counts[k]++
			}
		} else if v, ok := set[key]; ok {
			counts[v]++
		}
	}
	for v, n := range counts {
		out.Items = append(out.Items, view.ValueCount{Value: v, Count: n})
	}
	sort.Slice(out.Items, func(i, j int) bool {
		if out.Items[i].Count != out.Items[j].Count {
			return out.Items[i].Count > out.Items[j].Count
		}
		return out.Items[i].Value < out.Items[j].Value
	})
	if len(out.Items) > 200 {
		out.Items = out.Items[:200]
	}
	return out
}
