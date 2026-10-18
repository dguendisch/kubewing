package app

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/dguendisch/kubewing/internal/bridge"
	"github.com/dguendisch/kubewing/internal/source"
	"github.com/dguendisch/kubewing/internal/tape"
)

func newTestApp() *App {
	svc := bridge.New(source.NewRegistry(&tape.Opener{Tapes: map[string]*tape.Tape{}}), bridge.NewHub(), bridge.Options{})
	a := New(svc)
	a.ContextsFn = func() (bridge.ContextList, error) {
		return bridge.ContextList{Contexts: []string{"c"}, Current: "c"}, nil
	}
	return a
}

// Every method Wails binds must also be callable over the WebSocket
// transport: args decode into the parameter types and the call goes through.
func TestEveryMethodDispatches(t *testing.T) {
	a := newTestApp()
	typ := reflect.TypeOf(a)
	for i := range typ.NumMethod() {
		m := typ.Method(i)
		var args []json.RawMessage
		for j := 1; j < m.Type.NumIn(); j++ {
			b, err := json.Marshal(reflect.Zero(m.Type.In(j)).Interface())
			if err != nil {
				t.Fatal(err)
			}
			args = append(args, b)
		}
		_, err := bridge.Dispatch(a, m.Name, args)
		if err != nil && (strings.Contains(err.Error(), "unknown method") || strings.Contains(err.Error(), "argument")) {
			t.Errorf("%s: %v", m.Name, err)
		}
	}
}

func TestDispatchErrors(t *testing.T) {
	a := newTestApp()
	for _, tc := range []struct {
		method string
		args   []string
		want   string
	}{
		{"Nope", nil, "unknown method"},
		{"svc", nil, "unknown method"},
		{"Close", nil, "want 1 arguments, got 0"},
		{"Close", []string{`42`}, "argument 0"},
		{"SetViewport", []string{`"p1"`, `"x"`, `1`}, "argument 1"},
	} {
		var args []json.RawMessage
		for _, s := range tc.args {
			args = append(args, json.RawMessage(s))
		}
		_, err := bridge.Dispatch(a, tc.method, args)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s(%v): got %v, want %q", tc.method, tc.args, err, tc.want)
		}
	}
	res, err := bridge.Dispatch(a, "Contexts", nil)
	if err != nil || res.(bridge.ContextList).Current != "c" {
		t.Errorf("Contexts: %v, %v", res, err)
	}
}
