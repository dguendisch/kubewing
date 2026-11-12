package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"go/token"
	"net/http"
	"reflect"
	"sync"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// The WebSocket transport mirrors the Wails bindings for the headless
// backend used by Playwright E2E tests. Protocol (JSON messages):
//
//	client → server  {"id": 1, "method": "Open", "args": [...]}
//	server → client  {"id": 1, "result": ...} | {"id": 1, "error": "..."}
//	server → client  {"event": "kw:frame", "data": ...}
type wsRequest struct {
	ID     int               `json:"id"`
	Method string            `json:"method"`
	Args   []json.RawMessage `json:"args"`
}

type wsMessage struct {
	ID     int    `json:"id,omitempty"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
	Event  string `json:"event,omitempty"`
	Data   any    `json:"data,omitempty"`
}

// Hub fans events out to connected WebSocket clients; it is an Emitter.
type Hub struct {
	mu      sync.Mutex
	clients map[*websocket.Conn]chan wsMessage
}

// NewHub creates a hub.
func NewHub() *Hub { return &Hub{clients: map[*websocket.Conn]chan wsMessage{}} }

// Emit implements Emitter.
func (h *Hub) Emit(event string, data any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, ch := range h.clients {
		select {
		case ch <- wsMessage{Event: event, Data: data}:
		default: // slow client; frames are idempotent snapshots of the window, the next one catches up
		}
	}
}

// Handler serves api (app.App, the object Wails binds; its exported methods
// are called by name via Dispatch) over WebSocket. Each connection is a
// window of svc's router, named by the URL's ?window= (default: the main
// window): stream events go to the connection showing the stream, and the
// streams a connection still owns close when it goes away (a log tail holds
// a pods watch: left running, it would outlive the page).
func (h *Hub) Handler(api any, svc *Service) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"localhost:*", "127.0.0.1:*"}})
		if err != nil {
			return
		}
		c.SetReadLimit(64 << 20) // a pane handed to another window carries its shell's transcript and its log backlog
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		name := r.URL.Query().Get("window")
		if name == "" {
			name = MainWindow
		}
		out := make(chan wsMessage, 256)
		h.mu.Lock()
		h.clients[c] = out
		h.mu.Unlock()
		// in order and complete (a shell's output is numbered): waits for the writer rather than dropping
		win := svc.Router().Register(name, func(event string, data any) {
			select {
			case out <- wsMessage{Event: event, Data: data}:
			case <-ctx.Done():
			}
		})
		defer func() {
			h.mu.Lock()
			delete(h.clients, c)
			h.mu.Unlock()
			cancel()
			svc.ConnectionClosed(win)
			c.CloseNow()
		}()
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case m := <-out:
					if err := wsjson.Write(ctx, c, m); err != nil {
						cancel()
						return
					}
				}
			}
		}()
		callCtx := WithWindow(ctx, name)
		for {
			var req wsRequest
			if err := wsjson.Read(ctx, c, &req); err != nil {
				return
			}
			res, err := DispatchContext(callCtx, api, req.Method, req.Args)
			m := wsMessage{ID: req.ID, Result: res}
			if err != nil {
				m = wsMessage{ID: req.ID, Error: err.Error()}
			}
			select {
			case out <- m:
			case <-ctx.Done():
				return
			}
		}
	})
}

var errorType = reflect.TypeFor[error]()

var contextType = reflect.TypeFor[context.Context]()

// Dispatch calls api's exported method by name, decoding each JSON arg into
// the parameter's type. Methods return (T, error), error, T or nothing.
func Dispatch(api any, method string, args []json.RawMessage) (any, error) {
	return DispatchContext(context.Background(), api, method, args)
}

// DispatchContext is Dispatch passing ctx to a method whose first parameter
// is a context.Context (as Wails does: it names the calling window).
func DispatchContext(ctx context.Context, api any, method string, args []json.RawMessage) (any, error) {
	m := reflect.ValueOf(api).MethodByName(method)
	if !m.IsValid() || !token.IsExported(method) {
		return nil, fmt.Errorf("unknown method %q", method)
	}
	t := m.Type()
	var in []reflect.Value
	first := 0
	if t.NumIn() > 0 && t.In(0) == contextType {
		in = append(in, reflect.ValueOf(&ctx).Elem())
		first = 1
	}
	if t.IsVariadic() || len(args) != t.NumIn()-first {
		return nil, fmt.Errorf("%s: want %d arguments, got %d", method, t.NumIn()-first, len(args))
	}
	for i, raw := range args {
		v := reflect.New(t.In(first + i))
		if err := json.Unmarshal(raw, v.Interface()); err != nil {
			return nil, fmt.Errorf("%s: argument %d: %w", method, i, err)
		}
		in = append(in, v.Elem())
	}
	var res any
	var err error
	for _, out := range m.Call(in) {
		if out.Type() == errorType {
			if !out.IsNil() {
				err = out.Interface().(error)
			}
			continue
		}
		res = out.Interface()
	}
	return res, err
}
