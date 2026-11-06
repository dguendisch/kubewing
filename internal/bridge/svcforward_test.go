package bridge

import (
	"fmt"
	"strings"
	"testing"
)

func TestServicePortInfo(t *testing.T) {
	svc, _ := relSetup(t)
	res := openSynced(t, svc, "source: {resource: rel-services}", 4)
	web, err := svc.RowInfo(res.Pane, "rs-web")
	if err != nil {
		t.Fatal(err)
	}
	// service ports, each with its target: a named container port, or the port itself when unset
	if !web.Service || web.Pod || fmt.Sprint(web.Ports) != "[80 9090]" ||
		fmt.Sprint(web.PortInfo) != "[{80 http TCP  http} {9090 metrics TCP  9090}]" {
		t.Errorf("web: %+v", web)
	}
	dns, _ := svc.RowInfo(res.Pane, "rs-dns")
	if fmt.Sprint(dns.PortInfo) != "[{53 dns UDP  5353} {8080 http TCP  8080}]" {
		t.Errorf("dns: %+v", dns.PortInfo)
	}
}

// like kubectl port-forward svc/web: the most active pod of the selector
// (web-7d9f-a: ready), service ports translated to its container ports
func TestPortForwardService(t *testing.T) {
	svc, _ := relSetup(t)
	res := openSynced(t, svc, "source: {resource: rel-services}", 4)
	f, err := svc.PortForwardStart(res.Pane, "rs-web", []string{"8080:80", "9090"})
	if err != nil {
		t.Fatal(err)
	}
	want := []ForwardPort{{Local: 8080, Remote: 8080, Service: 80}, {Local: 40001, Remote: 9090, Service: 9090}}
	if f.Service != "web" || f.Pod != "web-7d9f-a" || f.Namespace != "shop" || fmt.Sprint(f.Ports) != fmt.Sprint(want) {
		t.Errorf("forward: %+v", f)
	}
	if l := svc.PortForwards(); len(l) != 1 || l[0].Service != "web" {
		t.Errorf("list: %+v", l)
	}
	for _, c := range []struct{ key, port, err string }{
		{"rs-web", "7000", "does not have a service port 7000"},
		{"rs-dns", "53", "UDP only"},
		{"rs-external", "443", "has no selector"},
		{"rs-idle", "80", "has no pods"},
	} {
		if _, err := svc.PortForwardStart(res.Pane, c.key, []string{c.port}); err == nil || !strings.Contains(err.Error(), c.err) {
			t.Errorf("%s %s: %v, want %q", c.key, c.port, err, c.err)
		}
	}
	// a TCP port of a service that also has a UDP one forwards
	if f, err := svc.PortForwardStart(res.Pane, "rs-dns", []string{"18080:8080"}); err != nil || f.Ports[0].Remote != 8080 {
		t.Errorf("dns 8080: %+v %v", f, err)
	}
}
