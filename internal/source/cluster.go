package source

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	kjson "k8s.io/apimachinery/pkg/util/json"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/discovery/cached/memory"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
)

// tableAccept asks for server-side Table output including full objects, so
// cells and objects always come from the same resourceVersion in one stream.
const tableAccept = "application/json;as=Table;v=v1;g=meta.k8s.io,application/json"

// Cluster is a connection to one kubeconfig context.
type Cluster struct {
	// Context is the context's name in its kubeconfig, Kubeconfig that
	// kubeconfig's reference ("" = kubewing's own; see SplitCluster).
	Context    string
	Kubeconfig string
	Config     *rest.Config
	http       *http.Client
	mapper     meta.RESTMapper
	// deferred is the discovery-backed mapper under mapper; Reset drops
	// both its mapping and the discovery cache.
	deferred *restmapper.DeferredDiscoveryRESTMapper
	disco    discovery.CachedDiscoveryInterface
}

// Contexts lists the contexts of a cluster's kubeconfig (see SplitCluster),
// its current one, and the namespace each context sets (only those that set one).
func Contexts(cluster string) (names []string, current string, namespaces map[string]string, err error) {
	cc, err := clientConfig(cluster)
	if err != nil {
		return nil, "", nil, err
	}
	raw, err := cc.RawConfig()
	if err != nil {
		return nil, "", nil, err
	}
	namespaces = map[string]string{}
	for n, c := range raw.Contexts {
		names = append(names, n)
		if c != nil && c.Namespace != "" {
			namespaces[n] = c.Namespace
		}
	}
	return names, raw.CurrentContext, namespaces, nil
}

// Connect builds a cluster connection (see SplitCluster; "" = the current context).
func Connect(cluster string) (*Cluster, error) {
	cc, err := clientConfig(cluster)
	if err != nil {
		return nil, err
	}
	cfg, err := cc.ClientConfig()
	if err != nil {
		return nil, err
	}
	ref, ctxName := SplitCluster(cluster)
	if ctxName == "" {
		raw, _ := cc.RawConfig()
		ctxName = raw.CurrentContext
	}
	cfg.QPS, cfg.Burst = 50, 100
	cfg.UserAgent = "kubewing"
	hc, err := rest.HTTPClientFor(cfg)
	if err != nil {
		return nil, err
	}
	c, err := newCluster(ctxName, cfg, hc)
	if err != nil {
		return nil, err
	}
	c.Kubeconfig = ref
	return c, nil
}

func newCluster(ctxName string, cfg *rest.Config, hc *http.Client) (*Cluster, error) {
	dc, err := discovery.NewDiscoveryClientForConfigAndClient(cfg, hc)
	if err != nil {
		return nil, err
	}
	cached := memory.NewMemCacheClient(dc)
	deferred := restmapper.NewDeferredDiscoveryRESTMapper(cached)
	mapper := restmapper.NewShortcutExpander(deferred, cached, nil)
	return &Cluster{Context: ctxName, Config: cfg, http: hc, mapper: mapper, deferred: deferred, disco: cached}, nil
}

// Resolved is a resolved resource.
type Resolved struct {
	GVR        schema.GroupVersionResource
	Kind       string
	Namespaced bool
	// Metadata asks for PartialObjectMetadata instead of full objects: cheap
	// watches where names suffice (namespaces, CRDs with megabyte schemas).
	Metadata bool
}

// Resolve maps "po", "pods", "deploy.apps", "Deployment" etc. to a GVR.
func (c *Cluster) Resolve(resource string) (Resolved, error) {
	gvr, err := c.resolve(resource)
	if err != nil {
		c.disco.Invalidate() // maybe a new CRD
		if gvr, err = c.resolve(resource); err != nil {
			return Resolved{}, err
		}
	}
	gvk, err := c.mapper.KindFor(gvr)
	if err != nil {
		return Resolved{}, err
	}
	m, err := c.mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return Resolved{}, err
	}
	return Resolved{GVR: gvr, Kind: gvk.Kind, Namespaced: m.Scope.Name() == meta.RESTScopeNameNamespace}, nil
}

func (c *Cluster) resolve(resource string) (schema.GroupVersionResource, error) {
	r := strings.ToLower(strings.TrimSpace(resource))
	gvr, gr := schema.ParseResourceArg(r)
	if gvr != nil {
		if g, err := c.mapper.ResourceFor(*gvr); err == nil {
			return g, nil
		}
	}
	return c.mapper.ResourceFor(gr.WithVersion(""))
}

func (c *Cluster) restClient(gv schema.GroupVersion) (*rest.RESTClient, error) {
	cfg := rest.CopyConfig(c.Config)
	cfg.GroupVersion = &gv
	if gv.Group == "" {
		cfg.APIPath = "/api"
	} else {
		cfg.APIPath = "/apis"
	}
	cfg.NegotiatedSerializer = rawSerializer{}
	return rest.RESTClientForConfigAndClient(cfg, c.http)
}

// Watch streams events for a source until ctx is done. It does an initial
// list (as a Relist event), then watches; on watch expiry it relists.
func (c *Cluster) Watch(ctx context.Context, res Resolved, namespace, labelSel, fieldSel string, out chan<- Event) {
	rc, err := c.restClient(res.GVR.GroupVersion())
	if err != nil {
		send(ctx, out, Event{Type: Error, Err: errText(err)})
		return
	}
	backoff := time.Second
	for ctx.Err() == nil {
		rv, err := c.list(ctx, rc, res, namespace, labelSel, fieldSel, out)
		if err != nil {
			send(ctx, out, Event{Type: Error, Err: errText(err)})
			sleep(ctx, backoff)
			backoff = min(backoff*2, 30*time.Second)
			continue
		}
		backoff = time.Second
		for ctx.Err() == nil {
			next, expired, err := c.watch(ctx, rc, res, namespace, labelSel, fieldSel, rv, out)
			if err != nil || expired {
				if err != nil && ctx.Err() == nil {
					send(ctx, out, Event{Type: Error, Err: errText(err)})
					sleep(ctx, backoff)
				}
				break // relist
			}
			rv = next
		}
	}
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

func send(ctx context.Context, out chan<- Event, ev Event) bool {
	select {
	case out <- ev:
		return true
	case <-ctx.Done():
		return false
	}
}

// errText is an error for the status line: its message, then (on more
// lines) what the API server actually answered when client-go only says
// "the server rejected the request for an unknown reason": a response that
// isn't a Status (a proxy's or webhook's page, a bare "field label not
// supported") ends up in the causes, which Error() leaves out.
func errText(err error) string {
	msg := err.Error()
	var st apierrors.APIStatus
	if !errors.As(err, &st) {
		return msg
	}
	s := st.Status()
	var more []string
	if s.Details != nil {
		for _, c := range s.Details.Causes {
			if t := strings.TrimSpace(c.Message); t != "" && !strings.Contains(msg, t) {
				more = append(more, t)
			}
		}
	}
	if s.Code != 0 && !strings.Contains(msg, fmt.Sprint(s.Code)) {
		more = append(more, fmt.Sprintf("HTTP %d %s", s.Code, s.Reason))
	}
	if len(more) == 0 {
		return msg
	}
	return msg + "\n" + strings.Join(more, "\n")
}

func (c *Cluster) request(rc *rest.RESTClient, res Resolved, namespace, labelSel, fieldSel string) *rest.Request {
	include := "Object"
	if res.Metadata {
		include = "Metadata"
	}
	req := rc.Get().Resource(res.GVR.Resource).SetHeader("Accept", tableAccept).
		Param("includeObject", include)
	if res.Namespaced && namespace != "" && namespace != "*" {
		req = req.Namespace(namespace)
	}
	if labelSel != "" {
		req = req.Param("labelSelector", labelSel)
	}
	if fieldSel != "" {
		req = req.Param("fieldSelector", fieldSel)
	}
	return req
}

func (c *Cluster) list(ctx context.Context, rc *rest.RESTClient, res Resolved, ns, ls, fs string, out chan<- Event) (string, error) {
	var items []Item
	var cols []metav1.TableColumnDefinition
	var rv, cont string
	for {
		req := c.request(rc, res, ns, ls, fs).Param("limit", "500")
		if cont != "" {
			req = req.Param("continue", cont)
		}
		body, err := req.DoRaw(ctx)
		if err != nil {
			return "", err
		}
		t, err := decodeTableOrList(body)
		if err != nil {
			return "", err
		}
		if cols == nil {
			cols = t.columns
		}
		items = append(items, t.items...)
		rv, cont = t.rv, t.cont
		if cont == "" {
			break
		}
	}
	if !send(ctx, out, Event{Type: Relist, Items: items, Columns: cols}) {
		return "", ctx.Err()
	}
	return rv, nil
}

func (c *Cluster) watch(ctx context.Context, rc *rest.RESTClient, res Resolved, ns, ls, fs, rv string, out chan<- Event) (string, bool, error) {
	req := c.request(rc, res, ns, ls, fs).Param("watch", "true").Param("resourceVersion", rv).
		Param("allowWatchBookmarks", "true").Param("timeoutSeconds", "300")
	stream, err := req.Stream(ctx)
	if err != nil {
		return rv, false, err
	}
	defer stream.Close()
	dec := json.NewDecoder(stream)
	for {
		var we struct {
			Type   string          `json:"type"`
			Object json.RawMessage `json:"object"`
		}
		if err := dec.Decode(&we); err != nil {
			if ctx.Err() != nil {
				return rv, false, nil
			}
			return rv, false, nil // server closed (timeout); resume from rv
		}
		switch we.Type {
		case "ERROR":
			var st metav1.Status
			_ = json.Unmarshal(we.Object, &st)
			if st.Code == http.StatusGone {
				return rv, true, nil
			}
			return rv, false, fmt.Errorf("watch: %s", st.Message)
		case "BOOKMARK":
			if r := bookmarkRV(we.Object); r != "" {
				rv = r
			}
			continue
		}
		t, err := decodeTableOrList(we.Object)
		if err != nil {
			return rv, false, err
		}
		for _, it := range t.items {
			if r := it.Object.GetResourceVersion(); r != "" {
				rv = r
			}
			typ := map[string]EventType{"ADDED": Added, "MODIFIED": Modified, "DELETED": Deleted}[we.Type]
			if typ == "" {
				continue
			}
			if !send(ctx, out, Event{Type: typ, Item: it}) {
				return rv, false, nil
			}
		}
	}
}

func bookmarkRV(raw json.RawMessage) string {
	var o struct {
		Metadata struct {
			ResourceVersion string `json:"resourceVersion"`
		} `json:"metadata"`
		Rows []struct {
			Object struct {
				Metadata struct {
					ResourceVersion string `json:"resourceVersion"`
				} `json:"metadata"`
			} `json:"object"`
		} `json:"rows"`
	}
	_ = json.Unmarshal(raw, &o)
	if len(o.Rows) > 0 && o.Rows[0].Object.Metadata.ResourceVersion != "" {
		return o.Rows[0].Object.Metadata.ResourceVersion
	}
	return o.Metadata.ResourceVersion
}

type decoded struct {
	columns []metav1.TableColumnDefinition
	items   []Item
	rv      string
	cont    string
}

// decodeTableOrList accepts a meta.k8s.io Table (preferred) or, for
// resources without Table support, a plain list or single object. Objects
// keep whole numbers as int64 (as client-go's unstructured decoding does,
// and as tapes from YAML have them), not encoding/json's float64.
func decodeTableOrList(body []byte) (decoded, error) {
	var head struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(body, &head); err != nil {
		return decoded{}, err
	}
	if head.Kind == "Table" {
		var t metav1.Table
		if err := json.Unmarshal(body, &t); err != nil {
			return decoded{}, err
		}
		d := decoded{columns: t.ColumnDefinitions, rv: t.ResourceVersion, cont: t.Continue}
		if d.columns == nil {
			d.columns = []metav1.TableColumnDefinition{}
		}
		for _, r := range t.Rows {
			u := &unstructured.Unstructured{}
			if err := kjson.Unmarshal(r.Object.Raw, &u.Object); err != nil {
				return decoded{}, err
			}
			StripManagedFields(u)
			d.items = append(d.items, Item{Object: u, Cells: r.Cells})
		}
		return d, nil
	}
	u := &unstructured.Unstructured{}
	if err := kjson.Unmarshal(body, &u.Object); err != nil {
		return decoded{}, err
	}
	if u.IsList() {
		l, err := u.ToList()
		if err != nil {
			return decoded{}, err
		}
		d := decoded{rv: l.GetResourceVersion(), cont: l.GetContinue()}
		for i := range l.Items {
			StripManagedFields(&l.Items[i])
			d.items = append(d.items, Item{Object: &l.Items[i]})
		}
		return d, nil
	}
	StripManagedFields(u)
	return decoded{items: []Item{{Object: u}}}, nil
}
