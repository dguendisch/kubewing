package view

import (
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// stampColumns are server columns re-derived from a timestamp of the object,
// by kind and column name: the server sends them as text ("5m") that would
// only change when the object does, so they'd go stale and sort coarsely.
var stampColumns = map[string]map[string]func(*unstructured.Unstructured) string{
	// core/v1 and events.k8s.io/v1 (whose names are deprecated*)
	"Event": {"LAST SEEN": eventLastSeen, "FIRST SEEN": eventFirstSeen},
	// a namespace's snapshot (source.AllKind)
	"*": {"DELETING": deletionStamp},
}

// deletionStamp is when an object's deletion was requested; "" if it wasn't.
func deletionStamp(obj *unstructured.Unstructured) string {
	if t := obj.GetDeletionTimestamp(); t != nil {
		return t.UTC().Format(time.RFC3339)
	}
	return ""
}

func creationStamp(obj *unstructured.Unstructured) string {
	return obj.GetCreationTimestamp().UTC().Format(time.RFC3339)
}

// eventFirstSeen is kubectl's First Seen: firstTimestamp, else eventTime.
func eventFirstSeen(obj *unstructured.Unstructured) string {
	return firstStamp(obj.Object, []string{"firstTimestamp"}, []string{"deprecatedFirstTimestamp"}, []string{"eventTime"})
}

// eventLastSeen is kubectl's Last Seen: series.lastObservedTime, else
// lastTimestamp, else First Seen.
func eventLastSeen(obj *unstructured.Unstructured) string {
	if s := firstStamp(obj.Object, []string{"series", "lastObservedTime"}, []string{"lastTimestamp"}, []string{"deprecatedLastTimestamp"}); s != "" {
		return s
	}
	return eventFirstSeen(obj)
}

// firstStamp is the first of the fields that holds a timestamp, as RFC 3339
// in UTC to the second (so cells compare as strings); "" if none does.
func firstStamp(obj map[string]any, fields ...[]string) string {
	for _, f := range fields {
		s, _, _ := unstructured.NestedString(obj, f...)
		if t, err := time.Parse(time.RFC3339Nano, s); err == nil && !t.IsZero() {
			return t.UTC().Format(time.RFC3339)
		}
	}
	return ""
}
