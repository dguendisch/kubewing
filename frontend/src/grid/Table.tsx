import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type DrawCellCallback,
  type DrawHeaderCallback,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Rectangle,
  type Theme,
  CompactSelection,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { rowLocators } from "../actions/anchor";
import { useConfig } from "../store/config";
import { bridge, paneData, useColumns } from "../store/store";
import { grepRanges, layout, withAlpha, type ColorToken, type Range } from "./cells";
import { parseGrep } from "../components/grep";
import { rowAt, type PaneData } from "./rowcache";
import type { RowData } from "../transport/types";

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
  /** The pane's applied grep stage: its terms are highlighted in the cells. */
  grep: string;
  selected: number;
  focused: boolean;
  /** Resource type (pods, deployments.apps): its dragged column widths apply, and a drag saves them. */
  type?: string;
  onSelect: (row: number) => void;
  onActivate: () => void;
  /** Right-click on a row: select it and open its context menu at (x, y) in the viewport. */
  onContextMenu?: (row: number, x: number, y: number) => void;
  /** Right-click on the header. */
  onHeaderMenu?: () => void;
  /** A header dragged to another column's place (shown column indices). */
  onColumnMoved?: (from: number, to: number) => void;
  /** The sorted column, if any (PaneSpec.sort): its header shows the direction. */
  sort?: { column: string; desc: boolean };
  /** A click on a header (not its resize edge): sort by that column. */
  onSort?: (column: string) => void;
}

/** How long after the last resize step the widths are saved (a drag fires one per mouse move). */
const saveWidthsAfter = 300;

/**
 * Live table. Data flows bridge → paneData → updateCells (no React render).
 * Only visible rows (+ overscan) are requested from Go.
 */
export function Table({ serverId, grep, selected, focused, type, onSelect, onActivate, onContextMenu, onHeaderMenu, onColumnMoved, sort, onSort }: Props) {
  const ref = useRef<DataEditorRef>(null);
  const data = useRef<PaneData>(paneData.get(serverId));
  const [, force] = useReducer((x: number) => x + 1, 0);
  // the canvas can't use CSS variables: re-read the tokens whenever the theme changes
  const themeGen = useConfig((s) => s.themeGen);
  const { theme, colors } = useMemo(() => {
    void themeGen;
    const colors: Record<string, string> = {};
    for (const v of [...Object.values(colorVar), "hidden", "match"]) colors[v] = token(v);
    return { theme: gridTheme(), colors };
  }, [themeGen]);

  // grep highlights: ranges per row, cached by RowData (a new frame brings new objects for changed rows)
  const terms = useMemo(() => parseGrep(grep).flatMap((t) => (t.not ? [] : [t.text])), [grep]);
  const ranges = useMemo(() => new WeakMap<object, Range[][]>(), [terms]);
  const rangesOf = (row: RowData): Range[][] => {
    let r = ranges.get(row);
    if (!r) ranges.set(row, (r = grepRanges(row.cells, terms)));
    return r;
  };
  // the rows a frame doesn't change would keep their old highlights: repaint the window
  useEffect(() => {
    const d = data.current;
    ref.current?.updateCells(d.order.flatMap((_, i) => d.columns.map((_, c) => ({ cell: [c, d.offset + i] as Item }))));
  }, [ranges]);

  // lets overlays (context menu) anchor to a row; see actions/anchor.ts
  useEffect(() => {
    const header = 24;
    rowLocators.set(serverId, {
      row: (i) => {
        const b = ref.current?.getBounds(0, i);
        return b && { x: b.x, y: b.y, width: b.width, height: b.height };
      },
      viewport: () => {
        const b = ref.current?.getBounds();
        return b && { x: b.x, y: b.y + header, width: b.width, height: b.height - header };
      },
    });
    return () => void rowLocators.delete(serverId);
  }, [serverId]);

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

  // widths: the type's saved ones, under the ones of a drag not saved yet
  const saved = useColumns((c) => (type ? c.types[type]?.widths : undefined));
  const [dragged, setDragged] = useState<Record<string, number>>({});
  const save = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(save.current), []);
  const widths = { ...saved, ...dragged };
  const onColumnResize = (column: string, width: number) => {
    const next = { ...dragged, [column]: width };
    setDragged(next);
    clearTimeout(save.current);
    if (!type) return;
    save.current = setTimeout(() => {
      // the push (onColumns) brings them back as saved; drop the local ones once it did
      bridge()
        .setColumnWidths(type, { ...useColumns.getState().types[type]?.widths, ...next })
        .then(() => setDragged((d) => (d === next ? {} : d)), () => {}); // a drag since keeps its own
    }, saveWidthsAfter);
  };

  const d = data.current;
  // a resized column stops growing: it keeps the width it was dragged to
  const columns: GridColumn[] = d.columns.map((c) => {
    const w = widths[c.name];
    if (w !== undefined) return { title: c.name, id: c.name, width: w };
    return {
      title: c.name,
      id: c.name,
      grow: c.name === "NAME" ? 1 : undefined,
      width: c.name === "NAME" ? 260 : c.type === "age" ? 70 : 120,
    };
  });

  const getCellContent = ([col, row]: Item): GridCell => {
    const l = layout(rowAt(data.current, row), col, data.current.columns[col], Date.now());
    return { kind: GridCellKind.Text, data: l.text, displayData: l.text, allowOverlay: false, readonly: true };
  };

  // the sorted column's header: Glide draws it as usual, then a small triangle at its right edge
  const drawHeader: DrawHeaderCallback = (args, drawContent) => {
    drawContent();
    if (!sort || args.column.id?.toUpperCase() !== sort.column.toUpperCase()) return;
    const { ctx, rect } = args;
    const s = 4;
    const x = rect.x + rect.width - 10;
    const y = rect.y + rect.height / 2;
    ctx.save();
    ctx.fillStyle = colors["fg"]!;
    ctx.beginPath();
    if (sort.desc) {
      ctx.moveTo(x - s, y - s / 2);
      ctx.lineTo(x + s, y - s / 2);
      ctx.lineTo(x, y + s / 2 + 1);
    } else {
      ctx.moveTo(x - s, y + s / 2);
      ctx.lineTo(x + s, y + s / 2);
      ctx.lineTo(x, y - s / 2 - 1);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  const drawCell: DrawCellCallback = (args, drawContent) => {
    const { ctx, rect, col, row, theme: t } = args;
    const r = rowAt(data.current, row);
    const column = data.current.columns[col];
    const l = layout(r, col, column, Date.now());
    if (l.tint) {
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = colors[l.tint]!;
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.restore();
    }
    if (l.hiddenMarker) {
      ctx.fillStyle = colors["hidden"]!;
      ctx.fillRect(rect.x, rect.y + 3, 3, rect.height - 6);
    }
    ctx.fillStyle = colors[colorVar[l.color]]!;
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
    // age cells show "5m" but grep matched the raw timestamp: offsets don't apply
    if (r && terms.length && column?.type !== "age") {
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = colors["match"]!;
      for (const [s, e] of rangesOf(r)[col] ?? []) {
        const x0 = x + ctx.measureText(l.text.slice(0, s)).width;
        ctx.fillRect(x0, rect.y + 3, ctx.measureText(l.text.slice(s, e)).width, rect.height - 6);
      }
      ctx.restore();
    }
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
      drawHeader={drawHeader}
      // a click sorts by the column; Glide sends none for the resize edge or a drag to another column
      onHeaderClicked={(col) => {
        const name = d.columns[col]?.name;
        if (name) onSort?.(name);
      }}
      theme={theme}
      onVisibleRegionChanged={onVisible}
      // drag a header to move the column (it's saved for the type, as the column dialog does);
      // drag a header edge to resize, double-click it to fit the visible cells
      onColumnMoved={onColumnMoved}
      onColumnResize={(c, _, __, withGrow) => onColumnResize(c.id!, withGrow)}
      minColumnWidth={40}
      maxColumnWidth={2000}
      smoothScrollY
      rowSelect="single"
      // rows only: a header click or a moved column selects no column (resizing would then size all selected ones)
      columnSelect="none"
      rowMarkers="none"
      gridSelection={selection}
      onGridSelectionChange={(s) => {
        const r = s.current?.cell[1] ?? s.rows.first();
        if (r !== undefined) onSelect(r);
      }}
      onCellActivated={onActivate}
      onHeaderContextMenu={(_, e) => {
        e.preventDefault(); // no webview context menu
        onHeaderMenu?.();
      }}
      onCellContextMenu={([, row], e) => {
        e.preventDefault(); // no webview context menu
        onContextMenu?.(row, e.bounds.x + e.localEventX, e.bounds.y + e.localEventY);
      }}
      keybindings={{ search: false, selectAll: false, copy: true, downFill: false, rightFill: false, clear: false }}
      getCellsForSelection
    />
  );
}
