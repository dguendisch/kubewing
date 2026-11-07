package bridge

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/dguendisch/kubewing/internal/blame"
)

// The blame (b in the YAML view, ⌘B in the editor) names, beside each line
// of an object's YAML, the field manager that owns the field there. The
// sources strip managedFields (noise everywhere else), so they're read
// with a GET of their own and kept per row while the row's resourceVersion
// stays: the editor asks again as it's typed into, the viewer as the
// object changes.

// blameKeep bounds the managedFields a pane keeps (the rows blamed lately);
// blameFresh is how long they're reused for a row without a resourceVersion.
const (
	blameKeep  = 16
	blameFresh = 5 * time.Second
)

// BlameResult is the blame of a YAML text: each line with an owner (0-based),
// most recent owner first. Missing: the object has no managedFields (an
// API server that doesn't track them, a tape without).
type BlameResult struct {
	Lines   []blame.Line `json:"lines"`
	Missing bool         `json:"missing,omitempty"`
}

type blameCache struct {
	mu   sync.Mutex
	objs map[string]*blameObj
	seq  uint64
}

type blameObj struct {
	rv      string
	at      time.Time
	entries []blame.Entry
	used    uint64
}

func (c *blameCache) get(key, rv string, now time.Time) ([]blame.Entry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	o, ok := c.objs[key]
	if !ok || (rv == "" && now.Sub(o.at) > blameFresh) || (rv != "" && o.rv != rv) {
		return nil, false
	}
	c.seq++
	o.used = c.seq
	return o.entries, true
}

func (c *blameCache) put(key, rv string, now time.Time, e []blame.Entry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.objs == nil {
		c.objs = map[string]*blameObj{}
	}
	c.seq++
	c.objs[key] = &blameObj{rv: rv, at: now, entries: e, used: c.seq}
	if len(c.objs) > blameKeep {
		var oldest string
		for k, o := range c.objs {
			if oldest == "" || o.used < c.objs[oldest].used {
				oldest = k
			}
		}
		delete(c.objs, oldest)
	}
}

// Blame maps the lines of text (the row's YAML as the viewer or the
// editor shows it) to the field managers owning the fields on them. Text
// that doesn't parse (the editor mid-typing) is an error.
func (s *Service) Blame(paneID, key, text string) (BlameResult, error) {
	if s.opts.Actor == nil {
		return BlameResult{}, errors.New("blame is not available")
	}
	r, err := s.row(paneID, key)
	if err != nil {
		return BlameResult{}, err
	}
	now := s.opts.Clock.Now()
	rv := r.item.Object.GetResourceVersion()
	entries, ok := r.pane.blame.get(key, rv, now)
	if !ok {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		u, err := s.opts.Actor.GetManaged(ctx, r.cluster, r.res, r.namespace(), r.name())
		if err != nil {
			return BlameResult{}, err
		}
		if uid := r.item.Object.GetUID(); uid != "" && u.GetUID() != uid {
			return BlameResult{}, errors.New("recreated meanwhile")
		}
		if entries, err = blame.Entries(u.Object); err != nil {
			return BlameResult{}, err
		}
		r.pane.blame.put(key, rv, now, entries)
	}
	if len(entries) == 0 {
		return BlameResult{Lines: []blame.Line{}, Missing: true}, nil
	}
	lines, err := blame.Lines(text, entries)
	if err != nil {
		return BlameResult{}, err
	}
	return BlameResult{Lines: lines}, nil
}
