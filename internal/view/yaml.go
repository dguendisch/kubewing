package view

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/yaml"
)

func toYAML(o *unstructured.Unstructured) string {
	if o == nil {
		return ""
	}
	b, err := yaml.Marshal(o.Object)
	if err != nil {
		return "# " + err.Error()
	}
	return string(b)
}
