package view

import (
	"strings"
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

// podRestarts re-derives a pod's Restarts cell. The server sends it as text,
// "3 (5m ago)", whose "ago" part only changes when the pod does. The count
// stays the server's; the "ago" part becomes the newest restart's timestamp:
// "3 (2026-01-01T11:55:00Z)", which the frontend renders against its own
// clock (pipeline.TypeRestarts). Without a timestamp in the pod, or without
// an "ago" part, the server's text stays; a count alone (an integer cell, as
// older servers and tapes send it) is formatted as is.
func podRestarts(obj *unstructured.Unstructured, cell any) string {
	s, ok := cell.(string)
	if !ok {
		return format(cell, "")
	}
	count, rest, ok := strings.Cut(s, " (")
	if !ok || !strings.HasSuffix(rest, " ago)") {
		return s
	}
	if t := lastRestart(obj.Object); t != "" {
		return count + " (" + t + ")"
	}
	return s
}

// lastRestart is when a container of the pod last terminated (kubectl's
// "ago": the newest lastState.terminated.finishedAt, init containers too),
// as RFC 3339 in UTC to the second; "" if none did.
func lastRestart(pod map[string]any) string {
	var last string
	for _, field := range []string{"initContainerStatuses", "containerStatuses"} {
		statuses, _, _ := unstructured.NestedSlice(pod, "status", field)
		for _, cs := range statuses {
			m, ok := cs.(map[string]any)
			if !ok {
				continue
			}
			if t := firstStamp(m, []string{"lastState", "terminated", "finishedAt"}); t > last {
				last = t
			}
		}
	}
	return last
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
