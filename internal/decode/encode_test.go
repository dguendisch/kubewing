package decode

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

func TestEdit(t *testing.T) {
	brValue := b64(br(t, manifests))
	tests := []struct {
		name    string
		value   string
		opts    Options
		steps   []string
		kind    string
		text    string
		compact bool
		refused string
		nothing bool
	}{
		{name: "base64 text", value: b64([]byte("hello")), steps: []string{Base64}, kind: Text, text: "hello"},
		{name: "secret password", value: b64([]byte("pw")), opts: Options{Encoded: true}, steps: []string{Base64}, kind: Text, text: "pw"},
		{name: "brotli yaml as it is", value: brValue, opts: Options{Hint: "data.yaml.br"}, steps: []string{Base64, Brotli}, kind: YAML, text: manifests},
		{name: "one-line json indented, compact", value: b64([]byte(`{"a":1}`)), steps: []string{Base64}, kind: JSON, text: "{\n  \"a\": 1\n}\n", compact: true},
		{name: "json on lines as it is", value: b64([]byte("{\n \"a\": 1\n}")), steps: []string{Base64}, kind: JSON, text: "{\n \"a\": 1\n}"},
		{name: "a yaml string without steps", value: "a: 1\nb: [x]\n", steps: []string{}, kind: YAML, text: "a: 1\nb: [x]\n"},
		{name: "pem as its text", value: b64([]byte("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n")), steps: []string{Base64}, kind: PEM, text: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"},
		{name: "plain text: nothing", value: "kube-system", nothing: true},
		{name: "binary refused", value: b64([]byte{0, 1, 2, 0xff}), opts: Options{Encoded: true}, refused: "binary"},
		{name: "jwt refused", value: jwt(`{"alg":"RS256"}`, `{"exp":1}`), refused: "JWT"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			e, err := Edit(tc.value, tc.opts)
			switch {
			case tc.nothing:
				if !errors.Is(err, ErrNothing) {
					t.Fatalf("want ErrNothing, got %v (%+v)", err, e)
				}
				return
			case tc.refused != "":
				if err == nil || !strings.Contains(err.Error(), tc.refused) {
					t.Fatalf("want %q refused, got %v", tc.refused, err)
				}
				return
			case err != nil:
				t.Fatal(err)
			}
			if strings.Join(e.Steps, ",") != strings.Join(tc.steps, ",") || e.Kind != tc.kind || e.Text != tc.text || e.Compact != tc.compact {
				t.Errorf("got %+v", e)
			}
		})
	}
}

func TestEncode(t *testing.T) {
	long := strings.Repeat("line of text ", 20)
	tests := []struct {
		name  string
		value string
		opts  Options
		text  string
		want  string // the encoded value; "" checks only that it decodes to text
	}{
		{name: "base64", value: b64([]byte("hello")), text: "bye", want: b64([]byte("bye"))},
		{name: "unpadded url alphabet kept", value: base64.RawURLEncoding.EncodeToString([]byte("a?b>c~~~d")), text: "x?y>z~~~~w", want: base64.RawURLEncoding.EncodeToString([]byte("x?y>z~~~~w"))},
		{name: "wrapping kept", value: wrap(b64([]byte(long)), 76), text: long + "more", want: wrap(b64([]byte(long+"more")), 76)},
		{name: "trailing newline kept", value: b64([]byte("hello")) + "\n", text: "bye", want: b64([]byte("bye")) + "\n"},
		{name: "secret password", value: b64([]byte("pw")), opts: Options{Encoded: true}, text: "new-pw", want: b64([]byte("new-pw"))},
		{name: "compact json compacted again", value: b64([]byte(`{"a":1}`)), text: "{\n  \"a\": 2,\n  \"b\": [1, 2]\n}\n", want: b64([]byte(`{"a":2,"b":[1,2]}`))},
		{name: "a yaml string without steps", value: "a: 1\n", text: "a: 2\n", want: "a: 2\n"},
		{name: "brotli", value: b64(br(t, manifests)), opts: Options{Hint: "data.yaml.br"}, text: strings.Replace(manifests, "name: svc", "name: svc2", 1)},
		{name: "gzip json", value: b64(gz(t, []byte("{\n\"a\": 1\n}"))), text: "{\n\"a\": 2\n}"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			e, err := Edit(tc.value, tc.opts)
			if err != nil {
				t.Fatal(err)
			}
			o := tc.opts
			o.Steps = e.Steps
			got, err := Encode(tc.value, o, tc.text)
			if err != nil {
				t.Fatal(err)
			}
			if tc.want != "" && got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
			back, err := Edit(got, o)
			if err != nil {
				t.Fatal(err)
			}
			want := tc.text
			if e.Compact {
				want = back.Text // indented again: compared by the value above
			}
			if back.Text != want {
				t.Errorf("decodes to %q, want %q", back.Text, want)
			}
		})
	}
}

func TestEncodeUnchangedKeepsTheValue(t *testing.T) {
	v := b64(br(t, manifests))
	e, err := Edit(v, Options{Hint: "data.yaml.br"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := Encode(v, Options{Steps: e.Steps}, e.Text)
	if err != nil || got != v {
		t.Fatalf("got %q, %v: want the value itself", got, err)
	}
}

func TestEncodeRefusesBrokenJSON(t *testing.T) {
	v := b64([]byte(`{"a":1}`))
	if _, err := Encode(v, Options{Steps: []string{Base64}}, "{\n  \"a\": \n"); err == nil || !strings.Contains(err.Error(), "JSON") {
		t.Fatalf("got %v", err)
	}
}
