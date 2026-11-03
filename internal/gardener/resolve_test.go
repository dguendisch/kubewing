package gardener

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

var mtime = time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)

// fakeGarden serves objects by resource/namespace/name.
type fakeGarden struct {
	objs  map[string]*unstructured.Unstructured
	calls []string
}

func (f *fakeGarden) add(resource, ns, name string, obj map[string]any) {
	if f.objs == nil {
		f.objs = map[string]*unstructured.Unstructured{}
	}
	u := &unstructured.Unstructured{Object: obj}
	u.SetNamespace(ns)
	u.SetName(name)
	f.objs[resource+"/"+ns+"/"+name] = u
}

func (f *fakeGarden) GetObject(_ context.Context, cluster, resource, ns, name string) (*unstructured.Unstructured, error) {
	f.calls = append(f.calls, cluster+" get "+resource+" "+ns+"/"+name)
	if u, ok := f.objs[resource+"/"+ns+"/"+name]; ok {
		return u, nil
	}
	return nil, apierrors.NewNotFound(schema.GroupResource{Resource: resource}, name)
}

func (f *fakeGarden) ListObjects(_ context.Context, cluster, resource, ns, fieldSel string) ([]*unstructured.Unstructured, error) {
	f.calls = append(f.calls, cluster+" list "+resource+" "+fieldSel)
	name := strings.TrimPrefix(fieldSel, "metadata.name=")
	var out []*unstructured.Unstructured
	for k, u := range f.objs {
		if strings.HasPrefix(k, resource+"/") && u.GetName() == name && (ns == "" || u.GetNamespace() == ns) {
			out = append(out, u)
		}
	}
	return out, nil
}

func shootObj(tid, seed string) map[string]any {
	return map[string]any{
		"spec": map[string]any{"seedName": seed, "kubernetes": map[string]any{"version": "1.33.1"}},
		"status": map[string]any{"technicalID": tid, "advertisedAddresses": []any{
			map[string]any{"name": "internal", "url": "https://api.internal.example"},
			map[string]any{"name": "service-account-issuer", "url": "https://issuer.example"},
			map[string]any{"name": "external", "url": "https://api.bar.foo.example:443"},
		}},
	}
}

func ca() map[string]any { return map[string]any{"data": map[string]any{"ca.crt": "CA"}} }

// a resolver over a fake garden, registering in a map instead of kubewing's registry
func testResolver(t *testing.T) (*Resolver, *fakeGarden, map[string]*clientcmdapi.Config) {
	t.Helper()
	dir := t.TempDir()
	kc := filepath.Join(dir, "garden.yaml")
	if err := os.WriteFile(kc, []byte(`apiVersion: v1
kind: Config
current-context: other
clusters: [{name: v, cluster: {server: "https://garden.example"}}]
users: [{name: oidc, user: {exec: {command: kubectl, args: [oidc-login], apiVersion: client.authentication.k8s.io/v1}}}]
contexts:
- {name: virtual, context: {cluster: v, user: oidc, namespace: garden-x}}
- {name: other, context: {cluster: v, user: oidc}}
`), 0o600); err != nil {
		t.Fatal(err)
	}
	f := &fakeGarden{}
	reg := map[string]*clientcmdapi.Config{}
	keys := []string{}
	r := &Resolver{
		Config: Config{Gardens: []Garden{{Identity: "live", Kubeconfig: kc, Context: "virtual", AccessLevels: &AccessLevels{Seeds: "admin"}}}},
		Lookup: f,
		Register: func(key string, raw *clientcmdapi.Config) string {
			for i, k := range keys {
				if k == key {
					reg[key] = raw
					return "@" + string(rune('1'+i))
				}
			}
			keys = append(keys, key)
			reg[key] = raw
			return "@" + string(rune('0'+len(keys)))
		},
	}
	return r, f, reg
}

func TestResolveShoot(t *testing.T) {
	r, f, reg := testResolver(t)
	f.add(projects, "", "foo", map[string]any{"spec": map[string]any{"namespace": "garden-foo"}})
	f.add(shoots, "garden-foo", "bar", shootObj("shoot--foo--bar", "soil"))
	f.add("configmaps", "garden-foo", "bar.ca-cluster", ca())

	o, err := r.Resolve(context.Background(), Target{Garden: "live", Project: "foo", Shoot: "bar"})
	if err != nil {
		t.Fatal(err)
	}
	want := Opened{Cluster: "@2/live/shoot--foo--bar", Target: Target{Garden: "live", Project: "foo", Namespace: "garden-foo", Shoot: "bar"}}
	if !reflect.DeepEqual(o, want) {
		t.Errorf("Opened = %+v, want %+v", o, want)
	}
	// looked up through the garden's own cluster, its context renamed to the garden
	if f.calls[0] != "@1/live get projects.core.gardener.cloud /foo" {
		t.Errorf("calls: %v", f.calls)
	}
	g := reg["garden:live"]
	if g.CurrentContext != "live" || g.Contexts["live"].Cluster != "v" || g.Contexts["live"].Namespace != "" || len(g.Contexts) != 1 {
		t.Errorf("garden kubeconfig: %+v", g)
	}

	raw := reg["shoot:live/garden-foo/bar/"]
	if raw == nil {
		t.Fatalf("registered: %v", reg)
	}
	// round trip through YAML, as kubectl would read gardenctl's file
	b, err := clientcmd.Write(*raw)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, want := range []string{
		"current-context: live/shoot--foo--bar",
		"server: https://api.bar.foo.example:443",
		"name: live/shoot--foo--bar-internal",
		"command: kubectl-gardenlogin",
		"- get-client-certificate",
		"provideClusterInfo: true",
		"gardenClusterIdentity: live",
		"name: bar\n",
		"namespace: garden-foo",
		"certificate-authority-data: Q0E=",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("kubeconfig lacks %q:\n%s", want, s)
		}
	}
	if strings.Contains(s, "issuer.example") || strings.Contains(s, "access-level") {
		t.Errorf("kubeconfig:\n%s", s)
	}
}

func TestResolveShootByName(t *testing.T) {
	r, f, _ := testResolver(t)
	f.add(shoots, "garden-foo", "bar", shootObj("shoot--foo--bar", "soil"))
	f.add("configmaps", "garden-foo", "bar.ca-cluster", ca())
	o, err := r.Resolve(context.Background(), Target{Garden: "live", Shoot: "bar"})
	if err != nil || o.Target.Namespace != "garden-foo" || o.Target.Project != "foo" {
		t.Fatalf("%+v %v", o, err)
	}
	// in two projects: the choices
	f.add(shoots, "garden", "bar", shootObj("shoot--garden--bar", "soil"))
	_, err = r.Resolve(context.Background(), Target{Garden: "live", Shoot: "bar"})
	var amb *Ambiguous
	if !errors.As(err, &amb) || len(amb.Choices) != 2 || amb.Choices[0].Namespace != "garden" || amb.Choices[1].Namespace != "garden-foo" {
		t.Fatalf("ambiguous: %v", err)
	}
	if !strings.Contains(err.Error(), "garden, foo") {
		t.Errorf("message: %v", err)
	}
	if _, err := r.Resolve(context.Background(), Target{Garden: "live", Shoot: "nope"}); err == nil || !strings.Contains(err.Error(), "no shoot nope") {
		t.Errorf("missing: %v", err)
	}
}

func TestResolveControlPlane(t *testing.T) {
	r, f, reg := testResolver(t)
	f.add(shoots, "garden-foo", "bar", shootObj("shoot--foo--bar", "soil"))
	f.add(shoots, "garden", "soil-shoot", shootObj("shoot--garden--soil-shoot", "root"))
	f.add("configmaps", "garden", "soil-shoot.ca-cluster", ca())
	f.add(managedSeeds, "garden", "soil", map[string]any{"spec": map[string]any{"shoot": map[string]any{"name": "soil-shoot"}}})

	// a managed seed: its shoot's kubeconfig, named for the seed, in the shoot's namespace there
	o, err := r.Resolve(context.Background(), Target{Garden: "live", Namespace: "garden-foo", Shoot: "bar", ControlPlane: true})
	if err != nil {
		t.Fatal(err)
	}
	if o.Cluster != "@2/live/seed--soil" || o.Namespace != "shoot--foo--bar" || o.Target.Seed != "soil" {
		t.Errorf("%+v", o)
	}
	raw := reg["seed:live/soil"]
	if raw == nil || raw.CurrentContext != "live/seed--soil" {
		t.Fatalf("registered: %v", reg)
	}
	ext := raw.Clusters["live/seed--soil"].Extensions["client.authentication.k8s.io/exec"].(*execConfig)
	if ext.ShootRef != (shootRef{Namespace: "garden", Name: "soil-shoot"}) {
		t.Errorf("shoot ref: %+v", ext)
	}
	if args := raw.AuthInfos["garden--soil-shoot"].Exec.Args; !reflect.DeepEqual(args, []string{"get-client-certificate", "--access-level=admin"}) {
		t.Errorf("seeds' access level: %v", args)
	}

	// an unmanaged seed: its login secret's kubeconfig as it is, one context renamed
	f.add(shoots, "garden-foo", "baz", shootObj("shoot--foo--baz", "gke"))
	login := `apiVersion: v1
kind: Config
current-context: gke
clusters: [{name: gke, cluster: {server: "https://gke.example"}}]
users: [{name: gke, user: {exec: {command: gke-gcloud-auth-plugin, apiVersion: client.authentication.k8s.io/v1beta1}}}]
contexts: [{name: gke, context: {cluster: gke, user: gke}}, {name: unused, context: {cluster: gke, user: gke}}]
`
	f.add("secrets", "garden", "gke.oidc", map[string]any{"data": map[string]any{"kubeconfig": base64.StdEncoding.EncodeToString([]byte(login))}})
	o, err = r.Resolve(context.Background(), Target{Garden: "live", Namespace: "garden-foo", Shoot: "baz", ControlPlane: true})
	if err != nil {
		t.Fatal(err)
	}
	if o.Cluster != "@3/live/seed--gke" || o.Namespace != "shoot--foo--baz" {
		t.Errorf("%+v", o)
	}
	g := reg["seed:live/gke"]
	if len(g.Contexts) != 1 || g.Clusters["gke"].Server != "https://gke.example" || g.AuthInfos["gke"].Exec.Command != "gke-gcloud-auth-plugin" {
		t.Errorf("seed kubeconfig: %+v", g)
	}

	// not scheduled yet
	f.add(shoots, "garden-foo", "new", map[string]any{})
	if _, err := r.Resolve(context.Background(), Target{Garden: "live", Namespace: "garden-foo", Shoot: "new", ControlPlane: true}); err == nil || !strings.Contains(err.Error(), "isn't scheduled") {
		t.Errorf("unscheduled: %v", err)
	}
}

func TestResolveGardenAndProject(t *testing.T) {
	r, f, _ := testResolver(t)
	f.add(projects, "", "foo", map[string]any{"spec": map[string]any{"namespace": "garden-foo"}})
	o, err := r.Resolve(context.Background(), Target{Garden: "live"})
	if err != nil || o.Cluster != "@1/live" || o.Namespace != "" {
		t.Errorf("garden: %+v %v", o, err)
	}
	o, err = r.Resolve(context.Background(), Target{Garden: "live", Project: "foo"})
	if err != nil || o.Cluster != "@1/live" || o.Namespace != "garden-foo" {
		t.Errorf("project: %+v %v", o, err)
	}
	o, err = r.Resolve(context.Background(), Target{Garden: "live", Namespace: "garden-bar"})
	if err != nil || o.Namespace != "garden-bar" {
		t.Errorf("namespace: %+v %v", o, err)
	}
	if _, err := r.Resolve(context.Background(), Target{Garden: "nope"}); err == nil {
		t.Error("unknown garden")
	}
}

func TestResolveSeed(t *testing.T) {
	r, f, reg := testResolver(t)
	f.add(shoots, "garden", "soil-shoot", shootObj("shoot--garden--soil-shoot", "root"))
	f.add("configmaps", "garden", "soil-shoot.ca-cluster", ca())
	f.add(managedSeeds, "garden", "soil", map[string]any{"spec": map[string]any{"shoot": map[string]any{"name": "soil-shoot"}}})

	// a managed seed: its shoot's kubeconfig, all namespaces; a project's namespace is dropped
	o, err := r.Resolve(context.Background(), Target{Garden: "live", Namespace: "garden-foo", Seed: "soil"})
	if err != nil {
		t.Fatal(err)
	}
	if o.Cluster != "@2/live/seed--soil" || o.Namespace != "" || o.Target != (Target{Garden: "live", Seed: "soil"}) {
		t.Errorf("%+v", o)
	}
	if raw := reg["seed:live/soil"]; raw == nil || raw.AuthInfos["garden--soil-shoot"].Exec.Args[1] != "--access-level=admin" {
		t.Fatalf("registered: %v", reg)
	}
	// the seed and a control plane on it are one connection
	f.add(shoots, "garden-foo", "bar", shootObj("shoot--foo--bar", "soil"))
	cp, err := r.Resolve(context.Background(), Target{Garden: "live", Namespace: "garden-foo", Shoot: "bar", ControlPlane: true})
	if err != nil || cp.Cluster != o.Cluster || cp.Namespace != "shoot--foo--bar" {
		t.Errorf("control plane on it: %+v %v", cp, err)
	}

	// an unmanaged seed without a login secret
	if _, err := r.Resolve(context.Background(), Target{Garden: "live", Seed: "gke"}); err == nil || !strings.Contains(err.Error(), "no login secret") {
		t.Errorf("no login: %v", err)
	}
}

func TestShootOfNamespace(t *testing.T) {
	for ns, want := range map[string][2]string{"shoot--foo--bar": {"foo", "bar"}, "shoot--garden--a--b": {"garden", "a--b"}} {
		if p, s, ok := ShootOfNamespace(ns); !ok || p != want[0] || s != want[1] {
			t.Errorf("%s: %s %s %v", ns, p, s, ok)
		}
	}
	for _, ns := range []string{"kube-system", "shoot--foo", "shoot----bar", "garden-foo"} {
		if _, _, ok := ShootOfNamespace(ns); ok {
			t.Errorf("%s is a shoot's", ns)
		}
	}
}
