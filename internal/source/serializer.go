package source

import (
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/serializer"
	"k8s.io/apimachinery/pkg/runtime/serializer/json"
)

// rawSerializer satisfies rest.RESTClient; kubewing decodes bodies itself.
type rawSerializer struct{}

var rawScheme = runtime.NewScheme()

func (rawSerializer) SupportedMediaTypes() []runtime.SerializerInfo {
	s := json.NewSerializerWithOptions(json.DefaultMetaFactory, rawScheme, rawScheme, json.SerializerOptions{})
	return []runtime.SerializerInfo{{
		MediaType: "application/json", MediaTypeType: "application", MediaTypeSubType: "json",
		EncodesAsText: true, Serializer: s,
		StreamSerializer: &runtime.StreamSerializerInfo{EncodesAsText: true, Serializer: s, Framer: json.Framer},
	}}
}

func (s rawSerializer) EncoderForVersion(e runtime.Encoder, _ runtime.GroupVersioner) runtime.Encoder {
	return e
}

func (s rawSerializer) DecoderToVersion(d runtime.Decoder, _ runtime.GroupVersioner) runtime.Decoder {
	return d
}

var _ runtime.NegotiatedSerializer = rawSerializer{}
var _ = serializer.CodecFactory{}
