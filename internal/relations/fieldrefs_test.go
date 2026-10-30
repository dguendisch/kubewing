package relations

import (
	"fmt"
	"strings"
	"testing"

	sigsyaml "sigs.k8s.io/yaml"
)

func refsOf(t *testing.T, rs *Rules, text string) []FieldRef {
	t.Helper()
	root, err := ParseYAML(text)
	if err != nil {
		t.Fatal(err)
	}
	var obj map[string]any
	if err := sigsyaml.Unmarshal([]byte(text), &obj); err != nil {
		t.Fatal(err)
	}
	av, _ := obj["apiVersion"].(string)
	kind, _ := obj["kind"].(string)
	md, _ := obj["metadata"].(map[string]any)
	ns, _ := md["namespace"].(string)
	return rs.Match(root, GroupOf(av), kind, ns)
}

// show renders refs as "line rule apiVersion/Kind ns/name".
func show(refs []FieldRef) string {
	var b strings.Builder
	for _, r := range refs {
		fmt.Fprintf(&b, "%d %s %s/%s %s/%s\n", r.Line, r.Rule, r.APIVersion, r.Kind, r.Namespace, r.Name)
	}
	return b.String()
}

const podYAML = `apiVersion: v1
kind: Pod
metadata:
  name: web-0
  namespace: shop
  ownerReferences:
  - apiVersion: apps/v1
    kind: StatefulSet
    name: web
    uid: u1
spec:
  serviceAccountName: web
  nodeName: node-1
  imagePullSecrets:
  - name: registry
  containers:
  - name: app
    envFrom:
    - secretRef:
        name: app-env
    env:
    - name: PASSWORD
      valueFrom:
        secretKeyRef:
          name: db
          key: password
    - name: MODE
      valueFrom:
        configMapKeyRef:
          name: settings
          key: mode
  volumes:
  - name: certs
    secret:
      secretName: "certs"
  - name: cfg
    configMap:
      name: settings
  - name: data
    persistentVolumeClaim:
      claimName: data-web-0
  - name: bundle
    projected:
      sources:
      - secret:
          name: bundle
      - configMap:
          name: ca
  - name: csi
    csi:
      driver: x
      nodePublishSecretRef:
        name: csi-creds
`

func TestMatchPod(t *testing.T) {
	got := show(refsOf(t, DefaultRules, podYAML))
	want := `8 owner apps/v1/StatefulSet shop/web
11 pod-service-account v1/ServiceAccount shop/web
12 node-name v1/Node shop/node-1
14 pod-image-pull-secret v1/Secret shop/registry
19 pod-envfrom-secret v1/Secret shop/app-env
24 pod-env-secret v1/Secret shop/db
29 pod-env-configmap v1/ConfigMap shop/settings
34 pod-volume-secret v1/Secret shop/certs
37 pod-volume-configmap v1/ConfigMap shop/settings
40 pod-volume-pvc v1/PersistentVolumeClaim shop/data-web-0
45 pod-projected-secret v1/Secret shop/bundle
47 pod-projected-configmap v1/ConfigMap shop/ca
52 secret-refs v1/Secret shop/csi-creds
`
	if got != want {
		t.Errorf("got\n%swant\n%s", got, want)
	}
	// the quoted value is marked with its quotes
	for _, r := range refsOf(t, DefaultRules, podYAML) {
		if r.Name == "certs" && (r.Col != 19 || r.EndCol != 26) {
			t.Errorf("certs at col %d..%d", r.Col, r.EndCol)
		}
		if r.Name == "settings" && r.Line == 37 && (r.Start != 36 || r.End != 37) {
			t.Errorf("configmap volume field spans %d..%d", r.Start, r.End)
		}
	}
}

func TestMatchEmbeddedPodSpecs(t *testing.T) {
	cron := `apiVersion: batch/v1
kind: CronJob
metadata: {name: backup, namespace: ops}
spec:
  jobTemplate:
    spec:
      template:
        spec:
          volumes:
          - {name: creds, secret: {secretName: s3}}
          serviceAccountName: ""
`
	if got := show(refsOf(t, DefaultRules, cron)); got != "9 pod-volume-secret v1/Secret ops/s3\n" {
		t.Errorf("cron job: %s", got)
	}
	sts := `apiVersion: apps/v1
kind: StatefulSet
metadata: {name: db, namespace: shop}
spec:
  volumeClaimTemplates:
  - metadata: {name: data}
    spec: {storageClassName: fast}
`
	if got := show(refsOf(t, DefaultRules, sts)); got != "6 storage-class storage.k8s.io//StorageClass shop/fast\n" {
		t.Errorf("stateful set: %s", got)
	}
}

func TestMatchKindAndGroupFields(t *testing.T) {
	rb := `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: {name: admins}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin}
subjects:
- {kind: User, name: alice}
- {kind: ServiceAccount, name: ci, namespace: tools}
`
	want := "3 rbac-role rbac.authorization.k8s.io//ClusterRole /cluster-admin\n6 rbac-subject-sa v1/ServiceAccount tools/ci\n"
	if got := show(refsOf(t, DefaultRules, rb)); got != want {
		t.Errorf("binding:\n%s", got)
	}
	ev := `apiVersion: v1
kind: Event
metadata: {name: web.1, namespace: shop}
involvedObject: {apiVersion: v1, kind: Node, name: node-1}
`
	if got := show(refsOf(t, DefaultRules, ev)); got != "3 event-object v1/Node shop/node-1\n" {
		t.Errorf("event: %s", got)
	}
	shoot := `apiVersion: core.gardener.cloud/v1beta1
kind: Shoot
metadata: {name: dev, namespace: garden-p}
spec:
  cloudProfile: {kind: NamespacedCloudProfile, name: custom}
  credentialsBindingName: aws
  seedName: aws-eu1
status:
  seedName: aws-eu1
`
	want = "4 shoot-cloud-profile core.gardener.cloud//NamespacedCloudProfile garden-p/custom\n" +
		"5 shoot-credentials-binding security.gardener.cloud//CredentialsBinding garden-p/aws\n" +
		"6 shoot-seed core.gardener.cloud//Seed garden-p/aws-eu1\n" +
		"8 shoot-seed core.gardener.cloud//Seed garden-p/aws-eu1\n"
	if got := show(refsOf(t, DefaultRules, shoot)); got != want {
		t.Errorf("shoot:\n%s", got)
	}
}

func TestCompileUserRules(t *testing.T) {
	rs, errs := Compile(RulesFile{
		Rules: []Rule{
			{ID: "widget-config", Kinds: []string{"e2e.kubewing/Widget"}, Path: "spec.configs[*]", Name: "ref", Target: "ConfigMap"},
			// replaces the built-in one: service accounts as secrets (nonsense, but visible)
			{ID: "pod-service-account", Path: "**.serviceAccountName", Target: "Secret"},
			{ID: ""},
			{ID: "bad-path", Path: "spec..x", Target: "Secret"},
			{ID: "bad-target", Path: "spec.x", Target: "a/b/c/d"},
			{ID: "no-target", Path: "spec.x"},
			{ID: "widget-config", Path: "spec.x", Target: "Secret"},
		},
		Disable: []string{"node-name", "nope"},
	})
	var msgs []string
	for _, e := range errs {
		msgs = append(msgs, e.Error())
	}
	want := `rules[2]: id is required
rules[3] (bad-path): path: "spec..x": empty segment
rules[4] (bad-target): target "a/b/c/d": want Kind, group/Kind or group/version/Kind
rules[5] (no-target): target or kindField is required
rules[6]: id "widget-config" twice
disable: no built-in rule "nope"`
	if got := strings.Join(msgs, "\n"); got != want {
		t.Errorf("errors:\n%s", got)
	}
	w := `apiVersion: e2e.kubewing/v1
kind: Widget
metadata: {name: gizmo, namespace: shop}
spec:
  configs: [{ref: a}, {ref: b}]
  nodeName: n
  serviceAccountName: sa
`
	got := show(refsOf(t, rs, w))
	if got != "4 widget-config v1/ConfigMap shop/a\n4 widget-config v1/ConfigMap shop/b\n6 pod-service-account v1/Secret shop/sa\n" {
		t.Errorf("user rules:\n%s", got)
	}
}

func TestParsePath(t *testing.T) {
	for _, p := range []string{"a", "a.b", "a[*].b", `metadata.annotations["x.io/y"]`, "subjects[kind=ServiceAccount]", "**.x", "spec.**.backend.service", "*SecretRef"} {
		if _, err := parsePath(p); err != nil {
			t.Errorf("%s: %v", p, err)
		}
	}
	for _, p := range []string{"", ".a", "a.", "a..b", "a[", "a[x]", "a.**", `a["x]`} {
		if _, err := parsePath(p); err == nil {
			t.Errorf("%q: no error", p)
		}
	}
	// a quoted key matches literally, not as a glob
	rs, errs := Compile(RulesFile{Rules: []Rule{{ID: "ann", Path: `metadata.annotations["example.io/*"]`, Target: "Secret"}}, Disable: builtinIDs()})
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	got := show(refsOf(t, rs, "kind: X\nmetadata:\n  annotations:\n    example.io/*: a\n    example.io/b: b\n"))
	if got != "3 ann v1/Secret /a\n" {
		t.Errorf("quoted key: %s", got)
	}
}

func builtinIDs() []string {
	var ids []string
	for _, r := range Builtin() {
		ids = append(ids, r.ID)
	}
	return ids
}

func TestUnder(t *testing.T) {
	root, _ := ParseYAML(podYAML)
	refs := DefaultRules.Match(root, "", "Pod", "shop")
	names := func(line int) string {
		var out []string
		for _, r := range Under(refs, root, line) {
			out = append(out, r.Name)
		}
		return strings.Join(out, ",")
	}
	for line, want := range map[int]string{
		34: "certs",                                         // the value itself
		32: "certs",                                         // - name: certs (the volume)
		33: "certs",                                         // secret:
		31: "certs,settings,data-web-0,bundle,ca,csi-creds", // volumes:
		22: "db",                                            // - name: PASSWORD
		16: "app-env,db,settings",                           // - name: app (the container)
		3:  "",                                              // name: web-0
		0:  "",                                              // apiVersion
	} {
		if got := names(line); got != want {
			t.Errorf("line %d: %q, want %q", line, got, want)
		}
	}
}
