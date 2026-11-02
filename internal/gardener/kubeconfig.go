package gardener

import (
	"fmt"
	"net/url"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// Address is one of a shoot's advertised API server addresses.
type Address struct {
	Name string // external, internal, unmanaged
	URL  string
}

// shootKubeconfig is the kubeconfig gardenctl writes for a shoot: every
// usable address a context named name (the first) or name-<address>, all
// authenticated by gardenlogin (kubectl-gardenlogin get-client-certificate),
// which finds the shoot by the cluster extension: its namespace and name
// and the garden's identity. No namespace: kubewing starts in all of them.
func shootKubeconfig(name, namespace, shoot, gardenIdentity, accessLevel string, addrs []Address, ca []byte) (*clientcmdapi.Config, error) {
	ext := &execConfig{ShootRef: shootRef{Namespace: namespace, Name: shoot}, GardenClusterIdentity: gardenIdentity}
	args := []string{"get-client-certificate"}
	if accessLevel != "" {
		args = append(args, "--access-level="+accessLevel)
	}
	user := namespace + "--" + shoot
	c := clientcmdapi.NewConfig()
	c.AuthInfos[user] = &clientcmdapi.AuthInfo{Exec: &clientcmdapi.ExecConfig{
		Command:            "kubectl-gardenlogin",
		Args:               args,
		APIVersion:         "client.authentication.k8s.io/v1",
		InstallHint:        "Follow the instructions on https://github.com/gardener/gardenlogin#installation to install gardenlogin",
		ProvideClusterInfo: true,
		// gardenlogin itself needs no stdin, but the garden's kubeconfig may (kubelogin)
		InteractiveMode: clientcmdapi.IfAvailableExecInteractiveMode,
	}}
	for _, a := range addrs {
		if a.Name != "external" && a.Name != "internal" && a.Name != "unmanaged" {
			continue
		}
		u, err := url.Parse(a.URL)
		if err != nil || u.Host == "" {
			return nil, fmt.Errorf("shoot %s/%s: address %s: %q is no URL", namespace, shoot, a.Name, a.URL)
		}
		ctx := name
		if c.CurrentContext == "" {
			c.CurrentContext = name
		} else {
			ctx = name + "-" + a.Name
		}
		cl := clientcmdapi.NewCluster()
		cl.Server = "https://" + u.Host
		cl.CertificateAuthorityData = ca
		cl.Extensions["client.authentication.k8s.io/exec"] = ext
		c.Clusters[ctx] = cl
		c.Contexts[ctx] = &clientcmdapi.Context{Cluster: ctx, AuthInfo: user}
	}
	if c.CurrentContext == "" {
		return nil, fmt.Errorf("shoot %s/%s has no API server address yet (status.advertisedAddresses)", namespace, shoot)
	}
	return c, nil
}

// execConfig is the cluster extension gardenlogin reads (its
// ExecCredential's spec.cluster.config).
type execConfig struct {
	ShootRef              shootRef `json:"shootRef"`
	GardenClusterIdentity string   `json:"gardenClusterIdentity"`
}

type shootRef struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

func (e *execConfig) GetObjectKind() schema.ObjectKind { return schema.EmptyObjectKind }

func (e *execConfig) DeepCopyObject() runtime.Object { c := *e; return &c }

// single is raw reduced to one context (from, "" = the current one),
// renamed to: kubewing addresses and matches safety rules by that name.
func single(raw *clientcmdapi.Config, from, to string) (*clientcmdapi.Config, error) {
	if from == "" {
		from = raw.CurrentContext
	}
	ctx, ok := raw.Contexts[from]
	if !ok || ctx == nil {
		if from == "" {
			return nil, fmt.Errorf("no current context")
		}
		return nil, fmt.Errorf("no context %q", from)
	}
	out := clientcmdapi.NewConfig()
	c := ctx.DeepCopy()
	c.Namespace = ""
	out.Contexts[to] = c
	out.CurrentContext = to
	if cl, ok := raw.Clusters[ctx.Cluster]; ok && cl != nil {
		out.Clusters[ctx.Cluster] = cl.DeepCopy()
	}
	if u, ok := raw.AuthInfos[ctx.AuthInfo]; ok && u != nil {
		out.AuthInfos[ctx.AuthInfo] = u.DeepCopy()
	}
	return out, nil
}
