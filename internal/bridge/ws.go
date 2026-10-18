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

// API is the object served over WebSocket (app.App, the same object Wails
// binds); its exported methods are called by name via Dispatch. Close is
// used to stop panes opened over a connection when it goes away.
type API interface {
	Close(pane string) error
}

// Handler serves api over WebSocket.
func (h *Hub) Handler(api API) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"localhost:*", "127.0.0.1:*"}})
		if err != nil {
			return
		}
		c.SetReadLimit(1 << 20)
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		out := make(chan wsMessage, 256)
		h.mu.Lock()
		h.clients[c] = out
		h.mu.Unlock()
		// panes opened over this connection are closed when it goes away
		opened := map[string]bool{}
		defer func() {
			h.mu.Lock()
			delete(h.clients, c)
			h.mu.Unlock()
			for id := range opened {
				_ = api.Close(id)
			}
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
		for {
			var req wsRequest
			if err := wsjson.Read(ctx, c, &req); err != nil {
				return
			}
			res, err := Dispatch(api, req.Method, req.Args)
			if or, ok := res.(OpenResult); ok && err == nil {
				opened[or.Pane] = true
			}
			if req.Method == "Close" && len(req.Args) > 0 {
				var id string
				if json.Unmarshal(req.Args[0], &id) == nil {
					delete(opened, id)
				}
			}
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

// Dispatch calls api's exported method by name, decoding each JSON arg into
// the parameter's type. Methods return (T, error), error, T or nothing.
func Dispatch(api any, method string, args []json.RawMessage) (any, error) {
	m := reflect.ValueOf(api).MethodByName(method)
	if !m.IsValid() || !token.IsExported(method) {
		return nil, fmt.Errorf("unknown method %q", method)
	}
	t := m.Type()
	if t.IsVariadic() || len(args) != t.NumIn() {
		return nil, fmt.Errorf("%s: want %d arguments, got %d", method, t.NumIn(), len(args))
	}
	in := make([]reflect.Value, len(args))
	for i, raw := range args {
		v := reflect.New(t.In(i))
		if err := json.Unmarshal(raw, v.Interface()); err != nil {
			return nil, fmt.Errorf("%s: argument %d: %w", method, i, err)
		}
		in[i] = v.Elem()
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
