package normalize

import (
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
)

const prevDescribe = `Name:         web-0
Namespace:    shop
Status:       Running
Containers:
  app:
    Image:          nginx:1.27
    Restart Count:  3
Conditions:
  Type              Status
  ----              ------
  Ready             True
Events:
  Type     Reason   Age                From     Message
  ----     ------   ----               ----     -------
  Normal   Pulled   2m (x3 over 10m)   kubelet  Container image "nginx:1.27" already present
  Warning  BackOff  90s                kubelet  Back-off restarting failed container app`

// 5 minutes later: ages moved, the pull count went up, a new event with a
// longer reason widened the columns, the restart count changed.
const curDescribe = `Name:         web-0
Namespace:    shop
Status:       Running
Containers:
  app:
    Image:          nginx:1.27
    Restart Count:  5
Conditions:
  Type              Status
  ----              ------
  Ready             True
Events:
  Type     Reason     Age                 From     Message
  ----     ------     ----                ----     -------
  Normal   Pulled     7m (x5 over 15m)    kubelet  Container image "nginx:1.27" already present
  Warning  BackOff    6m                  kubelet  Back-off restarting failed container app
  Warning  OOMKilled  10s                 kubelet  Container app was OOM killed`

func changedLines(a, b string) (removed, added []string) {
	in := func(s string, l []string) bool {
		for _, x := range l {
			if x == s {
				return true
			}
		}
		return false
	}
	al, bl := strings.Split(a, "\n"), strings.Split(b, "\n")
	for _, l := range al {
		if !in(l, bl) {
			removed = append(removed, l)
		}
	}
	for _, l := range bl {
		if !in(l, al) {
			added = append(added, l)
		}
	}
	return
}

func TestDescribePairOnlyRealChanges(t *testing.T) {
	p, c := DescribePair(prevDescribe, curDescribe)
	removed, added := changedLines(p, c)
	if diff := cmp.Diff([]string{
		"    Restart Count:  3",
		"  Normal   Pulled     (x3)  kubelet  Container image \"nginx:1.27\" already present",
	}, removed); diff != "" {
		t.Errorf("removed (-want +got):\n%s\n--- prev:\n%s", diff, p)
	}
	if diff := cmp.Diff([]string{
		"    Restart Count:  5",
		"  Normal   Pulled     (x5)  kubelet  Container image \"nginx:1.27\" already present",
		"  Warning  OOMKilled        kubelet  Container app was OOM killed",
	}, added); diff != "" {
		t.Errorf("added (-want +got):\n%s\n--- cur:\n%s", diff, c)
	}
	// the BackOff event only aged: identical after normalization, despite the wider column
	if !strings.Contains(p, "  Warning  BackOff          kubelet  Back-off restarting failed container app") ||
		!strings.Contains(c, "  Warning  BackOff          kubelet  Back-off restarting failed container app") {
		t.Errorf("aged event must render identically:\n%s\n---\n%s", p, c)
	}
}

func TestDescribeIdenticalRunsAreIdentical(t *testing.T) {
	later := strings.ReplaceAll(prevDescribe, "2m (x3 over 10m)", "4m (x3 over 12m)")
	later = strings.ReplaceAll(later, "90s ", "3m  ")
	p, c := DescribePair(prevDescribe, later)
	if p != c {
		t.Errorf("only times changed, but:\n%s\n---\n%s", p, c)
	}
}

func TestDescribeNodeHeartbeatsAndLease(t *testing.T) {
	node := func(hb, renew string) string {
		return `Name:               node-a
Lease:
  HolderIdentity:  node-a
  RenewTime:       ` + renew + `
Conditions:
  Type             Status  LastHeartbeatTime                 LastTransitionTime                Reason                       Message
  ----             ------  -----------------                 ------------------                ------                       -------
  MemoryPressure   False   ` + hb + `   Mon, 01 Jan 2026 09:00:00 +0000   KubeletHasSufficientMemory   kubelet has sufficient memory available
  Ready            True    ` + hb + `   Mon, 01 Jan 2026 09:00:00 +0000   KubeletReady                 kubelet is posting ready status`
	}
	p, c := DescribePair(node("Mon, 01 Jan 2026 10:00:00 +0000", "Mon, 01 Jan 2026 10:00:03 +0000"),
		node("Mon, 01 Jan 2026 10:05:00 +0000", "Mon, 01 Jan 2026 10:05:07 +0000"))
	if p != c {
		t.Errorf("heartbeats/renewals must not count as changes:\n%s\n---\n%s", p, c)
	}
	if !strings.Contains(c, "KubeletReady") || !strings.Contains(c, "LastTransitionTime") {
		t.Errorf("the rest of the table must stay:\n%s", c)
	}
}

func TestDescribeKeepsNonTableText(t *testing.T) {
	in := "Name:  x\nAnnotations:  a: b\n              c: d\n\nEvents:  <none>"
	p, c := DescribePair(in, in)
	if p != in || c != in {
		t.Errorf("plain text must pass through:\n%q", p)
	}
}
