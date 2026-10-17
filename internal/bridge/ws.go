package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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

// Handler serves the bridge for svc over WebSocket.
func (h *Hub) Handler(svc *Service) http.Handler {
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
				_ = svc.Close(id)
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
			res, err := Dispatch(svc, req.Method, req.Args)
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

// Dispatch invokes a Service method by name with JSON args.
func Dispatch(svc *Service, method string, args []json.RawMessage) (any, error) {
	if method == "Contexts" {
		if svc.Contexts == nil {
			return ContextList{}, nil
		}
		return svc.Contexts()
	}
	str := func(i int) (string, error) {
		var s string
		if i >= len(args) {
			return "", fmt.Errorf("%s: missing argument %d", method, i)
		}
		return s, json.Unmarshal(args[i], &s)
	}
	num := func(i int) (int, error) {
		var n int
		if i >= len(args) {
			return 0, fmt.Errorf("%s: missing argument %d", method, i)
		}
		return n, json.Unmarshal(args[i], &n)
	}
	switch method {
	case "Open":
		y, err := str(0)
		if err != nil {
			return nil, err
		}
		return svc.Open(y)
	case "Update":
		id, err := str(0)
		if err != nil {
			return nil, err
		}
		y, err := str(1)
		if err != nil {
			return nil, err
		}
		return nil, svc.Update(id, y)
	case "SetViewport":
		id, err := str(0)
		if err != nil {
			return nil, err
		}
		off, err := num(1)
		if err != nil {
			return nil, err
		}
		lim, err := num(2)
		if err != nil {
			return nil, err
		}
		return nil, svc.SetViewport(id, off, lim)
	case "Resync":
		id, err := str(0)
		if err != nil {
			return nil, err
		}
		return nil, svc.Resync(id)
	case "Object":
		id, err := str(0)
		if err != nil {
			return nil, err
		}
		k, err := str(1)
		if err != nil {
			return nil, err
		}
		return svc.Object(id, k)
	case "Close":
		id, err := str(0)
		if err != nil {
			return nil, err
		}
		return nil, svc.Close(id)
	case "Catalog":
		ctx, err := str(0)
		if err != nil {
			return nil, err
		}
		return svc.Catalog(ctx), nil
	}
	return nil, fmt.Errorf("unknown method %q", method)
}
