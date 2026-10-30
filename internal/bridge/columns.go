package bridge

import (
	"fmt"

	"github.com/dguendisch/kubewing/internal/config"
	"github.com/dguendisch/kubewing/internal/pipeline"
	"github.com/dguendisch/kubewing/internal/view"
)

// ColumnsEvent is emitted with all types' column settings
// (map[string]config.TypeView) whenever one changes.
const ColumnsEvent = "kw:columns"

// ColumnChoices lists a pane's columns for the column dialog: the shown
// ones in order, then the server columns not shown (-o wide ones too), and
// which ones the server shows by default.
func (s *Service) ColumnChoices(paneID string) (view.ColumnChoices, error) {
	pn, err := s.pane(paneID)
	if err != nil {
		return view.ColumnChoices{}, err
	}
	pn.mu.Lock()
	defer pn.mu.Unlock()
	return pn.view.ColumnChoices(), nil
}

// ColumnConfigs returns every resource type's column settings.
func (s *Service) ColumnConfigs() map[string]config.TypeView { return s.opts.Columns.All() }

// SetTypeColumns sets a resource type's shown columns (nil = the server's
// defaults): saved, and applied to its open panes (except those opened
// with their own columns). An invalid column is refused before anything
// changes.
func (s *Service) SetTypeColumns(typ string, cols []pipeline.Column) error {
	r := pipeline.Render{Columns: cols}
	if err := (&pipeline.Pipeline{Source: pipeline.Source{Resource: typ}, Render: r}).Validate(); err != nil {
		return err
	}
	panes := s.typePanes(typ)
	// compile on one pane first: a bad expression changes nothing
	if len(panes) > 0 {
		pn := panes[0]
		pn.mu.Lock()
		err := pn.view.SetRender(r)
		if err == nil {
			pn.p.Render = r
		}
		pn.mu.Unlock()
		if err != nil {
			return err
		}
	}
	if err := s.opts.Columns.SetColumns(typ, cols); err != nil {
		return fmt.Errorf("save %s: %w", config.ColumnsFile, err)
	}
	for i, pn := range panes {
		if i > 0 {
			pn.mu.Lock()
			if pn.view.SetRender(r) == nil {
				pn.p.Render = r
			}
			pn.mu.Unlock()
		}
		s.syncMetrics(pn)
		pn.poke()
	}
	s.emit.Emit(ColumnsEvent, s.opts.Columns.All())
	return nil
}

// SetTypeMetrics turns a group of a type's metric columns ("usage",
// "alloc") on or off, as columns (see SetTypeColumns), and saves where they
// were (nil = right after NAME): turned on again, they go back there. Both
// are sent with ColumnsEvent at once.
func (s *Service) SetTypeMetrics(typ, group string, cols []pipeline.Column, place *config.MetricsPlace) error {
	if group != config.GroupUsage && group != config.GroupAlloc {
		return fmt.Errorf("unknown metric column group %q", group)
	}
	prev := s.opts.Columns.Get(typ).Place(group)
	if err := s.opts.Columns.SetMetrics(typ, group, place); err != nil {
		return fmt.Errorf("save %s: %w", config.ColumnsFile, err)
	}
	if err := s.SetTypeColumns(typ, cols); err != nil {
		_ = s.opts.Columns.SetMetrics(typ, group, prev)
		return err
	}
	return nil
}

// SetColumnWidths sets a resource type's dragged column widths by column
// name (nil = the defaults), saved and sent to all clients.
func (s *Service) SetColumnWidths(typ string, widths map[string]int) error {
	if err := s.opts.Columns.SetWidths(typ, widths); err != nil {
		return fmt.Errorf("save %s: %w", config.ColumnsFile, err)
	}
	s.emit.Emit(ColumnsEvent, s.opts.Columns.All())
	return nil
}

// typePanes are the open panes of a type that follow its column settings.
func (s *Service) typePanes(typ string) []*pane {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*pane
	for _, pn := range s.panes {
		if pn.typ == typ && !pn.explicit {
			out = append(out, pn)
		}
	}
	return out
}
