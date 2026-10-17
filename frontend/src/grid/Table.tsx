import { useEffect, useReducer, useRef } from "react";
import {
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type DrawCellCallback,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Rectangle,
  type Theme,
  CompactSelection,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { bridge, paneData } from "../store/store";
import { layout, withAlpha, type ColorToken } from "./cells";
import { rowAt, type PaneData } from "./rowcache";

/** Reads a theme token (CSS variable) so the canvas uses the same palette as the DOM. */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
}

function gridTheme(): Partial<Theme> {
  return {
    bgCell: token("bg"),
    bgCellMedium: token("bg-elev"),
    bgHeader: token("bg-elev"),
    bgHeaderHasFocus: token("bg-hover"),
    bgHeaderHovered: token("bg-hover"),
    textDark: token("fg"),
    textMedium: token("fg-muted"),
    textLight: token("fg-muted"),
    textHeader: token("fg-muted"),
    borderColor: token("border"),
    horizontalBorderColor: "transparent",
    accentColor: token("accent"),
    accentLight: withAlpha(token("accent"), 0.18), // not color-mix(): Glide can't blend it, see withAlpha
    fontFamily: getComputedStyle(document.body).fontFamily,
    baseFontStyle: "12px",
    headerFontStyle: "600 11px",
    cellHorizontalPadding: 8,
  };
}

const colorVar: Record<ColorToken, string> = {
  fg: "fg",
  fgMuted: "fg-muted",
  added: "added",
  deleted: "deleted",
  changed: "changed",
};

interface Props {
  serverId: string;
  selected: number;
  focused: boolean;
  onSelect: (row: number) => void;
  onActivate: () => void;
}

/**
 * Live table. Data flows bridge → paneData → updateCells (no React render).
 * Only visible rows (+ overscan) are requested from Go.
 */
export function Table({ serverId, selected, focused, onSelect, onActivate }: Props) {
  const ref = useRef<DataEditorRef>(null);
  const data = useRef<PaneData>(paneData.get(serverId));
  const theme = useRef<Partial<Theme>>(gridTheme());
  const colors = useRef<Record<string, string>>({});
  const [, force] = useReducer((x: number) => x + 1, 0);

  if (Object.keys(colors.current).length === 0) {
    for (const v of Object.values(colorVar)) colors.current[v] = token(v);
  }

  // subscribe to frames; repaint only damaged cells, re-render only on shape changes
  useEffect(() => {
    data.current = paneData.get(serverId);
    force();
    return paneData.subscribe(serverId, (d) => {
      const prev = data.current;
      data.current = d;
      if (prev.columns !== d.columns || prev.total !== d.total || prev.status !== d.status) {
        force();
        return;
      }
      const cells: { cell: Item }[] = [];
      for (let i = 0; i < d.order.length; i++) {
        const key = d.order[i]!;
        const row = d.offset + i;
        if (prev.order[row - prev.offset] !== key || prev.rows.get(key) !== d.rows.get(key)) {
          for (let c = 0; c < d.columns.length; c++) cells.push({ cell: [c, row] });
        }
      }
      if (cells.length) ref.current?.updateCells(cells);
    });
  }, [serverId]);

  // age columns are rendered client-side; repaint them once per second
  useEffect(() => {
    const ageCols = data.current.columns.flatMap((c, i) => (c.type === "age" ? [i] : []));
    if (!ageCols.length) return;
    const id = setInterval(() => {
      const d = data.current;
      ref.current?.updateCells(d.order.flatMap((_, i) => ageCols.map((c) => ({ cell: [c, d.offset + i] as Item }))));
    }, 1000);
    return () => clearInterval(id);
  });

  useEffect(() => {
    if (focused) ref.current?.scrollTo(0, selected, "vertical");
  }, [selected, focused]);

  const d = data.current;
  const columns: GridColumn[] = d.columns.map((c) => ({
    title: c.name,
    id: c.name,
    grow: c.name === "NAME" ? 1 : undefined,
    width: c.name === "NAME" ? 260 : c.type === "age" ? 70 : 120,
  }));

  const getCellContent = ([col, row]: Item): GridCell => {
    const l = layout(rowAt(data.current, row), col, data.current.columns[col], Date.now());
    return { kind: GridCellKind.Text, data: l.text, displayData: l.text, allowOverlay: false, readonly: true };
  };

  const drawCell: DrawCellCallback = (args, drawContent) => {
    const { ctx, rect, col, row, theme: t } = args;
    const l = layout(rowAt(data.current, row), col, data.current.columns[col], Date.now());
    if (l.tint) {
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = colors.current[l.tint]!;
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.restore();
    }
    if (l.hiddenMarker) {
      ctx.fillStyle = colors.current["hidden"] ?? token("hidden");
      ctx.fillRect(rect.x, rect.y + 3, 3, rect.height - 6);
    }
    ctx.fillStyle = colors.current[colorVar[l.color]]!;
    ctx.font = `${t.baseFontStyle} ${t.fontFamily}`;
    ctx.textBaseline = "middle";
    const pad = t.cellHorizontalPadding;
    const y = rect.y + rect.height / 2;
    const w = ctx.measureText(l.text).width;
    const x = l.align === "right" ? rect.x + rect.width - pad - w : rect.x + pad;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.fillText(l.text, x, y);
    if (l.strike) ctx.fillRect(x, y, w, 1);
    ctx.restore();
    void drawContent;
  };

  const onVisible = (r: Rectangle) => {
    const overscan = 30;
    const offset = Math.max(0, r.y - overscan);
    // pane may close while the request is in flight
    bridge().setViewport(serverId, offset, r.height + 2 * overscan).catch(() => {});
  };

  const selection: GridSelection = {
    columns: CompactSelection.empty(),
    rows: d.total ? CompactSelection.fromSingleSelection(Math.min(selected, d.total - 1)) : CompactSelection.empty(),
  };

  return (
    <DataEditor
      ref={ref}
      width="100%"
      height="100%"
      columns={columns}
      rows={d.total}
      rowHeight={22}
      headerHeight={24}
      getCellContent={getCellContent}
      drawCell={drawCell}
      theme={theme.current}
      onVisibleRegionChanged={onVisible}
      smoothScrollY
      rowSelect="single"
      rowMarkers="none"
      gridSelection={selection}
      onGridSelectionChange={(s) => {
        const r = s.current?.cell[1] ?? s.rows.first();
        if (r !== undefined) onSelect(r);
      }}
      onCellActivated={onActivate}
      keybindings={{ search: false, selectAll: false, copy: true, downFill: false, rightFill: false, clear: false }}
      getCellsForSelection
    />
  );
}
