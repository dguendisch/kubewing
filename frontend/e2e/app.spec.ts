import { expect, test, type Page } from "@playwright/test";

type Inspect = {
  focus: string;
  focusedPane: string;
  overlays: string[];
  activeTab: number;
  tabs: { id: string; focused: string; layout: unknown }[];
  panes: Record<string, { spec: { resource: string; grep: string; filter: string; labelSelector?: string; sort?: string }; serverId?: string; total: number; selected: number; type?: string; view?: { columns?: { name: string; path?: string; expr?: string }[]; widths?: Record<string, number> }; columns: string[]; rows: { key: string; cells: string[]; mark?: string; changed?: number[] }[]; status?: { synced: boolean; at?: string; recording?: boolean }; textSel?: { key: string; column: string; text: string; start: number; end: number; age?: boolean } }>;
};

const inspect = (page: Page) => page.evaluate(() => (window as unknown as { __kw: { inspect(): Inspect } }).__kw.inspect());

/** Waits until the app is mounted, key handling is live and the first pane is connected. */
async function ready(page: Page) {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => {
      const kw = (window as unknown as { __kw?: { inspect(): Inspect & { panes: Record<string, { serverId?: string }> } } }).__kw;
      if (!kw) return false;
      const s = kw.inspect();
      return !!s.panes[s.focusedPane]?.serverId;
    }))
    .toBe(true);
}

async function openTape(page: Page, resource = "e2e-pods", objects = 3) {
  await ready(page);
  await page.keyboard.press("ControlOrMeta+O");
  await page.getByRole("combobox", { name: "resource" }).fill(resource);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => {
      const p = await focused(page);
      return p.spec.resource === resource && !!p.serverId && p.status?.synced ? p.total : -1;
    })
    .toBe(objects);
}

const focused = async (page: Page) => {
  const s = await inspect(page);
  return s.panes[s.focusedPane]!;
};

// e2e-pods steps run on wall-clock time from the watch start (restart at 2s, recreate
// at 3s); the default 5s poll leaves too little slack for them on a loaded machine.
const tapeSteps = { timeout: 10_000 };

// e2e-pods after its last step (recreate at 3s): rows no longer shift.
async function afterTapeSteps(page: Page) {
  await expect.poll(async () => (await focused(page)).rows.map((r) => r.key), tapeSteps).toContain("e-api-0-b");
}

test("live table shows server-side columns and rows", async ({ page }) => {
  await openTape(page);
  const p = await focused(page);
  expect(p.columns).toEqual(["NAMESPACE", "NAME", "STATUS", "RESTARTS", "AGE"]);
  expect(p.rows.map((r) => r.cells[1])).toEqual(["etcd-0", "api-0", "api-1"]);
  expect(p.status?.synced).toBe(true);
  await expect(page.getByRole("status", { name: "pane status" })).toContainText("3 shown / 3 objects");
});

test.describe("columns (per resource type)", () => {
  // one backend serves the whole run, and columns.yaml with it: leave e2e-wide as it was
  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      const b = (window as unknown as { __kw: { bridge(): { setTypeColumns(t: string, c: null): Promise<void>; setColumnWidths(t: string, w: null): Promise<void> } } }).__kw.bridge();
      await b.setTypeColumns("e2e-wide", null);
      await b.setColumnWidths("e2e-wide", null);
    });
  });
  const dialog = (page: Page) => page.getByRole("dialog", { name: "columns" });
  const columnList = (page: Page) => dialog(page).getByRole("listbox", { name: "columns" }).getByRole("option");

  test("dragging a header edge saves the width for the type; a new pane of it has it too", async ({ page }) => {
    await openTape(page, "e2e-wide", 2);
    const box = (await page.locator("section[data-pane] canvas").first().boundingBox())!;
    // NAMESPACE is the first column, 120px wide; its right edge is the resize handle
    const y = box.y + 12;
    await page.mouse.move(box.x + 119, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 160, y, { steps: 4 });
    await page.mouse.move(box.x + 200, y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await focused(page)).view?.widths?.["NAMESPACE"]).toBe(200);
    await page.keyboard.press("ControlOrMeta+D");
    await expect.poll(async () => (await focused(page)).view?.widths?.["NAMESPACE"]).toBe(200);
  });

  test("o: -o wide shows the wide columns in every pane of the type; esc cancels, reset goes back", async ({ page }) => {
    await openTape(page, "e2e-wide", 2);
    await page.keyboard.press("ControlOrMeta+D"); // a second pane of the type
    await expect.poll(async () => (await focused(page)).columns).toEqual(["NAMESPACE", "NAME", "STATUS", "AGE"]);
    await page.keyboard.press("o");
    await expect(dialog(page)).toBeVisible();
    // the keyboard starts in the list, no click needed
    await expect(columnList(page).first()).toBeFocused();
    await expect(columnList(page)).toHaveText([/NAMESPACE/, /NAME/, /STATUS/, /AGE/, /IP\s*wide/, /NODE\s*wide/]);
    // esc: nothing changes
    await page.getByLabel("wide", { exact: true }).check();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    expect((await focused(page)).columns).toEqual(["NAMESPACE", "NAME", "STATUS", "AGE"]);
    // so does the cancel button
    await page.keyboard.press("o");
    await page.getByLabel("wide", { exact: true }).check();
    await dialog(page).getByRole("button", { name: "cancel" }).click();
    await expect(dialog(page)).toBeHidden();
    expect((await focused(page)).columns).toEqual(["NAMESPACE", "NAME", "STATUS", "AGE"]);

    await page.keyboard.press("o");
    await page.getByLabel("wide", { exact: true }).check();
    await dialog(page).getByRole("button", { name: "OK" }).click();
    await expect(dialog(page)).toBeHidden();
    const wide = ["NAMESPACE", "NAME", "STATUS", "AGE", "IP", "NODE"];
    await expect.poll(async () => (await focused(page)).columns).toEqual(wide);
    expect((await focused(page)).rows.map((r) => r.cells[4])).toEqual(["10.0.0.1", "10.0.0.2"]);
    // the other pane follows, live (its own frames: polled too)
    await expect.poll(async () => Object.values((await inspect(page)).panes).filter((p) => p.spec.resource === "e2e-wide").map((p) => p.columns)).toEqual([wide, wide]);
    expect((await focused(page)).view?.columns?.map((c) => c.name)).toEqual(wide);

    // reset: the server's defaults, saved as no settings
    await page.keyboard.press("o");
    await dialog(page).getByRole("button", { name: "reset columns" }).click();
    await dialog(page).getByRole("button", { name: "OK" }).click();
    await expect.poll(async () => (await focused(page)).columns).toEqual(["NAMESPACE", "NAME", "STATUS", "AGE"]);
    expect((await focused(page)).view?.columns).toBeUndefined();
  });

  test("reorder and hide with the keyboard; a custom column by field path, completed from the objects", async ({ page }) => {
    await openTape(page, "e2e-wide", 2);
    await page.keyboard.press("o");
    const options = columnList(page);
    await expect(options.first()).toBeFocused();
    await page.keyboard.press("Space"); // NAMESPACE off
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown"); // STATUS
    await page.keyboard.press("Alt+ArrowUp"); // before NAME
    await expect(options.nth(1)).toHaveText(/STATUS/);
    // node name, by completing the path one key at a time
    const path = dialog(page).getByRole("combobox", { name: "column path" });
    await path.fill("spec.nod");
    await page.getByRole("option", { name: /nodeName/ }).click();
    await expect(path).toHaveValue("spec.nodeName");
    await page.getByLabel("column name").fill("host");
    await path.press("Enter");
    await expect(options).toHaveText([/NAMESPACE/, /STATUS/, /NAME/, /AGE/, /HOST\s*spec\.nodeName/, /IP/, /NODE/]);
    // a bad CEL expression is refused by Go, the dialog stays
    await page.getByLabel("column source").selectOption("expr");
    await page.getByLabel("column expression").fill("o.spec.");
    await page.getByLabel("column expression").press("Enter");
    await options.first().focus();
    await page.keyboard.press("Enter");
    await expect(dialog(page).getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "remove SPEC" }).click();
    await options.first().focus();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeHidden();
    await expect.poll(async () => (await focused(page)).columns).toEqual(["STATUS", "NAME", "AGE", "HOST"]);
    expect((await focused(page)).rows.map((r) => r.cells[3])).toEqual(["node-a", "node-b"]);
  });

  test("CEL columns complete from the objects, as the filter bar's CEL field", async ({ page }) => {
    await openTape(page, "e2e-wide", 2);
    await page.keyboard.press("o");
    await page.getByLabel("column source").selectOption("expr");
    const expr = page.getByLabel("column expression");
    await expr.fill("o.spec.");
    const list = dialog(page).getByRole("listbox", { name: "cel suggestions" });
    await expect(list.getByRole("option").first()).toBeVisible();
    await expect(list).toContainText("nodeName");
    await page.keyboard.type("nod");
    await page.keyboard.press("Tab");
    await expect(expr).toHaveValue("o.spec.nodeName");
    await expect(list).toBeHidden();
    // ⏎ on a highlighted suggestion takes it, the next ⏎ adds the column; esc closes only the list
    await page.keyboard.type(".size() > 0 && o.metadata.lab");
    await expect(list).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(dialog(page)).toBeVisible();
    await expr.fill("o.spec.nodeName");
    await page.getByLabel("column name").fill("node2");
    await expr.press("Enter");
    await expect(columnList(page)).toContainText(["NODE2"]);
  });

  test("the status line's columns button opens it; the focus comes back to the table", async ({ page }) => {
    await openTape(page, "e2e-wide", 2);
    await page.getByRole("status", { name: "pane status" }).getByRole("button", { name: "columns" }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(columnList(page).first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    expect((await inspect(page)).focus).toBe("table");
  });

  test("reorder by drag & drop in the dialog", async ({ page }) => {
    await openTape(page, "e2e-wide", 2);
    await page.keyboard.press("o");
    // AGE onto NAME: it lands where NAME was
    await columnList(page).nth(3).dragTo(columnList(page).nth(1));
    await expect(columnList(page)).toHaveText([/NAMESPACE/, /AGE/, /NAME/, /STATUS/, /IP/, /NODE/]);
    await dialog(page).getByRole("button", { name: "OK" }).click();
    await expect.poll(async () => (await focused(page)).columns).toEqual(["NAMESPACE", "AGE", "NAME", "STATUS"]);
  });

  test("drag a header in the table to move the column: saved for the type, the other panes follow", async ({ page }) => {
    await openTape(page, "e2e-wide", 2);
    await page.keyboard.press("ControlOrMeta+D");
    await expect.poll(async () => (await focused(page)).columns).toEqual(["NAMESPACE", "NAME", "STATUS", "AGE"]);
    const box = (await page.locator("section[data-pane] canvas").first().boundingBox())!;
    // NAMESPACE (120px, first) onto STATUS: NAME grows, so STATUS (120px) sits right before AGE (70px) at the right
    // edge; pressed mid-header (not the resize edge) and moved past Glide's 20px drag threshold
    const y = box.y + 12;
    await page.mouse.move(box.x + 40, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 160, y, { steps: 6 });
    await page.mouse.move(box.x + box.width - 140, y, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await focused(page)).columns).toEqual(["NAME", "STATUS", "NAMESPACE", "AGE"]);
    await expect
      .poll(async () => Object.values((await inspect(page)).panes).filter((p) => p.spec.resource === "e2e-wide").map((p) => p.columns))
      .toEqual([["NAME", "STATUS", "NAMESPACE", "AGE"], ["NAME", "STATUS", "NAMESPACE", "AGE"]]);
    expect((await focused(page)).view?.columns?.map((c) => c.name)).toEqual(["NAME", "STATUS", "NAMESPACE", "AGE"]);
  });

  test("a header click sorts by the column: ascending, descending, back to kubectl's order", async ({ page }) => {
    await openTape(page, "e2e-wide", 2);
    const box = (await page.locator("section[data-pane] canvas").first().boundingBox())!;
    const names = async () => (await focused(page)).rows.map((r) => r.cells[1]);
    await expect.poll(names).toEqual(["web-0", "web-1"]);
    // the NODE column isn't shown: sort by NAME (the column after NAMESPACE, which ends at 120px)
    const name = () => page.mouse.click(box.x + 180, box.y + 12);
    // the sorted header shows a triangle near its right edge: bright pixels there, none before the click
    // (Glide draws the headers on its overlay canvas, the one after the cells')
    const canvas = page.locator("section[data-pane] canvas").nth(1);
    const nameEnd = box.width - 190; // NAME grows: STATUS (120) and AGE (70) follow it
    const arrow = () =>
      canvas.evaluate((c: HTMLCanvasElement, x: number) => {
        const dpr = window.devicePixelRatio;
        const px = c.getContext("2d")!.getImageData((x - 16) * dpr, 6 * dpr, 12 * dpr, 12 * dpr).data;
        let n = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i]! + px[i + 1]! + px[i + 2]! > 450) n++;
        return n;
      }, nameEnd);
    expect(await arrow()).toBe(0);
    await name();
    await expect.poll(async () => (await focused(page)).spec.sort).toBe("NAME");
    await expect.poll(names).toEqual(["web-0", "web-1"]);
    await expect.poll(arrow).toBeGreaterThan(4);
    await name();
    await expect.poll(async () => (await focused(page)).spec.sort).toBe("-NAME");
    await expect.poll(names).toEqual(["web-1", "web-0"]);
    await name();
    await expect.poll(async () => (await focused(page)).spec.sort).toBeUndefined();
    await expect.poll(names).toEqual(["web-0", "web-1"]);
    await expect.poll(arrow).toBe(0);
    // a click on the resize edge doesn't sort
    await page.mouse.click(box.x + 119, box.y + 12);
    await page.waitForTimeout(300);
    expect((await focused(page)).spec.sort).toBeUndefined();
  });

  test("AGE sorts by time, not by its text: 5m before 3d ascending", async ({ page }) => {
    await openTape(page, "e2e-wide", 2);
    // web-0 is 3 days old, web-1 5 minutes ("3d" < "5m" as text, the other way round in time)
    const box = (await page.locator("section[data-pane] canvas").first().boundingBox())!;
    const age = () => page.mouse.click(box.x + box.width - 35, box.y + 12); // AGE is last, 70px
    const names = async () => (await focused(page)).rows.map((r) => r.cells[1]);
    await age();
    await expect.poll(async () => (await focused(page)).spec.sort).toBe("AGE");
    await expect.poll(names).toEqual(["web-1", "web-0"]);
    await age();
    await expect.poll(async () => (await focused(page)).spec.sort).toBe("-AGE");
    await expect.poll(names).toEqual(["web-0", "web-1"]);
  });

  test("the path and CEL fields are equally wide", async ({ page }) => {
    await openTape(page, "e2e-wide", 2);
    await page.keyboard.press("o");
    const path = (await dialog(page).getByRole("combobox", { name: "column path" }).boundingBox())!;
    await page.getByLabel("column source").selectOption("expr");
    const cel = (await page.getByLabel("column expression").boundingBox())!;
    expect(Math.round(path.width)).toBe(Math.round(cel.width));
    expect(Math.round(path.x)).toBe(Math.round(cel.x));
  });

  test("right-click on the header opens it too", async ({ page }) => {
    await openTape(page, "e2e-wide", 2);
    const box = (await page.locator("section[data-pane] canvas").first().boundingBox())!;
    await page.mouse.click(box.x + 60, box.y + 12, { button: "right" });
    await expect(dialog(page)).toBeVisible();
  });
});

test("keyed diff: restart is a changed cell, recreate is remove + add", async ({ page }) => {
  await openTape(page);
  await expect.poll(async () => (await focused(page)).rows.find((r) => r.key === "e-api-1")?.changed, tapeSteps).toEqual([3]);
  await expect.poll(async () => (await focused(page)).rows.map((r) => [r.key, r.mark ?? ""]), tapeSteps).toEqual([
    ["e-etcd-0", ""],
    ["e-api-0", "deleted"],
    ["e-api-0-b", "added"],
    ["e-api-1", ""],
  ]);
});

test("cmd+shift+d / cmd+d split, ctrl+d closes, focus stays valid", async ({ page }) => {
  await openTape(page);
  // swapped vs. iTerm: ⌘⇧D side by side, ⌘D stacked
  await page.keyboard.press("ControlOrMeta+Shift+D");
  await page.keyboard.press("ControlOrMeta+D");
  let s = await inspect(page);
  expect(s.tabs[0]!.layout).toEqual({
    type: "split", dir: "row",
    children: [{ type: "pane", id: "v1" }, { type: "split", dir: "column", children: [{ type: "pane", id: "v2" }, { type: "pane", id: "v3" }] }],
  });
  expect(s.focusedPane).toBe("v3");
  // splits on the same source share data
  await expect.poll(async () => (await inspect(page)).panes.v3?.total).toBe(3);
  await page.keyboard.press("Control+D");
  s = await inspect(page);
  expect(s.focusedPane).toBe("v2");
  expect(Object.keys(s.panes).sort()).toEqual(["v1", "v2"]);
});

test("cmd+w closes a single-pane tab, but asks when the tab has splits", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("ControlOrMeta+T"); // second tab, one pane
  expect((await inspect(page)).tabs).toHaveLength(2);
  await page.keyboard.press("ControlOrMeta+W");
  let s = await inspect(page);
  expect(s.tabs).toHaveLength(1);
  expect(s.overlays).toEqual([]);
  // a tab with two panes asks first; esc keeps it
  await page.keyboard.press("ControlOrMeta+Shift+D");
  await page.keyboard.press("ControlOrMeta+W");
  s = await inspect(page);
  expect(s.overlays).toEqual(["closeTab"]);
  expect(s.focus).toBe("confirm");
  await expect(page.getByRole("alertdialog", { name: "confirm close tab" })).toContainText("2 panes");
  await page.keyboard.press("Escape");
  s = await inspect(page);
  expect(s.overlays).toEqual([]);
  expect(Object.keys(s.panes).sort()).toEqual(["v1", "v3"]);
  // ⏎ accepts; the last tab is replaced by a fresh one
  await page.keyboard.press("ControlOrMeta+W");
  await page.keyboard.press("Enter");
  s = await inspect(page);
  expect(s.overlays).toEqual([]);
  expect(s.tabs).toHaveLength(1);
  expect(Object.keys(s.panes)).toHaveLength(1);
});

test("filter bar: / focuses, grep narrows rows, esc returns to table", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("/");
  expect((await inspect(page)).focus).toBe("filter");
  await expect(page.getByLabel("filter")).toBeFocused();
  await page.keyboard.type("etcd");
  await expect.poll(async () => (await focused(page)).rows.map((r) => r.cells[1])).toEqual(["etcd-0"]);
  // typing j in the filter must not move the selection
  expect((await focused(page)).spec.grep).toBe("etcd");
  await page.keyboard.press("Escape");
  expect((await inspect(page)).focus).toBe("table");
});

test("grep: !x excludes; a negated term applies once finished, so typing it never blanks the table", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("/");
  const totals: number[] = [];
  for (const ch of "!etc") {
    await page.keyboard.type(ch);
    await page.waitForTimeout(250); // slower than the debounce
    totals.push((await focused(page)).total);
  }
  expect(totals).toEqual([3, 3, 3, 3]);
  await expect(page.getByRole("status", { name: "grep draft" })).toContainText("!etc · ⏎ apply");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await focused(page)).rows.map((r) => r.cells[1])).toEqual(["api-0", "api-1"]);
  // ⏎ also goes back to the list, like esc
  expect((await inspect(page)).focus).toBe("table");
  await expect(page.getByLabel("filter", { exact: true })).not.toBeFocused();
  // a following term applies the negated one as well; quotes make a phrase
  await page.getByLabel("filter", { exact: true }).fill('"api-1" !etcd');
  await expect.poll(async () => (await focused(page)).rows.map((r) => r.cells[1])).toEqual(["api-1"]);
});

test("grep highlights its matches in the cells, and the highlight goes with the grep", async ({ page }) => {
  await openTape(page);
  const canvas = page.locator("section[data-pane] canvas").first();
  // match-colored pixels in the first row's band (header 24px, rows 22px): blue-grey, brighter than the selected row's bluish background
  const highlighted = () =>
    canvas.evaluate((c: HTMLCanvasElement) => {
      const dpr = window.devicePixelRatio;
      const px = c.getContext("2d")!.getImageData(0, 24 * dpr, c.width, 22 * dpr).data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i + 2]! > px[i]! + 35 && px[i + 2]! > 90) n++;
      return n;
    });
  expect(await highlighted()).toBe(0);
  await page.keyboard.press("/");
  await page.keyboard.type("etcd");
  await expect.poll(async () => (await focused(page)).rows.map((r) => r.cells[1])).toEqual(["etcd-0"]);
  await expect.poll(highlighted).toBeGreaterThan(20);
  await page.getByLabel("filter", { exact: true }).fill("");
  await expect.poll(async () => (await focused(page)).total).toBe(3);
  await expect.poll(highlighted).toBe(0);
});

test("label selector: click or l focuses it and keeps focus while typing; tab moves between the filter fields", async ({ page }) => {
  await openTape(page);
  const labels = page.getByLabel("label selector");
  await labels.click();
  await expect(labels).toBeFocused();
  expect((await inspect(page)).focus).toBe("filter");
  await page.keyboard.type("app=api");
  await expect(labels).toHaveValue("app=api");
  // a draft until ⏎: the table is untouched, the preview counts what it would show
  await expect(page.getByRole("status", { name: "labels draft" })).toContainText("→ 2 / 3");
  expect((await focused(page)).total).toBe(3);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await page.evaluate(() => {
    const kw = (window as unknown as { __kw: { inspect(): { focusedPane: string; panes: Record<string, { spec: { labelSelector: string } }> } } }).__kw;
    const s = kw.inspect();
    return s.panes[s.focusedPane]?.spec.labelSelector;
  }))).toBe("app=api");
  await expect(labels).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByLabel("filter", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(labels).toBeFocused();
  expect((await inspect(page)).focus).toBe("filter");
  await page.keyboard.press("Escape");
  expect((await inspect(page)).focus).toBe("table");
  await expect(labels).not.toBeFocused();
  // l from the table lands in the label field, / still in grep
  await page.keyboard.press("l");
  await expect(labels).toBeFocused();
  await expect(labels).toHaveValue("app=api"); // l is not typed into the field
  await page.keyboard.press("Escape");
  await page.keyboard.press("/");
  await expect(page.getByLabel("filter", { exact: true })).toBeFocused();
});

test("label selector completes keys and values from the live objects; ↓ opens the list", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("l");
  const labels = page.getByLabel("label selector");
  const list = page.getByRole("listbox", { name: "label suggestions" });
  // ↓ in the empty field lists every key, the first one highlighted
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("option", { selected: true })).toContainText("app");
  await expect(list.getByRole("option").first()).toContainText("3/3");
  await page.keyboard.press("Tab");
  await expect(labels).toHaveValue("app");
  // values open right after the operator, most common first
  await page.keyboard.type("=");
  await expect(list.getByRole("option")).toHaveText(["api2/3", "etcd1/3"]);
  await page.keyboard.type("et");
  await page.keyboard.press("Tab");
  await expect(labels).toHaveValue("app=etcd");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await focused(page)).spec.labelSelector).toBe("app=etcd");
  // after a key and a space: the operators; in (…) lists the values
  await labels.fill("app ");
  await expect(list.getByRole("option").first()).toContainText("=");
  await page.keyboard.type("in");
  await page.keyboard.press("Tab");
  await expect(labels).toHaveValue("app in (");
  await expect(list.getByRole("option")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(labels).toBeFocused();
  // ↓ opens it again where typing alone doesn't
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("option", { selected: true })).toContainText("api");
});

test("cel filter: c focuses, a draft previews without touching the table, ⏎ applies", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("c");
  const cel = page.getByLabel("cel", { exact: true });
  await expect(cel).toBeFocused();
  const preview = page.getByRole("status", { name: "cel draft" });
  // an open string is a parse error with a caret; the table stays as it is
  await page.keyboard.type('o.metadata.labels.app == "et');
  await expect(preview).toContainText("^");
  await expect(cel).toHaveAttribute("aria-invalid", "true");
  // half-typed value: valid, matches nothing, still nothing applied
  await page.keyboard.type('"');
  await expect(preview).toContainText("→ 0 / 3");
  expect((await focused(page)).total).toBe(3);
  await page.keyboard.press("Backspace");
  await page.keyboard.type('cd"');
  await expect(preview).toContainText("→ 1 / 3");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await focused(page)).rows.map((r) => r.cells[1])).toEqual(["etcd-0"]);
  await expect(preview).toHaveCount(0); // applied: nothing pending
  // a parse error is refused with the reason; the applied filter stays
  await page.keyboard.type(" &&");
  await expect(cel).toHaveAttribute("aria-invalid", "true");
  await page.keyboard.press("Enter");
  expect((await focused(page)).spec.filter).toBe('o.metadata.labels.app == "etcd"');
  // the error only shows while the field has focus; unfocused, the red border and tooltip remain
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(cel).toHaveAttribute("aria-invalid", "true");
  await expect(cel).toHaveAttribute("title", /Syntax error/);
  await page.keyboard.press("c");
  await expect(preview).toContainText("Syntax error");
  // empty + ⏎ clears
  await cel.fill("");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await focused(page)).total).toBe(3);
  // leaving the field applies a valid draft, like ⏎
  await cel.fill('o.metadata.labels.app == "api"');
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await focused(page)).rows.map((r) => r.cells[1])).toEqual(["api-0", "api-1"]);
  await expect(cel).not.toHaveClass(/border-dashed/);
});

test("cel filter completes field paths from the live objects", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("c");
  await page.keyboard.type("o.metadata.la");
  const list = page.getByRole("listbox", { name: "cel suggestions" });
  await expect(list.getByRole("option").first()).toContainText("labels");
  await expect(list.getByRole("option").first()).toContainText("map · 3/3");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("cel", { exact: true })).toHaveValue("o.metadata.labels");
});

test("cel filter: ↓ opens the suggestions at the caret, ↑ in an empty field recalls recent filters", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("c");
  const cel = page.getByLabel("cel", { exact: true });
  const list = page.getByRole("listbox", { name: "cel suggestions" });
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("option", { selected: true })).toContainText("o");
  await page.keyboard.press("Enter");
  await expect(cel).toHaveValue("o.");
  await page.keyboard.type('metadata.labels.app == "api"');
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await focused(page)).total).toBe(2);
  // where typing opens nothing (a value goes after the operator), ↓ lists what can go there
  await cel.fill("o.metadata.labels.app == ");
  await expect(list).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await expect(list).toContainText("has(o.…)");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(cel).toBeFocused(); // the first Esc only closes the list
  // ↑ in the empty field: the filter applied last, ↓ back to empty
  await cel.fill("");
  await page.keyboard.press("ArrowUp");
  await expect(cel).toHaveValue('o.metadata.labels.app == "api"');
  await page.keyboard.press("ArrowDown");
  await expect(cel).toHaveValue("");
});

test("cel filter brackets keys that aren't identifiers, and completes after them", async ({ page }) => {
  // runs before the safety tests delete web-0 from this tape (serial, in file order)
  await openTape(page, "e2e-static", 8);
  await page.keyboard.press("c");
  const cel = page.getByLabel("cel", { exact: true });
  const list = page.getByRole("listbox", { name: "cel suggestions" });
  await page.keyboard.type("o.metadata.annotations.kub");
  await expect(list.getByRole("option").first()).toContainText("kubectl.kubernetes.io/default-container");
  await page.keyboard.press("Tab");
  await expect(cel).toHaveValue('o.metadata.annotations["kubectl.kubernetes.io/default-container"]');
  // the operator after it fits the key's type (a string)
  await page.keyboard.type(" ");
  await expect(list.getByRole("option").first()).toContainText("==");
  await page.keyboard.type('== "sidecar"');
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await focused(page)).rows.map((r) => r.cells[1])).toEqual(["web-0"]);
});

test("cel filter completes operators that fit the field's type", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("c");
  await page.keyboard.type("o.status.phase ");
  const list = page.getByRole("listbox", { name: "cel suggestions" });
  await expect(list.getByRole("option").first()).toContainText("==");
  await expect(list).toContainText("in […]");
  await expect(list).not.toContainText("&&"); // a string, not a bool
  await page.keyboard.type("!");
  await page.keyboard.press("Tab");
  const cel = page.getByLabel("cel", { exact: true });
  await expect(cel).toHaveValue("o.status.phase != ");
  await page.keyboard.type('"Pending"');
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await focused(page)).spec.filter).toBe('o.status.phase != "Pending"');
});

test("= in the YAML view filters by the field under the cursor", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("Enter"); // YAML of etcd-0
  const dialog = page.getByRole("dialog", { name: "object detail" });
  await expect(dialog).toContainText("app: etcd");
  await dialog.getByText("app: etcd").click();
  await page.keyboard.press("=");
  await expect.poll(async () => (await focused(page)).spec.filter).toBe('o.metadata.labels.app == "etcd"');
  await expect.poll(async () => (await focused(page)).rows.map((r) => r.cells[1])).toEqual(["etcd-0"]);
  expect((await inspect(page)).overlays).toEqual([]);
});

test("an error in the status line: its first line, a click shows all of it above, selectable and copyable", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openTape(page, "e2e-error", 1);
  const entry = page.getByRole("button", { name: "pane error" });
  await expect(entry).toHaveText("the server rejected our request for an unknown reason (get pods)");
  await entry.click();
  const pop = page.getByRole("dialog", { name: "error detail" });
  await expect(pop.getByLabel("error text")).toHaveText(
    "the server rejected our request for an unknown reason (get pods)\nfield label not supported: involvedObject.kind\nHTTP 400 BadRequest",
  );
  // above the status line, not over it
  const [p, e] = [await pop.boundingBox(), await entry.boundingBox()];
  expect(p!.y + p!.height).toBeLessThanOrEqual(e!.y);
  // keys go to it, not the table: ⌘C is the native copy of a selection
  expect((await inspect(page)).focus).toBe("dialog");
  await pop.getByLabel("error text").selectText();
  await page.keyboard.press("ControlOrMeta+C");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("field label not supported: involvedObject.kind");
  // "copy all" takes the whole message
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await pop.getByRole("button", { name: "copy all" }).click();
  await expect(pop.getByRole("button", { name: "copied" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("HTTP 400 BadRequest");
  // esc closes, back on the table
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  expect((await inspect(page)).focus).toBe("table");
  // a click on the entry again, or elsewhere, closes it too
  await entry.click();
  await expect(pop).toBeVisible();
  await entry.click();
  await expect(pop).toHaveCount(0);
  await entry.click();
  await page.locator("section[data-pane] header").getByLabel("filter").click();
  await expect(pop).toHaveCount(0);
});

test("⌘C copies the selected row's name; in a text field it stays the native copy", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openTape(page);
  await page.keyboard.press("j"); // api-0
  await page.keyboard.press("ControlOrMeta+C");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("api-0");
  await expect(page.getByRole("status", { name: "pane status" })).toContainText("copied api-0");
  // in the grep field ⌘C copies the field's selection, not the row
  await page.keyboard.press("/");
  await page.keyboard.type("xyz");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+C");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("xyz");
});

test.describe("text selection in a cell", () => {
  // e2e-wide (stable, no steps): NAMESPACE 120px, NAME grows, STATUS 120px, AGE 70px; header 24px, rows 22px, padding 8px
  const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
  const sel = async (page: Page) => (await focused(page)).textSel;
  /** Viewport point over char i of a row's cell (left-aligned text). */
  async function at(page: Page, row: number, x0: number, text: string, i: number) {
    const box = (await page.locator("section[data-pane] canvas").first().boundingBox())!;
    const w = await page.evaluate(([t, n]) => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = `12px ${getComputedStyle(document.body).fontFamily}`;
      return [ctx.measureText(t.slice(0, n)).width, ctx.measureText(t.slice(0, n + 1)).width];
    }, [text, i] as const);
    return { x: box.x + x0 + 8 + (w[0]! + w[1]!) / 2, y: box.y + 24 + row * 22 + 11 };
  }

  test("double-click selects a word, triple-click the cell, a drag a range; ⌘C copies it; esc clears", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openTape(page, "e2e-wide", 2);
    const row = (await focused(page)).rows[0]!;
    const ns = row.cells[0]!, name = row.cells[1]!;
    // double-click on a namespace selects it (one word) and opens nothing
    const p = await at(page, 0, 0, ns, 1);
    await page.mouse.dblclick(p.x, p.y);
    await expect.poll(() => sel(page)).toMatchObject({ key: row.key, column: "NAMESPACE", start: 0, end: ns.length });
    expect((await inspect(page)).overlays).toEqual([]);
    expect((await focused(page)).selected).toBe(0);
    await page.keyboard.press("ControlOrMeta+C");
    await expect.poll(() => clipboard(page)).toBe(ns);
    await expect(page.getByRole("status", { name: "pane status" })).toContainText(`copied ${ns}`);

    // a drag over the first three chars of the name
    const a = await at(page, 0, 120, name, 0), b = await at(page, 0, 120, name, 2);
    await page.mouse.move(a.x - 3, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x + 3, b.y, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => sel(page)).toMatchObject({ column: "NAME", start: 0, end: 3 });
    await page.keyboard.press("ControlOrMeta+C");
    await expect.poll(() => clipboard(page)).toBe(name.slice(0, 3));

    // triple-click: the whole cell
    await page.mouse.click(b.x, b.y, { clickCount: 3 });
    await expect.poll(() => sel(page)).toMatchObject({ column: "NAME", start: 0, end: name.length });

    // esc clears it: ⌘C is the name again
    await page.keyboard.press("Escape");
    await expect.poll(() => sel(page)).toBeUndefined();
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.keyboard.press("ControlOrMeta+C");
    await expect.poll(() => clipboard(page)).toBe(name);
    // ⏎ still opens the YAML
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await inspect(page)).overlays).toEqual(["detail"]);
    await page.keyboard.press("Escape");
  });

  test("an age cell is selected whole and copies its timestamp; another row clears the selection", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openTape(page, "e2e-wide", 2);
    const box = (await page.locator("section[data-pane] canvas").first().boundingBox())!;
    const { rows, columns } = await focused(page);
    const age = rows[0]!.cells[columns.indexOf("AGE")]!;
    expect(age).toMatch(/^\d{4}-\d\d-\d\dT/); // the cell holds the timestamp, the table shows "5m"
    await page.mouse.dblclick(box.x + box.width - 70 + 12, box.y + 24 + 11);
    await expect.poll(() => sel(page)).toMatchObject({ column: "AGE", age: true });
    await page.keyboard.press("ControlOrMeta+C");
    await expect.poll(() => clipboard(page)).toBe(age);
    // j: another row, the selection goes
    await page.keyboard.press("j");
    await expect.poll(() => sel(page)).toBeUndefined();
  });
});

test("⌘O: picking a context that sets a namespace in the kubeconfig prefills it", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("ControlOrMeta+O");
  const ns = page.getByRole("combobox", { name: "namespace" });
  await expect(ns).toHaveValue(""); // the current context (tape) sets none
  await page.getByLabel("context").selectOption("tape-dev");
  await expect(ns).toHaveValue("prod");
  await page.getByLabel("context").selectOption("tape-live");
  await expect(ns).toHaveValue("");
});

test("j/k move selection, enter opens detail, d toggles diff, esc restores focus", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  expect((await focused(page)).selected).toBe(1);
  await page.keyboard.press("Enter");
  let s = await inspect(page);
  expect(s.overlays).toEqual(["detail"]);
  expect(s.focus).toBe("detail");
  await expect(page.getByRole("dialog", { name: "object detail" })).toContainText("kind: Pod");
  await page.keyboard.press("d");
  await expect(page.getByRole("dialog", { name: "object detail" })).toContainText("diff");
  await page.keyboard.press("Escape");
  s = await inspect(page);
  expect(s.overlays).toEqual([]);
  expect(s.focus).toBe("table");
  expect((await focused(page)).selected).toBe(1);
});

test("? shows the cheat sheet with the live keymap, esc closes it", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("j");
  await page.keyboard.press("?");
  let s = await inspect(page);
  expect(s.overlays).toEqual(["help"]);
  expect(s.focus).toBe("help");
  const sheet = page.getByRole("dialog", { name: "keyboard shortcuts" });
  await expect(sheet).toContainText("split down");
  await expect(sheet).toContainText("⌘1–⌘9");
  await expect(sheet.getByText("exec shell")).toBeVisible();
  // ? toggles it back off, leaving the table as it was
  await page.keyboard.press("?");
  expect((await inspect(page)).overlays).toEqual([]);
  await page.keyboard.press("?");
  await page.keyboard.press("Escape");
  s = await inspect(page);
  expect(s.overlays).toEqual([]);
  expect(s.focus).toBe("table");
  expect((await focused(page)).selected).toBe(1);
});

test("? in the filter bar is typed, not a shortcut", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("/");
  await page.keyboard.type("?");
  await expect.poll(async () => (await focused(page)).spec.grep).toBe("?");
  expect((await inspect(page)).overlays).toEqual([]);
});

test("tabs: cmd+t opens, cmd+shift+] cycles; ARIA structure", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("ControlOrMeta+T");
  expect((await inspect(page)).activeTab).toBe(1);
  await page.keyboard.press("ControlOrMeta+Shift+BracketRight");
  expect((await inspect(page)).activeTab).toBe(0);
  await expect(page.getByRole("tablist")).toMatchAriaSnapshot(`
    - tablist:
      - tab "e2e-pods" [selected]
      - tab /pods/
      - button "new tab"
  `);
});

test("switching tabs keeps each tab's live table", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("ControlOrMeta+T");
  await expect.poll(async () => (await focused(page)).status?.synced).toBe(true);
  await page.keyboard.press("ControlOrMeta+Shift+BracketLeft");
  await expect(page.getByRole("tab", { selected: true })).toHaveAccessibleName("e2e-pods");
  await expect.poll(async () => (await focused(page)).rows.length).toBe(3);
  await expect(page.getByRole("status", { name: "pane status" })).toContainText("3 shown / 3 objects");
});

test("splits fill the tab width and the split pane keeps its data", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("ControlOrMeta+Shift+D");
  await expect.poll(async () => (await inspect(page)).panes.v1?.rows.length).toBe(3);
  const main = (await page.locator("main").boundingBox())!;
  const panes = await Promise.all(["v1", "v2"].map(async (id) => (await page.locator(`[data-pane=${id}]`).boundingBox())!));
  const width = panes.reduce((w, b) => w + b.width, 0);
  expect(width).toBeGreaterThan(main.width - 8);
  expect(Math.abs(panes[0]!.width - panes[1]!.width)).toBeLessThan(2);
});

test("unknown resource shows an error in the pane", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("ControlOrMeta+O");
  await page.getByRole("combobox", { name: "resource" }).fill("nope");
  await page.keyboard.press("Enter");
  await expect(page.locator("section[data-pane]").getByRole("alert")).toContainText("doesn't have a resource type");
});

test("cmd+opt+arrows move focus between tiles and stop at the edge", async ({ page }) => {
  await openTape(page);
  // v1 | (v2 / v3)
  await page.keyboard.press("ControlOrMeta+Shift+D");
  await page.keyboard.press("ControlOrMeta+D");
  const at = async () => (await inspect(page)).focusedPane;
  expect(await at()).toBe("v3");
  await page.keyboard.press("ControlOrMeta+Alt+ArrowUp");
  expect(await at()).toBe("v2");
  await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
  expect(await at()).toBe("v1");
  await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft"); // edge: stays
  expect(await at()).toBe("v1");
  await page.keyboard.press("ControlOrMeta+Alt+ArrowRight");
  expect(await at()).toBe("v2");
  await page.keyboard.press("ControlOrMeta+Alt+ArrowDown");
  expect(await at()).toBe("v3");
  await expect(page.locator("[data-pane=v3]")).toHaveClass(/border-accent/);
});

test("opt+up / opt+down jump to the first / last row", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("Alt+ArrowDown");
  expect((await focused(page)).selected).toBe(2);
  await page.keyboard.press("Alt+ArrowUp");
  expect((await focused(page)).selected).toBe(0);
});

test.describe("ctrl+tab MRU tab switching", () => {
  /** Three tabs, used in order 1, 2, 3 (active): MRU = [3, 2, 1]. */
  async function threeTabs(page: Page) {
    await openTape(page);
    await page.keyboard.press("ControlOrMeta+T");
    await page.keyboard.press("ControlOrMeta+T");
    expect((await inspect(page)).activeTab).toBe(2);
  }
  const active = async (page: Page) => (await inspect(page)).activeTab;

  test("a quick tap flips between the two most recent tabs, without an overlay", async ({ page }) => {
    await threeTabs(page);
    await page.keyboard.press("Control+Tab");
    expect(await active(page)).toBe(1);
    await expect(page.getByRole("listbox", { name: "tab switcher" })).toBeHidden();
    await page.keyboard.press("Control+Tab");
    expect(await active(page)).toBe(2);
    // MRU, not positional: going back from 3 skips over nothing, 1 is now least recent
    await page.keyboard.press("ControlOrMeta+Shift+BracketLeft"); // tab 2 (positional cycle counts as use)
    await page.keyboard.press("ControlOrMeta+Shift+BracketLeft"); // tab 1
    await page.keyboard.press("Control+Tab");
    expect(await active(page)).toBe(1); // tab 2, the previously used one
  });

  test("holding ctrl shows the switcher; tab steps back, release commits", async ({ page }) => {
    await threeTabs(page);
    await page.keyboard.down("Control");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const sw = page.getByRole("listbox", { name: "tab switcher" });
    await expect(sw).toBeVisible();
    await expect(sw.getByRole("option")).toHaveCount(3);
    await expect(sw.getByRole("option", { selected: true })).toContainText("⌘1"); // least recent = first tab
    expect(await active(page)).toBe(2); // nothing switched while browsing
    await page.keyboard.up("Control");
    await expect(sw).toBeHidden();
    expect(await active(page)).toBe(0);
    expect((await inspect(page)).focus).toBe("table");
  });

  test("ctrl+shift+tab goes the other way; esc cancels", async ({ page }) => {
    await threeTabs(page);
    await page.keyboard.down("Control");
    await page.keyboard.press("Shift+Tab");
    const sw = page.getByRole("listbox", { name: "tab switcher" });
    await expect(sw.getByRole("option", { selected: true })).toContainText("⌘1");
    await page.keyboard.press("Escape");
    await expect(sw).toBeHidden();
    await page.keyboard.up("Control");
    expect(await active(page)).toBe(2);
    expect((await inspect(page)).overlays).toEqual([]);
  });
});

test("cmd+1..9 jump to tabs (9 = last); tab headers show the shortcut", async ({ page }) => {
  await openTape(page);
  for (let i = 0; i < 3; i++) await page.keyboard.press("ControlOrMeta+T"); // 4 tabs
  const tabs = page.getByRole("tab");
  await expect(tabs.nth(0)).toHaveAttribute("aria-keyshortcuts", "Meta+1");
  await expect(tabs.nth(2)).toContainText("⌘3");
  await expect(tabs.nth(3)).toHaveAttribute("aria-keyshortcuts", "Meta+4");
  await page.keyboard.press("ControlOrMeta+1");
  expect((await inspect(page)).activeTab).toBe(0);
  await page.keyboard.press("ControlOrMeta+3");
  expect((await inspect(page)).activeTab).toBe(2);
  await page.keyboard.press("ControlOrMeta+9");
  expect((await inspect(page)).activeTab).toBe(3);
  await page.keyboard.press("ControlOrMeta+6"); // no 6th tab
  expect((await inspect(page)).activeTab).toBe(3);
  // the hint is decoration: accessible tab names stay the pane titles
  for (let i = 0; i < 4; i++) await expect(tabs.nth(i)).toHaveAccessibleName("e2e-pods");
});

// ⌘O completion: data comes from the backend catalog (testdata/catalog.yaml),
// fetched after the first pane opened on the context.
test.describe("⌘O completion", () => {
  const options = (page: Page, field: string) => page.getByRole("listbox", { name: `${field} suggestions` }).getByRole("option");

  test("prefix completes, enter opens the completed resource", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    const resource = page.getByRole("combobox", { name: "resource" });
    await resource.fill("");
    await resource.pressSequentially("e2e");
    await expect(options(page, "resource").first()).toContainText("e2e-pods");
    await expect(options(page, "resource").first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect.poll(async () => {
      const p = await focused(page);
      return p.spec.resource === "e2e-pods" && p.status?.synced ? p.total : -1;
    }).toBe(3);
  });

  test("ranking, scope and ambiguous groups are shown", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    const resource = page.getByRole("combobox", { name: "resource" });
    await resource.fill("deploy");
    await expect(options(page, "resource").first()).toContainText("deployments");
    await expect(options(page, "resource").first()).toContainText("apps · namespaced · deploy");
    await resource.fill("machines");
    // same plural in two groups: both offered qualified, the group isn't repeated in the detail
    await expect(options(page, "resource")).toHaveCount(2);
    await expect(options(page, "resource").filter({ hasText: "machines.machine.sapcloud.io" })).toContainText("namespaced · mach");
    await expect(options(page, "resource").filter({ hasText: "machines.cluster.x-k8s.io" })).toHaveText(/^machines\.cluster\.x-k8s\.ionamespaced · ma$/);
  });

  test("tab completes and stays; esc closes the list, then the dialog", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    const resource = page.getByRole("combobox", { name: "resource" });
    await resource.fill("svc");
    // Tab only completes once the catalog has arrived and the list shows
    await expect(options(page, "resource").first()).toContainText("services");
    await page.keyboard.press("Tab");
    await expect(resource).toHaveValue("services");
    await expect(resource).toBeFocused();
    expect((await inspect(page)).overlays).toEqual(["open"]);
    await resource.fill("po");
    await expect(options(page, "resource").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox", { name: "resource suggestions" })).toBeHidden();
    expect((await inspect(page)).overlays).toEqual(["open"]);
    await page.keyboard.press("Escape");
    expect((await inspect(page)).overlays).toEqual([]);
  });

  test("arrow keys pick a namespace; cluster-scoped types hide it", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    const ns = page.getByRole("combobox", { name: "namespace" });
    await ns.fill("kube");
    await expect(options(page, "namespace")).toHaveText(["kube-public", "kube-system"]);
    // the best prefix match is preselected; one ↓ moves to the next
    await expect(options(page, "namespace").first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await expect(options(page, "namespace").nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Tab");
    await expect(ns).toHaveValue("kube-system");
    await page.getByRole("combobox", { name: "resource" }).fill("nodes");
    await expect(ns).toBeHidden();
  });

  test("free text still submits as typed (no forced completion)", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    // "nope" fuzzy-matches nothing preselectable: Enter submits it unchanged
    await page.getByRole("combobox", { name: "resource" }).fill("nope");
    await page.keyboard.press("Enter");
    await expect(page.locator("section[data-pane]").getByRole("alert")).toContainText("doesn't have a resource type");
    expect((await focused(page)).spec.resource).toBe("nope");
  });

  test("fields open with their value selected, so typing replaces it", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    const resource = page.getByRole("combobox", { name: "resource" });
    await expect(resource).toHaveValue("pods");
    // no list until typing
    await expect(page.getByRole("listbox", { name: "resource suggestions" })).toBeHidden();
    await page.keyboard.type("svc");
    await expect(options(page, "resource").first()).toContainText("services");
    await expect(resource).toHaveValue("svc");
    // abandoned edits don't stick: reopening starts from the pane's spec, selected again
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    expect((await inspect(page)).overlays).toEqual([]);
    await page.keyboard.press("ControlOrMeta+O");
    await expect(resource).toHaveValue("pods");
    await page.keyboard.type("deploy");
    await expect(resource).toHaveValue("deploy");
  });

  test("↓ on an untouched field opens the full list for browsing", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    await page.keyboard.press("Tab"); // to namespace; still no list
    await expect(page.getByRole("listbox", { name: "namespace suggestions" })).toBeHidden();
    await page.keyboard.press("ArrowDown");
    await expect(options(page, "namespace").first()).toHaveText(/all namespaces/);
    await expect(options(page, "namespace").first()).toHaveAttribute("aria-selected", "true");
  });

  test("ARIA structure of the completion list", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    await page.getByRole("combobox", { name: "resource" }).fill("crd");
    await expect(page.getByRole("dialog", { name: "open source" })).toMatchAriaSnapshot(`
      - combobox "resource" [expanded]: crd
      - listbox "resource suggestions":
        - option /customresourcedefinitions.*cluster · crd,crds/ [selected]
    `);
  });
});

test.describe("config (testdata/config)", () => {
  test("keybindings.yaml: cmd+k moves the selection down in the table", async ({ page }) => {
    await openTape(page);
    await page.keyboard.press("Meta+K");
    await page.keyboard.press("Meta+K");
    await expect.poll(async () => (await focused(page)).selected).toBe(2);
  });

  test("theme file overrides a token on the document; no config errors", async ({ page }) => {
    await ready(page);
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim()))
      .toBe("#3b8eea");
    const s = (await page.evaluate(() => (window as unknown as { __kw: { inspect(): { config: { errors: string[]; dir: string } } } }).__kw.inspect())).config;
    expect(s.errors).toEqual([]);
    expect(s.dir).toBe("testdata/config");
    await expect(page.getByRole("alert", { name: "config errors" })).toHaveCount(0);
  });
});

// Safety model (testdata/config/config.yaml): "tape-dev" is DEV (delete confirms),
// "tape-prod" is PROD and read-only, plain "tape" has no rule (delete still
// confirms). Go decides; the UI only shows decisions. Deletes persist in the
// shared backend, so each deleting test uses its own object (web-2, web-0)
// and the others check that nothing changed.
test.describe("safety model", () => {
  async function openStatic(page: Page, context = "") {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    if (context) await page.getByRole("combobox", { name: "context" }).selectOption(context);
    await page.getByRole("combobox", { name: "resource" }).fill("e2e-static");
    await page.keyboard.press("Enter");
    await expect.poll(async () => {
      const p = await focused(page);
      return p.spec.resource === "e2e-static" && p.status?.synced && p.rows.length > 0;
    }).toBe(true);
  }
  const pane = (page: Page) => page.locator("section[data-pane]").first();
  const marks = async (page: Page) => Object.fromEntries((await focused(page)).rows.map((r) => [r.key, r.mark ?? ""]));
  /** Selects a row by key (row order shifts as tests delete objects). */
  async function select(page: Page, key: string) {
    const rows = (await focused(page)).rows;
    await page.keyboard.press("g");
    for (let i = 0; i < rows.findIndex((r) => r.key === key); i++) await page.keyboard.press("j");
  }

  test("labeled context: badge on pane and tab; cmd+backspace confirms, esc cancels and restores focus", async ({ page }) => {
    await openStatic(page, "tape-dev");
    await expect(pane(page)).toHaveAttribute("data-context", "tape-dev");
    await expect(pane(page).getByLabel("context label")).toHaveText("DEV");
    await expect(pane(page).getByLabel("read-only")).toHaveCount(0);
    await expect(page.getByRole("tab", { selected: true })).toContainText("DEV · e2e-static");

    await select(page, "s-web-1"); // never deleted by any test
    const sel = (await focused(page)).selected;
    await page.keyboard.press("ControlOrMeta+Backspace");
    const dialog = page.getByRole("alertdialog", { name: "confirm delete" });
    await expect(dialog).toMatchAriaSnapshot(`
      - alertdialog "confirm delete":
        - heading "DEV delete?"
        - paragraph: delete e2e-static/web-1 -n shop on tape-dev
        - button "delete"
        - text: ⏎ delete · esc cancel
    `);
    expect((await inspect(page)).focus).toBe("confirm");
    const before = await marks(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect((await inspect(page)).focus).toBe("table");
    expect((await focused(page)).selected).toBe(sel);
    expect(await marks(page)).toEqual(before);
  });

  test("confirmed delete: the watch shows the row as deleted", async ({ page }) => {
    await openStatic(page);
    await expect(pane(page).getByLabel("context label")).toHaveCount(0); // no rule for "tape"
    await select(page, "s-web-2");
    // the Delete key does the same as ⌘⌫
    await page.keyboard.press("Delete");
    await page.getByRole("alertdialog", { name: "confirm delete" }).waitFor();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await marks(page))["s-web-2"]).toBe("deleted");
    await expect(pane(page).getByLabel("message")).toHaveText("deleted e2e-static/web-2");
    expect((await inspect(page)).focus).toBe("table");
  });

  test("strict context: delete needs the object name typed", async ({ page }) => {
    await openStatic(page, "tape-live");
    await select(page, "s-web-0");
    await page.keyboard.press("ControlOrMeta+Backspace");
    const dialog = page.getByRole("alertdialog", { name: "confirm delete" });
    const input = dialog.getByRole("textbox", { name: "type to confirm" });
    await expect(input).toBeFocused();
    await input.pressSequentially("web-");
    await page.keyboard.press("Enter"); // not yet: text doesn't match
    await expect(dialog).toBeVisible();
    await input.pressSequentially("0");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await marks(page))["s-web-0"]).toBe("deleted");
  });

  test("read-only context: PROD + RO badges, delete is refused without a dialog", async ({ page }) => {
    await openStatic(page, "tape-prod");
    await expect(pane(page)).toHaveAttribute("data-context", "tape-prod");
    await expect(pane(page).getByLabel("context label")).toHaveText("PROD");
    await expect(pane(page).getByLabel("read-only")).toHaveText("RO");
    const before = await marks(page);
    await page.keyboard.press("ControlOrMeta+Backspace");
    await expect(pane(page).getByLabel("message")).toContainText("read-only context");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect((await inspect(page)).overlays).toEqual([]);
    expect(await marks(page)).toEqual(before);
  });
});

test.describe("dockview layout", () => {
  const sizesOf = async (page: Page) => ((await inspect(page)).tabs[0]!.layout as { sizes?: number[] }).sizes;

  test("dragging a divider resizes; the store keeps the weights and ⌘⌥-arrows follow the geometry", async ({ page }) => {
    await openTape(page);
    await page.keyboard.press("ControlOrMeta+Shift+D"); // v1 | v2
    const sash = page.locator(".dv-sash").first();
    const box = (await sash.boundingBox())!;
    const main = (await page.locator("main").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(main.x + main.width * 0.25, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => ((await sizesOf(page))?.[0] ?? 1) < 0.35).toBe(true);
    const panes = page.locator("section[data-pane]");
    const [a, b] = [(await panes.nth(0).boundingBox())!, (await panes.nth(1).boundingBox())!];
    expect(a.width).toBeLessThan(b.width / 2);
    // focus is on v2 (the new split); ⌘⌥← goes to v1 and back
    await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    expect((await inspect(page)).focusedPane).toBe("v1");
    await page.keyboard.press("ControlOrMeta+Alt+ArrowRight");
    expect((await inspect(page)).focusedPane).toBe("v2");
  });

  test("a resized layout survives tab switches and further splits keep the other weights", async ({ page }) => {
    await openTape(page);
    await page.keyboard.press("ControlOrMeta+Shift+D");
    const sash = page.locator(".dv-sash").first();
    const box = (await sash.boundingBox())!;
    const main = (await page.locator("main").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(main.x + main.width * 0.7, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await sizesOf(page))?.map((x) => Math.round(x * 10))).toEqual([7, 3]);
    const [w1, w2] = (await sizesOf(page))!;
    await page.keyboard.press("ControlOrMeta+T");
    await page.keyboard.press("ControlOrMeta+1");
    expect(await sizesOf(page)).toEqual([w1, w2]);
    const panes = page.locator("main > div:not([hidden]) section[data-pane]");
    await expect.poll(async () => Math.round(((await panes.nth(0).boundingBox())!.width / main.width) * 10)).toBe(7);
    // splitting v1 (focused via ⌘[) halves its share; v2 keeps its own (≈ 35 / 35 / 30)
    await page.keyboard.press("ControlOrMeta+BracketLeft");
    await page.keyboard.press("ControlOrMeta+Shift+D");
    await expect.poll(async () => (await sizesOf(page))?.length).toBe(3);
    // no waits between the keys above on purpose: a tab shown and split right away
    // must lay out in its real size (it once came back as equal thirds)
    const [a, b, c] = (await sizesOf(page))!;
    expect(Math.abs(a! - w1! / 2)).toBeLessThan(0.01);
    expect(Math.abs(b! - w1! / 2)).toBeLessThan(0.01);
    expect(Math.abs(c! - w2!)).toBeLessThan(0.01);
  });

  test("⌘⇧⏎ maximizes the focused pane; the others stay open behind it and come back", async ({ page }) => {
    await openTape(page);
    await page.keyboard.press("ControlOrMeta+Shift+D"); // v1 | v2, focus v2
    const layout = (await inspect(page)).tabs[0]!.layout;
    const main = (await page.locator("main").boundingBox())!;
    // dockview collapses a hidden pane to nothing rather than display:none: measure, as the user sees it
    const share = async (id: string) => {
      const b = await page.locator(`section[data-pane="${id}"]`).boundingBox();
      return Math.round(((b?.width ?? 0) * (b?.height ?? 0) * 10) / (main.width * main.height));
    };
    await page.keyboard.press("ControlOrMeta+Shift+Enter");
    const badge = page.getByRole("button", { name: "maximized pane" });
    await expect(badge).toHaveText("⤡1");
    await expect(badge).toHaveAttribute("title", /1 other pane hidden/);
    await expect.poll(() => share("v2")).toBe(10);
    await expect.poll(() => share("v1")).toBe(0);
    // still open: its pane (and watch) are there, the layout is unchanged
    const s = await inspect(page);
    expect(s.panes.v1?.serverId).toBeTruthy();
    expect(s.tabs[0]!.layout).toEqual(layout);
    // keys still go to the maximized pane's table
    expect(s.focus).toBe("table");
    // ⌘⇧⏎ again: both back, side by side
    await page.keyboard.press("ControlOrMeta+Shift+Enter");
    await expect(badge).toBeHidden();
    await expect.poll(() => share("v1")).toBe(5);
    await expect.poll(() => share("v2")).toBe(5);
    // the badge un-maximizes too
    await page.keyboard.press("ControlOrMeta+Shift+Enter");
    await expect.poll(() => share("v1")).toBe(0);
    await badge.click();
    await expect.poll(() => share("v1")).toBe(5);
    expect((await inspect(page)).focusedPane).toBe("v2");
    // and so does moving focus to another pane
    await page.keyboard.press("ControlOrMeta+Shift+Enter");
    await expect.poll(() => share("v1")).toBe(0);
    await page.keyboard.press("ControlOrMeta+BracketLeft");
    await expect.poll(() => share("v1")).toBe(5);
    expect((await inspect(page)).focusedPane).toBe("v1");
    expect((await inspect(page)).tabs[0]!.layout).toEqual(layout);
  });

  test.describe("moving a pane by its grip", () => {
    const grip = (page: Page, id: string) => page.locator(`section[data-pane="${id}"]`).getByRole("button", { name: "move pane" });
    const center = async (page: Page, sel: string) => {
      const b = (await page.locator(sel).boundingBox())!;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
    };
    /** Presses on the pane's grip (shown by moving over the pane first) and moves to (x, y). */
    const dragFrom = async (page: Page, id: string, x: number, y: number) => {
      const p = await center(page, `section[data-pane="${id}"]`);
      await page.mouse.move(p.x, p.y);
      await page.mouse.move(p.x + 5, p.y + 5);
      await expect(grip(page, id)).toHaveAttribute("data-shown", "true");
      const g = (await grip(page, id).boundingBox())!;
      await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, y, { steps: 8 });
    };

    test("the grip shows while the mouse moves, and not with nowhere to move", async ({ page }) => {
      await openTape(page);
      await expect(grip(page, "v1")).toHaveCount(0); // the only pane of the only tab
      await page.keyboard.press("ControlOrMeta+Shift+D");
      await expect(grip(page, "v1")).not.toHaveAttribute("data-shown");
      const p = await center(page, 'section[data-pane="v1"]');
      await page.mouse.move(p.x, p.y);
      await page.mouse.move(p.x + 5, p.y);
      await expect(grip(page, "v1")).toHaveAttribute("data-shown", "true");
      await expect(grip(page, "v2")).not.toHaveAttribute("data-shown");
      // it goes again once the mouse rests
      await expect(grip(page, "v1")).not.toHaveAttribute("data-shown", { timeout: 3000 });
    });

    test("dropped on a side of another pane: it moves there with its data; esc cancels a drag", async ({ page }) => {
      await openTape(page);
      await page.keyboard.press("ControlOrMeta+Shift+D"); // v1 | v2
      await expect.poll(async () => !!(await inspect(page)).panes.v2?.serverId).toBe(true);
      const before = await inspect(page);
      // v2 onto the bottom half of v1: v1 / v2, stacked
      const v1 = await center(page, 'section[data-pane="v1"]');
      await dragFrom(page, "v2", v1.x, v1.b.y + v1.b.height * 0.85);
      await expect(page.getByLabel("drop target")).toBeVisible();
      await page.mouse.up();
      await expect(page.getByLabel("drop target")).toBeHidden();
      const s = await inspect(page);
      expect(s.tabs[0]!.layout).toEqual({ type: "split", dir: "column", children: [{ type: "pane", id: "v1" }, { type: "pane", id: "v2" }] });
      expect(s.focusedPane).toBe("v2");
      expect(s.panes.v2!.serverId).toBe(before.panes.v2!.serverId); // the same watch, not a new pane
      // esc mid-drag: nothing moves
      const top = await center(page, 'section[data-pane="v1"]');
      await dragFrom(page, "v2", top.b.x + top.b.width * 0.1, top.y);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      expect((await inspect(page)).tabs[0]!.layout).toEqual(s.tabs[0]!.layout);
    });

    test("dropped on another tab's header it goes there; holding over it shows the tab to pick a pane; + makes a new tab", async ({ page }) => {
      await openTape(page);
      await page.keyboard.press("ControlOrMeta+Shift+D"); // t1: v1 | v2
      await page.keyboard.press("ControlOrMeta+T"); // t3: v3
      await page.keyboard.press("ControlOrMeta+1");
      await expect.poll(async () => !!(await inspect(page)).panes.v2?.serverId).toBe(true);
      const server = (await inspect(page)).panes.v2!.serverId;
      // onto the header of tab 2: its right edge
      const tab2 = await center(page, '[role="tab"] >> nth=1');
      await dragFrom(page, "v2", tab2.x, tab2.y);
      await page.mouse.up();
      let s = await inspect(page);
      expect(s.activeTab).toBe(1);
      expect(s.tabs[1]!.layout).toEqual({ type: "split", dir: "row", children: [{ type: "pane", id: "v3" }, { type: "pane", id: "v2" }] });
      expect(s.tabs[0]!.layout).toEqual({ type: "pane", id: "v1" });
      expect(s.panes.v2!.serverId).toBe(server);
      await expect(page.locator("section[data-pane]")).toHaveCount(3); // mounted once, in its new tab
      await expect(page.locator('main > div:not([hidden]) section[data-pane="v2"]')).toBeVisible();
      // back: v1 dragged over tab 2's header, held until it shows, then onto the top of v3
      await page.keyboard.press("ControlOrMeta+1");
      const t2 = await center(page, '[role="tab"] >> nth=1');
      await dragFrom(page, "v1", t2.x, t2.y);
      await expect.poll(async () => (await inspect(page)).activeTab).toBe(1);
      const v3 = await center(page, 'main > div:not([hidden]) section[data-pane="v3"]');
      await page.mouse.move(v3.x, v3.b.y + v3.b.height * 0.2, { steps: 8 });
      await page.mouse.up();
      s = await inspect(page);
      // tab 1 had nothing left and closed
      expect(s.tabs.map((t) => t.id)).toEqual(["t3"]);
      expect(s.tabs[0]!.layout).toEqual({
        type: "split",
        dir: "row",
        children: [{ type: "split", dir: "column", children: [{ type: "pane", id: "v1" }, { type: "pane", id: "v3" }] }, { type: "pane", id: "v2" }],
      });
      expect(s.focusedPane).toBe("v1");
      // onto +: a tab of its own
      const plus = await center(page, 'button[aria-label="new tab"]');
      await dragFrom(page, "v2", plus.x, plus.y);
      await page.mouse.up();
      s = await inspect(page);
      expect(s.tabs.length).toBe(2);
      expect(s.tabs[1]!.layout).toEqual({ type: "pane", id: "v2" });
      expect(s.activeTab).toBe(1);
      expect(s.panes.v2!.serverId).toBe(server);
    });
  });

  test("clicking a pane focuses it", async ({ page }) => {
    await openTape(page);
    await page.keyboard.press("ControlOrMeta+Shift+D");
    expect((await inspect(page)).focusedPane).toBe("v2");
    await page.locator('section[data-pane="v1"]').click({ position: { x: 40, y: 60 } });
    expect((await inspect(page)).focusedPane).toBe("v1");
  });
});

test.describe("detail view (Monaco)", () => {
  // e-api-1 restarts at t=2s, so it has a previous version to diff against.
  // Wait for the tape's last step (recreate at t=3s) so rows don't shift while navigating.
  async function openApi1(page: Page) {
    await openTape(page);
    await afterTapeSteps(page);
    const rows = (await focused(page)).rows;
    for (let i = 0; i < rows.findIndex((r) => r.key === "e-api-1"); i++) await page.keyboard.press("j");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-viewer="single"] .monaco-editor')).toBeVisible();
  }

  test("yaml in a read-only editor; d shows the Monaco diff of prev → current", async ({ page }) => {
    await openApi1(page);
    const dialog = page.getByRole("dialog", { name: "object detail" });
    await expect(dialog.locator(".view-lines")).toContainText("name: api-1");
    await page.keyboard.press("d");
    await expect(dialog.locator('[data-viewer="diff"] .monaco-diff-editor')).toBeVisible();
    // the restart added containerStatuses: an inserted line on the modified side
    await expect(dialog.locator('[data-viewer="diff"]').locator(".line-insert, .char-insert, .gutter-insert").first()).toBeAttached();
    await page.keyboard.press("d");
    await expect(dialog.locator('[data-viewer="single"]')).toBeVisible();
  });

  test("diff: ↑/↓ buttons and j/k step through the changes; the cursor starts on the first", async ({ page }) => {
    await openApi1(page);
    const dialog = page.getByRole("dialog", { name: "object detail" });
    await page.keyboard.press("d");
    const pos = dialog.getByRole("status", { name: "change position" });
    // two changes: the annotation (top) and the restart's containerStatuses (bottom)
    await expect(pos).toHaveText("1 / 2");
    await page.keyboard.press("j");
    await expect(pos).toHaveText("2 / 2");
    await page.keyboard.press("j"); // wraps around, like VS Code
    await expect(pos).toHaveText("1 / 2");
    await page.keyboard.press("k");
    await expect(pos).toHaveText("2 / 2");
    await dialog.getByRole("button", { name: "previous change" }).click();
    await expect(pos).toHaveText("1 / 2");
    await dialog.getByRole("button", { name: "next change" }).click();
    await expect(pos).toHaveText("2 / 2");
    expect((await inspect(page)).focus).toBe("detail"); // the buttons don't take the focus
    await page.keyboard.press("k"); // so the keys still work
    await expect(pos).toHaveText("1 / 2");
    // back in the yaml view there is no change navigation
    await page.keyboard.press("d");
    await expect(dialog.getByRole("button", { name: "next change" })).toHaveCount(0);
  });

  test("⌘F opens Monaco's find (not the pane filter); esc closes find, then the view", async ({ page }) => {
    await openApi1(page);
    await page.keyboard.press("ControlOrMeta+F");
    await expect(page.locator(".find-widget.visible")).toBeVisible();
    expect((await inspect(page)).focus).toBe("detail");
    // typed text stays in the field: d/y/w/j/k/r/= are not the detail view's keys there
    await page.keyboard.type("dywjkr=");
    await expect(page.locator(".find-widget.visible textarea").first()).toHaveValue("dywjkr=");
    expect((await inspect(page)).overlays).toEqual(["detail"]); // still the yaml (d: diff), wrap untouched (w)
    await expect(page.locator('[data-viewer="single"]')).toHaveAttribute("data-wrap", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator(".find-widget.visible")).toHaveCount(0);
    expect((await inspect(page)).overlays).toEqual(["detail"]);
    await page.keyboard.press("Escape");
    expect((await inspect(page)).overlays).toEqual([]);
    expect((await inspect(page)).focus).toBe("table");
  });
});

// e2e-versions: deployment web scaled 1 → 2 (1s) → 3 (1.5s), then a new image (2s): four versions.
test("diff without recorded history: previous → current, no versions; record history is off", async ({ page }) => {
  await openTape(page, "e2e-versions", 1);
  const record = page.getByRole("button", { name: "record history" });
  await expect(record).toHaveAttribute("aria-pressed", "false");
  // after the scale-up to 3 (1.5s): the diff then has a previous version
  await expect.poll(async () => (await focused(page)).rows[0]?.cells, tapeSteps).toContain("3/3");
  await page.keyboard.press("Enter");
  await page.keyboard.press("d");
  const dialog = page.getByRole("dialog", { name: "object detail" });
  await expect(dialog.locator('[data-viewer="diff"] .monaco-diff-editor')).toBeVisible();
  await expect(dialog).toContainText("previous → current");
  await expect(dialog.getByRole("status", { name: "diff versions" })).toHaveCount(0);
  await page.keyboard.press("["); // nothing to step to
  expect((await inspect(page)).overlays).toEqual(["detail"]);
});

test("diff versions: record history (⇧R), then [ / ] step through it, the changed fields above the diff", async ({ page }) => {
  await openTape(page, "e2e-versions", 1);
  // before the tape's first change (1s): the current object is the first version
  await page.keyboard.press("Shift+R");
  const record = page.getByRole("button", { name: "record history" });
  await expect(record).toHaveAttribute("aria-pressed", "true");
  await expect(record).toHaveText(/recording/);
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-viewer="single"] .monaco-editor')).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "object detail" });
  const versions = dialog.getByRole("status", { name: "diff versions" });
  const changed = dialog.getByRole("list", { name: "changed fields" });
  await page.keyboard.press("d");
  // the diff follows the newest version until the image change has come in
  await expect(versions).toContainText("v3", tapeSteps);
  // the header stays one line even when narrow, versions and change navigation in it (the key hints give way)
  await page.setViewportSize({ width: 900, height: 700 });
  const header = dialog.locator("> div").first();
  const lineHeight = async () => (await header.evaluate((el) => el.getBoundingClientRect().height)) / (await dialog.getByText("diff (normalized)").evaluate((el) => el.getBoundingClientRect().height));
  await expect.poll(lineHeight).toBeLessThan(1.8);
  await page.setViewportSize({ width: 1400, height: 800 }); // the config's
  await expect(versions).toContainText("v4 ");
  await expect(versions).toContainText("newest");
  await expect(changed).toHaveText('spec.template.spec.containers[name=app].image: "web:1" → "web:2"');
  await page.keyboard.press("[");
  await expect(versions).toContainText("v2");
  await expect(versions).toContainText("1 newer");
  await expect(changed).toHaveText("spec.replicas: 2 → 3");
  const diff = dialog.locator('[data-viewer="diff"]');
  await expect(diff.locator(".editor.original .view-lines")).toContainText("replicas: 2");
  await expect(diff.locator(".editor.modified .view-lines")).toContainText("replicas: 3");
  // quick presses add up (each steps from the version asked for, not the one loaded)
  await page.keyboard.press("[");
  await page.keyboard.press("[");
  // the oldest: nothing before it, and [ stops there
  await expect(versions).toHaveText(/^v1 \(\d+s ago\) · 3 newer$/);
  await expect(dialog).toContainText("version 1 is the oldest seen since watch start");
  await expect(dialog.getByRole("button", { name: "older version" })).toBeDisabled();
  await page.keyboard.press("[");
  expect((await inspect(page)).overlays).toEqual(["detail"]);
  await expect(versions).toHaveText(/^v1 /);
  // the buttons don't take the focus; ] back to the newest
  await dialog.getByRole("button", { name: "newer version" }).click();
  await expect(changed).toHaveText("spec.replicas: 1 → 2");
  expect((await inspect(page)).focus).toBe("detail");
  await page.keyboard.press("]");
  await page.keyboard.press("]");
  await expect(versions).toContainText("newest");
  await expect(dialog.getByRole("button", { name: "newer version" })).toBeDisabled();
  // d leaves the diff; back in, it starts at the newest again
  await page.keyboard.press("[");
  await page.keyboard.press("d");
  await expect(versions).toHaveCount(0);
  await page.keyboard.press("d");
  await expect(versions).toContainText("newest");
  // stopped (the status line's button), the history goes: back to previous → current
  await page.keyboard.press("Escape");
  await record.click();
  await expect(record).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Enter");
  await page.keyboard.press("d");
  await expect(dialog).toContainText("previous → current");
  await expect(versions).toHaveCount(0);
});

// e2e-travel: READY 1/1 → 2/2 (5s) → 3/3 (5.5s), then the image changes (6s), on the
// clock of the watch. Each test opens its own namespace: its own watch (the backend is
// shared), so the tape and the history start fresh. record: ⇧R as soon as the pane is
// there, well before the first change.
test.describe("time-travel", () => {
  async function openTravel(page: Page, record = false) {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    await page.getByRole("combobox", { name: "resource" }).fill("e2e-travel");
    await page.getByRole("combobox", { name: "namespace" }).fill(`travel-${test.info().testId.slice(0, 8)}`);
    await page.getByRole("combobox", { name: "resource" }).press("Enter");
    if (record) {
      await expect.poll(async () => (await focused(page)).spec.resource === "e2e-travel" && !!(await focused(page)).serverId).toBe(true);
      await page.keyboard.press("Shift+R");
    }
    await expect
      .poll(async () => {
        const p = await focused(page);
        return p.spec.resource === "e2e-travel" && !!p.serverId && p.status?.synced ? p.total : -1;
      })
      .toBe(1);
  }
  const readyCell = async (page: Page) => (await focused(page)).rows[0]?.cells.find((c) => /^\d\/\d$/.test(c));
  const timeline = (page: Page) => page.getByRole("status", { name: "timeline" });
  // recording from the start, then all three changes in
  async function recorded(page: Page) {
    await openTravel(page, true);
    await expect(page.getByRole("button", { name: "record history" })).toHaveAttribute("aria-pressed", "true");
    // recording began before the first change: all three are on the timeline later
    expect(await readyCell(page)).toBe("1/1");
    await expect.poll(async () => (await focused(page)).rows[0]?.cells.join(" "), tapeSteps).toContain("3/3");
    // the image change (4s) comes after the scale to 3: in the YAML once it's there
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "object detail" }).locator(".view-lines")).toContainText("web:2", tapeSteps);
    await page.keyboard.press("Escape");
  }

  test("t goes to the newest change; ←/→ step through the table as it was, esc back to live", async ({ page }) => {
    await recorded(page);
    await page.keyboard.press("t");
    await expect(timeline(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "time-travel" })).toBeVisible();
    await expect(timeline(page)).toContainText("3 changes");
    expect(await readyCell(page)).toBe("3/3"); // the newest change is the image: 3 ready then
    // one step at a time: each waits for the moment to move (quick presses would add up)
    const moment = async () => (await focused(page)).status?.at ?? "";
    const step = async (key: string) => {
      const before = await moment();
      await page.keyboard.press(key);
      await expect.poll(moment).not.toBe(before);
    };
    await step("ArrowLeft"); // the scale to 3
    expect(await readyCell(page)).toBe("3/3");
    await step("ArrowLeft"); // the scale to 2
    await expect.poll(() => readyCell(page)).toBe("2/2");
    await step("ArrowLeft"); // the start
    await expect.poll(() => readyCell(page)).toBe("1/1");
    // the step marks the changed cell
    await step("ArrowRight");
    await expect.poll(() => readyCell(page)).toBe("2/2");
    await expect.poll(async () => (await focused(page)).rows[0]?.changed?.length ?? 0).toBeGreaterThan(0);
    // the table keys still work in the past: the YAML is the version then (no timeline in there)
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "object detail" });
    await expect(dialog.locator(".view-lines")).toContainText("replicas: 2");
    await expect(dialog.getByRole("status", { name: "timeline" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // → past the newest change stays at it (only esc leaves); the bar shows the history's size
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
    await expect.poll(() => readyCell(page)).toBe("3/3");
    await expect(timeline(page)).toBeVisible();
    await expect(timeline(page).getByLabel("history size")).toHaveText(/^\d+(\.\d)? (B|KiB) \/ 512 MiB$/);
    // esc: back to live, the timeline goes
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await focused(page)).status?.at ?? "").toBe("");
    await expect(timeline(page)).toHaveCount(0);
    expect(await readyCell(page)).toBe("3/3");
  });

  test("t without recording starts it; a click on the timeline goes there", async ({ page }) => {
    await openTravel(page);
    await page.keyboard.press("t"); // starts recording: the timeline begins now
    // the timeline replaces the status line, with its own record button and the messages
    await expect(timeline(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "record history" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("message")).toContainText("recording history from now on");
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await focused(page)).rows[0]?.cells.join(" "), tapeSteps).toContain("3/3");
    await page.keyboard.press("t");
    // the bar has its span and ticks before the click maps onto it
    await expect(timeline(page)).toContainText("3 changes");
    const slider = page.getByRole("slider", { name: "moment" });
    const box = (await slider.boundingBox())!;
    await page.mouse.click(box.x + 1, box.y + box.height / 2); // the far left: the start
    await expect.poll(() => readyCell(page)).toBe("1/1");
    expect((await inspect(page)).focus).toBe("table"); // the bar doesn't take the focus
    // the header badge goes back to live
    await page.getByRole("button", { name: "time-travel" }).click();
    await expect.poll(async () => (await focused(page)).status?.at ?? "").toBe("");
  });

  test("⇧H in the YAML: the field's values over time, ⏎ takes the table there", async ({ page }) => {
    await recorded(page);
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "object detail" });
    await expect(dialog.locator(".view-lines")).toContainText("replicas: 3");
    // the cursor onto the replicas line
    await dialog.locator(".view-line", { hasText: "replicas: 3" }).click();
    await page.keyboard.press("Shift+H");
    const field = page.getByRole("dialog", { name: "field history" });
    const values = field.getByRole("menuitem");
    await expect(values).toHaveCount(3);
    await expect(field).toContainText("spec.replicas");
    await expect(values.nth(0)).toContainText("1");
    await expect(values.nth(2)).toContainText("3");
    // esc: back to the YAML
    await page.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(dialog).toBeVisible();
    // the header says what ⇧H does; the editor's right-click menu has it too (on the line clicked)
    await expect(dialog).toContainText("⇧H: field at cursor over time");
    await dialog.locator(".view-line", { hasText: "replicas: 3" }).click({ button: "right" });
    await expect(page.locator(".monaco-menu .action-item", { hasText: "history of this field" })).toBeVisible();
    // the entries: Copy, then ours; the keyboard runs it as a user would
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(values).toHaveCount(3);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Shift+H");
    await expect(values).toHaveCount(3); // loaded: the keys go to the list now
    await page.keyboard.press("k"); // the change to 2
    await expect(values.nth(1)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Enter");
    await expect(field).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => readyCell(page)).toBe("2/2");
    await expect(timeline(page)).toBeVisible();
  });
});

// Object actions on the static tape: web-1 (2 containers, ports 8080/9090), web-3 (1 container),
// web-4 (init, sidecar, crash-looping and running containers), cfg (a ConfigMap).
test.describe("object actions", () => {
  async function openStatic(page: Page, context = "") {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    if (context) await page.getByRole("combobox", { name: "context" }).selectOption(context);
    await page.getByRole("combobox", { name: "resource" }).fill("e2e-static");
    await page.keyboard.press("Enter");
    await expect.poll(async () => {
      const p = await focused(page);
      return p.spec.resource === "e2e-static" && p.status?.synced && p.rows.some((r) => r.key === "s-web-1");
    }).toBe(true);
  }
  async function select(page: Page, key: string) {
    const rows = (await focused(page)).rows;
    await page.keyboard.press("g");
    for (let i = 0; i < rows.findIndex((r) => r.key === key); i++) await page.keyboard.press("j");
  }
  const termText = (page: Page) => page.locator("[data-terminal] .xterm-rows").innerText();

  // web-3 is the tape's only healthy pod; the config maps aren't pods and stay
  test("h hides healthy pods, the header checkbox shows and toggles it", async ({ page }) => {
    await openStatic(page);
    const box = page.getByRole("checkbox", { name: "hide healthy" });
    const keys = async () => (await focused(page)).rows.map((r) => r.key);
    await expect(box).not.toBeChecked();
    expect(await keys()).toContain("s-web-3");
    await page.keyboard.press("h");
    await expect(box).toBeChecked();
    await expect.poll(keys).not.toContain("s-web-3");
    expect(await keys()).toEqual(expect.arrayContaining(["s-web-1", "s-web-4", "s-cfg"]));
    await box.click();
    await expect.poll(keys).toContain("s-web-3");
    // the click leaves the keys with the table
    expect((await inspect(page)).focus).toBe("table");
    await page.keyboard.press("h");
    await expect(box).toBeChecked();
  });

  // e2e-deploys: api's rollout is complete, web is mid-rollout, worker has an unavailable replica
  test("h hides deployments whose rollout is complete; kinds without a health check get no checkbox", async ({ page }) => {
    await openTape(page, "e2e-deploys");
    const box = page.getByRole("checkbox", { name: "hide healthy" });
    await expect(page.locator("label", { has: box })).toHaveAttribute("title", /deployments whose replicas/);
    await page.keyboard.press("h");
    await expect.poll(async () => (await focused(page)).rows.map((r) => r.key)).toEqual(["d-web", "d-worker"]);
    await page.keyboard.press("ControlOrMeta+O");
    await page.getByRole("combobox", { name: "resource" }).fill("nodes");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await focused(page)).status?.synced).toBe(true);
    await expect(box).toHaveCount(0);
    // the toggle carried over with the spec turns off; turning it on again is refused here
    await page.keyboard.press("h");
    expect((await focused(page)).spec).not.toMatchObject({ hideHealthy: true });
    await page.keyboard.press("h");
    await expect(page.getByLabel("message")).toContainText("hiding healthy works on pods, deployments");
  });

  test("d describes in Monaco; y back to yaml", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    await page.keyboard.press("d");
    const dialog = page.getByRole("dialog", { name: "object detail" });
    await expect(dialog).toContainText("describe");
    await expect(dialog.locator(".view-lines")).toContainText("Name:         web-1");
    await expect(dialog.locator(".view-lines")).toContainText("app=web");
    await page.keyboard.press("y");
    await expect(dialog.locator(".view-lines")).toContainText("apiVersion: v1");
    await page.keyboard.press("Escape");
    expect((await inspect(page)).overlays).toEqual([]);
  });

  test("describe diff: d compares with the previous look (times ignored), r takes a new look", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    const dialog = page.getByRole("dialog", { name: "object detail" });
    // the look counter of the tape's fake "Looked" event, from the loaded describe (not the virtualized DOM)
    const count = async () =>
      Number(((await page.evaluate(() => (window as any).__kw.inspect().describe?.text)) ?? "").match(/\(x(\d+) over/)?.[1] ?? 0);
    await page.keyboard.press("d");
    await expect.poll(count).toBeGreaterThan(0);
    const n = await count();
    // d toggles to the diff without taking a new look
    await page.keyboard.press("d");
    if (n === 1) await expect(dialog).toContainText("nothing to compare yet"); // first look this session
    await page.keyboard.press("d");
    expect(await count()).toBe(n); // still the same look
    // r: a new look; its diff against the previous one shows the count change only
    await page.keyboard.press("r");
    await expect.poll(count).toBe(n + 1);
    await page.keyboard.press("d");
    const diff = dialog.locator('[data-viewer="diff"]');
    await expect(diff.locator(".monaco-diff-editor")).toBeVisible();
    await expect(dialog).toContainText(/describe diff \(look \d+s ago → now, times ignored\)/);
    await expect(diff.locator(".editor.original .view-lines")).toContainText(`(x${n})`);
    await expect(diff.locator(".editor.modified .view-lines")).toContainText(`(x${n + 1})`);
    // ages are blanked on both sides: no "7s"/"14s" anywhere
    await expect(diff.locator(".view-lines").first()).not.toContainText(/\d+s \(x/);
    // exactly one changed line pair (the event row)
    await expect.poll(() => diff.locator(".line-insert, .char-insert").count()).toBeGreaterThan(0);
    await page.keyboard.press("d");
    await page.waitForTimeout(200);
    expect(await count()).toBe(n + 1); // toggling back didn't take another look
    await page.keyboard.press("Escape");
  });

  // web-3 has a single container: e goes straight to its shell
  test("x opens a terminal pane below; keys go to the shell; ⌘W is still the tab's", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-3");
    await page.keyboard.press("x");
    await expect.poll(async () => (await inspect(page)).focus).toBe("terminal");
    const s = await inspect(page);
    const termPane = s.panes[s.focusedPane] as unknown as { term?: { session: string; pod: string; container: string } };
    expect(termPane.term).toMatchObject({ pod: "web-3", container: "app" });
    await expect(page.locator("section[data-pane] header").filter({ hasText: "exec" })).toContainText("web-3/app");
    await expect.poll(() => termText(page)).toContain("web-3:app$");
    // j and / are table keys; in a terminal they are just typed
    await page.keyboard.type("echo j/k");
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page)).toContain("echo j/k\necho j/k");
    expect((await inspect(page)).overlays).toEqual([]);
    expect((await focused(page)).selected).toBe(0); // the table selection didn't move
    // ⌘ chords still reach the app: ⌘W closes the tab, as in a table pane (two panes, so it asks)
    await page.keyboard.press("ControlOrMeta+W");
    expect((await inspect(page)).overlays).toEqual(["closeTab"]);
    await page.keyboard.press("Escape");
    expect((await inspect(page)).focus).toBe("terminal");
    await page.keyboard.press("ControlOrMeta+W");
    await page.keyboard.press("Enter");
    const after = await inspect(page);
    expect(after.tabs).toHaveLength(1);
    expect(Object.values(after.panes).some((p) => (p as { term?: unknown }).term)).toBe(false);
  });

  test("a terminal pane dragged into a new tab keeps its shell and screen; keys still go to it", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-3");
    await page.keyboard.press("x");
    await expect.poll(() => termText(page)).toContain("web-3:app$");
    await page.keyboard.type("echo before");
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page)).toContain("echo before\necho before");
    const id = (await inspect(page)).focusedPane;
    const session = (await focused(page) as unknown as { term: { session: string } }).term.session;
    const pane = (await page.locator(`section[data-pane="${id}"]`).boundingBox())!;
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
    await page.mouse.move(pane.x + pane.width / 2 + 5, pane.y + pane.height / 2);
    const g = (await page.locator(`section[data-pane="${id}"]`).getByRole("button", { name: "move pane" }).boundingBox())!;
    const plus = (await page.getByRole("button", { name: "new tab" }).boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(plus.x + plus.width / 2, plus.y + plus.height / 2, { steps: 8 });
    await page.mouse.up();
    const s = await inspect(page);
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs[1]!.layout).toEqual({ type: "pane", id });
    expect(s.focus).toBe("terminal");
    expect((await focused(page) as unknown as { term: { session: string } }).term.session).toBe(session);
    await expect(page.locator("[data-terminal]")).toHaveCount(1);
    // the screen is replayed in its new place, and the shell is the same one
    await expect.poll(() => termText(page)).toContain("echo before\necho before");
    await page.keyboard.type("echo after");
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page)).toContain("echo after\necho after");
  });

  test("the terminal keeps terminal.scrollback lines (config.yaml: 20000), more than the old 5000", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-3");
    await page.keyboard.press("x");
    await expect.poll(() => termText(page)).toContain("$");
    await page.keyboard.type("seq 12000");
    await page.keyboard.press("Enter");
    const term = async () => {
      const s = await inspect(page);
      const id = (s.panes[s.focusedPane] as unknown as { term: { session: string } }).term.session;
      return (s as unknown as { terminals: Record<string, { scrollback: number; lines: number; first?: string }> }).terminals[id]!;
    };
    await expect.poll(async () => (await term()).lines).toBeGreaterThan(12000);
    const t = await term();
    expect(t.scrollback).toBe(20000);
    expect(t.first).toBe("tape shell in shop/web-3"); // nothing dropped yet: the first line is still there
    await page.keyboard.press("Control+D");
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
  });

  test("⌘F finds in the terminal (as Monaco's find): live, ⏎ / ⇧⏎ / ⌘G step, options, esc back to the shell", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-3");
    await page.keyboard.press("x");
    await expect.poll(() => termText(page)).toContain("$");
    await page.keyboard.type("seq 300");
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page)).toContain("300");
    await page.keyboard.press("ControlOrMeta+F");
    const bar = page.getByRole("search", { name: "find in terminal" });
    const field = bar.getByRole("textbox", { name: "find" });
    await expect(field).toBeFocused();
    expect((await inspect(page)).focus).toBe("termfind");
    // live: lines containing 25 — 25, 125, 225, 250 … 259
    await page.keyboard.type("25");
    await expect(bar.getByLabel("matches")).toHaveText(/^\d+ of 13$/);
    const at = async () => Number((await bar.getByLabel("matches").innerText()).split(" ")[0]);
    const first = await at();
    await page.keyboard.press("Enter"); // ⏎: next, not typed into the field and not sent to the shell
    await expect.poll(at).toBe((first % 13) + 1);
    await expect(field).toHaveValue("25");
    await page.keyboard.press("Shift+Enter");
    await expect.poll(at).toBe(first);
    await page.keyboard.press("ControlOrMeta+G");
    await expect.poll(at).toBe((first % 13) + 1);
    // whole word: only the line "25" itself
    await bar.getByRole("button", { name: /whole word/ }).click();
    await expect(bar.getByLabel("matches")).toHaveText("1 of 1");
    await expect(field).toBeFocused(); // toggles keep the focus in the field
    await bar.getByRole("button", { name: /whole word/ }).click();
    // a click into the terminal: the bar stays, but ⏎ is the shell's again
    await page.locator(".xterm").click();
    await expect.poll(async () => (await inspect(page)).focus).toBe("terminal");
    await expect(bar).toBeVisible();
    await page.keyboard.type("echo hi");
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page)).toContain("$ echo hi\necho hi"); // not a find step
    await field.click();
    expect((await inspect(page)).focus).toBe("termfind");
    // regex (⌥⌘R): lines that are exactly 2 digits starting with 9 — 90 … 99
    await field.fill("^9\\d$");
    await page.keyboard.press("Alt+Meta+R");
    await expect(bar.getByRole("button", { name: /regular expression/ })).toHaveAttribute("aria-pressed", "true");
    await expect(bar.getByLabel("matches")).toHaveText(/ of 10$/);
    await field.fill("no such text");
    await expect(bar.getByLabel("matches")).toHaveText("no results");
    // Esc: bar closed, the shell has the keys again
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
    expect((await inspect(page)).focus).toBe("terminal");
    await page.keyboard.type("echo back");
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page)).toContain("$ echo back\necho back"); // the tape shell echoes the line
    // ⌘F again: the last query and options are still there
    await page.keyboard.press("ControlOrMeta+F");
    await expect(field).toHaveValue("no such text");
    await expect(bar.getByRole("button", { name: /regular expression/ })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+D");
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
  });

  test("⌃D in the shell ends the session and closes the pane", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-3");
    await page.keyboard.press("x");
    await expect.poll(() => termText(page)).toContain("$");
    // the tape's shell ends on EOF, like a real one
    await page.keyboard.press("Control+D");
    await expect.poll(async () => Object.values((await inspect(page)).panes).some((p) => (p as { term?: unknown }).term)).toBe(false);
    const s = await inspect(page);
    expect(s.focus).toBe("table");
    expect(Object.keys(s.panes)).toHaveLength(1);
  });

  test("⌃⇧D closes the shell pane even when the shell ignores ⌃D", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-3");
    await page.keyboard.press("x");
    await expect.poll(() => termText(page)).toContain("$");
    await page.keyboard.type("x"); // the tape shell ignores ⌃D on a non-empty line, like a busy one
    await page.keyboard.press("Control+D");
    expect(Object.values((await inspect(page)).panes).some((p) => (p as { term?: unknown }).term)).toBe(true);
    await page.keyboard.press("Control+Shift+D");
    await expect.poll(async () => Object.values((await inspect(page)).panes).some((p) => (p as { term?: unknown }).term)).toBe(false);
    const s = await inspect(page);
    expect(s.focus).toBe("table");
    expect(s.tabs).toHaveLength(1);
  });

  test("exit in the shell closes the pane too", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-3");
    await page.keyboard.press("x");
    await expect.poll(() => termText(page)).toContain("$");
    await page.keyboard.type("exit 2");
    await page.keyboard.press("Enter");
    await expect.poll(async () => Object.values((await inspect(page)).panes).some((p) => (p as { term?: unknown }).term)).toBe(false);
    expect((await inspect(page)).focus).toBe("table");
  });
  test("x on a pod with several containers asks which one; the default is highlighted", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-4");
    await page.keyboard.press("x");
    const picker = page.getByRole("menu", { name: "exec into web-4" });
    await expect(picker).toMatchAriaSnapshot(`
      - menu "exec into web-4":
        - text: exec into web-4
        - menuitem "app running · default"
        - menuitem "worker CrashLoopBackOff" [disabled]
        - menuitem "setup init · Completed" [disabled]
        - menuitem "proxy sidecar · running"
        - text: ⏎ exec · esc cancel
    `);
    expect((await inspect(page)).focus).toBe("menu");
    await expect(picker.locator("[data-active]")).toContainText("app");
    // j skips the containers that aren't running; at the end it stays
    await page.keyboard.press("j");
    await expect(picker.locator("[data-active]")).toContainText("proxy");
    await page.keyboard.press("j");
    await expect(picker.locator("[data-active]")).toContainText("proxy");
    await page.keyboard.press("Enter");
    await expect(picker).toHaveCount(0);
    await expect.poll(async () => (await inspect(page)).focus).toBe("terminal");
    const s = await inspect(page);
    expect((s.panes[s.focusedPane] as unknown as { term?: { container: string } }).term).toMatchObject({ container: "proxy" });
    await expect.poll(() => termText(page)).toContain("web-4:proxy$");
    await page.keyboard.press("Control+D");
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
  });

  test("container picker: x ⏎ enters the default; esc cancels without a session", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-4");
    const sel = (await focused(page)).selected;
    await page.keyboard.press("x");
    const picker = page.getByRole("menu", { name: "exec into web-4" });
    await expect(picker).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    expect((await inspect(page)).focus).toBe("table");
    expect((await focused(page)).selected).toBe(sel);
    expect(Object.values((await inspect(page)).panes).some((p) => (p as { term?: unknown }).term)).toBe(false);
    // the same key twice: the highlighted default
    await page.keyboard.press("x");
    await expect(picker).toBeVisible();
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page)).toContain("web-4:app$");
    await page.keyboard.press("Control+D");
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
  });

  test("container picker, then the confirmation naming the container (dev context)", async ({ page }) => {
    await openStatic(page, "tape-dev");
    await select(page, "s-web-1");
    await page.keyboard.press("x");
    const picker = page.getByRole("menu", { name: "exec into web-1" });
    await picker.getByRole("menuitem", { name: /sidecar/ }).click();
    const confirm = page.getByRole("alertdialog", { name: "confirm exec" });
    await expect(confirm).toContainText("exec e2e-static/web-1 -n shop on tape-dev (container sidecar)");
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page)).toContain("web-1:sidecar$");
    await page.keyboard.press("Control+D");
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
  });

  // b: debug container. The tape fake runs the echo shell in it (prompt pod:debugger-xxxxx) and fails images "fail/…".
  test("b asks for the image (prefilled from config.yaml), target and profile; the shell opens below", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1"); // never deleted (web-0 is, by an earlier test)
    await page.keyboard.press("b");
    const dialog = page.getByRole("dialog", { name: "debug container" });
    const image = dialog.getByRole("combobox", { name: "image" });
    await expect(image).toHaveValue("nicolaka/netshoot");
    await expect(image).toBeFocused();
    // focusing doesn't open the suggestions; typing or ↓ does
    await expect(image).toHaveAttribute("aria-expanded", "false");
    await expect(dialog.getByRole("listbox", { name: "image suggestions" })).toHaveCount(0);
    expect((await inspect(page)).focus).toBe("dialog");
    await image.fill("busybox:1.36");
    // target and profile are completion fields too: the pod's default container is preselected
    const target = dialog.getByRole("combobox", { name: "target" });
    await expect(target).toHaveValue("app");
    await page.keyboard.press("Tab"); // the image list is open from typing: ⇥ accepts there and stays
    await target.focus();
    await page.keyboard.press("ArrowDown"); // every container, with kind, state and the default
    await expect(dialog.getByRole("listbox", { name: "target suggestions" }).getByRole("option")).toHaveText(["appdefault", "sidecar"]); // web-1 reports no state
    await target.pressSequentially("sid");
    await page.keyboard.press("Tab"); // completes to the match
    await expect(target).toHaveValue("sidecar");
    const profile = dialog.getByRole("combobox", { name: "profile" });
    await expect(profile).toHaveValue("general");
    await profile.focus();
    await page.keyboard.press("ArrowDown");
    const profiles = dialog.getByRole("listbox", { name: "profile suggestions" });
    await expect(profiles.getByRole("option")).toHaveCount(5);
    // a narrow field: every name stays readable (the long hints give way), no sideways scrolling
    for (const name of await profiles.locator("li > span:first-child").all()) {
      expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth && el.clientWidth > 0)).toBe(true);
    }
    expect(await profiles.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await profile.pressSequentially("net");
    await expect(dialog).not.toContainText("SYS_PTRACE"); // a half-typed name has no hint
    // ⏎ on the highlighted suggestion only takes it; the dialog stays
    await page.keyboard.press("Enter");
    await expect(profile).toHaveValue("netadmin");
    await expect(dialog.getByRole("listbox", { name: "profile suggestions" })).toHaveCount(0);
    await expect(dialog).toContainText("NET_ADMIN + NET_RAW");
    // the next ⏎ starts (from any field)
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await inspect(page)).focus).toBe("terminal");
    const s = await inspect(page);
    const term = (s.panes[s.focusedPane] as unknown as { term: { container: string; debug?: { image: string; target?: string } } }).term;
    expect(term.container).toMatch(/^debugger-[a-z0-9]{5}$/);
    expect(term.debug).toEqual({ image: "busybox:1.36", target: "sidecar" });
    const header = page.locator("section[data-pane] header").filter({ hasText: "debug" });
    await expect(header).toContainText(`web-1/${term.container}`);
    await expect(header).toContainText("busybox:1.36 · target sidecar");
    await expect.poll(() => termText(page)).toContain(`web-1:${term.container}$`);
    // what the kubelet reports until the container runs (image pull …)
    expect(await termText(page)).toContain('Pulling: Pulling image "busybox:1.36"');
    expect(await termText(page)).toContain('profile netadmin, target "sidecar"');
    await page.keyboard.press("Control+D");
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
  });

  test("debug: images that started are offered next time (history); esc cancels", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-3");
    await page.keyboard.press("b");
    const dialog = page.getByRole("dialog", { name: "debug container" });
    const image = dialog.getByRole("combobox", { name: "image" });
    await image.fill("alpine:3.20");
    await image.press("Enter");
    await expect.poll(() => termText(page)).toContain("$");
    await page.keyboard.press("Control+D");
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
    // a failed image isn't remembered
    await page.keyboard.press("b");
    await image.fill("fail/nope");
    await image.press("Enter");
    await expect(page.getByLabel("session ended")).toContainText("ImagePullBackOff");
    await page.keyboard.press("Control+D"); // the pane stays with the reason until closed
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
    await page.keyboard.press("b");
    await expect(image).toHaveValue("nicolaka/netshoot"); // the configured default still wins
    await expect(dialog.getByRole("listbox", { name: "image suggestions" })).toHaveCount(0);
    await page.keyboard.press("ArrowDown"); // ↓ browses them
    const offered = await dialog.getByRole("listbox", { name: "image suggestions" }).getByRole("option").allInnerTexts();
    expect(offered[0]).toContain("nicolaka/netshoot");
    expect(offered[0]).toContain("config.yaml");
    expect(offered.some((o) => o.includes("alpine:3.20"))).toBe(true);
    expect(offered.some((o) => o.includes("fail/nope"))).toBe(false);
    // history entries have a ✕ (mouse only: keys are typing here); the configured image belongs to config.yaml
    const list = dialog.getByRole("listbox", { name: "image suggestions" });
    await expect(list.getByRole("button", { name: "remove nicolaka/netshoot" })).toHaveCount(0);
    await expect(list.getByRole("button", { name: "remove alpine:3.20" })).toBeVisible();
    // ✕ removes it at once; the list stays open, the field keeps focus and its text
    await list.getByRole("button", { name: "remove busybox:1.36" }).click(); // from the first debug test
    await expect(list).not.toContainText("busybox:1.36");
    await expect(list).toContainText("alpine:3.20");
    await expect(image).toBeFocused();
    await expect(image).toHaveValue("nicolaka/netshoot");
    // gone for good: the next dialog doesn't offer it either
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press("b");
    await expect(image).toBeFocused(); // b opens the dialog after a round trip: ↓ before that would go to the table
    await page.keyboard.press("ArrowDown");
    await expect(list).toContainText("alpine:3.20");
    await expect(list).not.toContainText("busybox:1.36");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    // ⏎ on a suggestion takes it into the field and closes the list; nothing starts yet
    await image.fill("nicolaka");
    await expect(list.getByRole("option", { selected: true })).toContainText("nicolaka/netshoot");
    await page.keyboard.press("Enter");
    await expect(image).toHaveValue("nicolaka/netshoot");
    await expect(dialog.getByRole("listbox", { name: "image suggestions" })).toHaveCount(0);
    await expect(dialog).toBeVisible();
    // an empty image is refused in the dialog
    await image.fill(" ");
    await image.press("Enter");
    await expect(dialog.getByRole("alert")).toHaveText("an image is needed, e.g. busybox");
    // as in ⌘O: an open suggestion list closes first, the next Esc closes the dialog
    await page.keyboard.press("Escape");
    await expect(dialog.getByRole("listbox", { name: "image suggestions" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect((await inspect(page)).focus).toBe("table");
    expect(Object.values((await inspect(page)).panes).some((p) => (p as { term?: unknown }).term)).toBe(false);
  });

  test("debug on a dev context: the confirmation names image, profile and target", async ({ page }) => {
    await openStatic(page, "tape-dev");
    await select(page, "s-web-1");
    await page.keyboard.press("b");
    const dialog = page.getByRole("dialog", { name: "debug container" });
    // a typo is refused in the dialog; an empty target is none
    const target = dialog.getByRole("combobox", { name: "target" });
    await target.fill("nope");
    await target.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText('no container "nope" to target (app, sidecar; empty = none)');
    await target.fill("");
    await target.press("Enter");
    const confirm = page.getByRole("alertdialog", { name: "confirm debug" });
    await expect(confirm).toContainText("debug e2e-static/web-1 -n shop on tape-dev (image nicolaka/netshoot, profile general)");
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page)).toContain('target ""');
    await page.keyboard.press("Control+D");
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
  });

  test("debug is refused on read-only contexts and non-pods, without a dialog", async ({ page }) => {
    await openStatic(page, "tape-prod");
    await select(page, "s-web-1");
    await page.keyboard.press("b");
    await expect(page.getByLabel("message")).toContainText("read-only context");
    await expect(page.getByRole("dialog", { name: "debug container" })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+O");
    await page.getByRole("combobox", { name: "context" }).selectOption("tape-dev");
    await page.getByRole("combobox", { name: "resource" }).fill("e2e-static");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await focused(page)).rows.some((r) => r.key === "s-cfg")).toBe(true);
    await select(page, "s-cfg");
    await page.keyboard.press("b");
    await expect(page.getByLabel("message")).toContainText("debug needs a pod, not configmap");
  });

  // ⌥⌘O: ops pod on a node. Nodes complete from the nodes tape (Go's shared nodes watch); the tape
  // fake runs the echo shell (prompt node:ops-pod-…), names the shell command and fails images "fail/…".
  test("⌥⌘O on a pod: its node is prefilled, nodes listed, checkboxes set the pod; the shell opens below", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-3"); // runs on ip-10-0-2-22 (nodes.yaml)
    await page.keyboard.press("ControlOrMeta+Alt+O");
    const dialog = page.getByRole("dialog", { name: "node shell" });
    const node = dialog.getByRole("combobox", { name: "node" });
    await expect(node).toHaveValue("ip-10-0-2-22.ec2.internal");
    await expect(node).toBeFocused();
    expect((await inspect(page)).focus).toBe("dialog");
    // the nodes are listed right away, with pool, zone and state; nothing highlighted (⏎ takes the prefilled one)
    const list = dialog.getByRole("listbox", { name: "node suggestions" });
    await expect(list.getByRole("option")).toHaveCount(3);
    await expect(list.getByRole("option", { selected: true })).toHaveCount(0);
    await expect(list).toContainText("worker-a · eu-1b · cordoned");
    await expect(list).toContainText("not ready (unknown) · etcd · eu-1c");
    // highlighting the prefilled node and pressing ⏎ only takes it (closes the list), doesn't launch
    await page.keyboard.press("ArrowDown");
    await expect(list.getByRole("option", { selected: true })).toHaveText(/ip-10-0-1-11/);
    await node.fill("ip-10-0-2-22.ec2.internal"); // back to the prefilled one; it's the highlighted option
    await page.keyboard.press("ArrowDown");
    await expect(list.getByRole("option", { selected: true })).toContainText("ip-10-0-2-22.ec2.internal");
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("listbox", { name: "node suggestions" })).toHaveCount(0); // list closed
    await expect(dialog).toBeVisible(); // not launched
    expect((await inspect(page)).focus).toBe("dialog");
    await expect(node).toHaveValue("ip-10-0-2-22.ec2.internal");
    // config.yaml's image; nothing ran yet: host root and host network prechecked, in this order
    await expect(dialog.getByRole("combobox", { name: "image" })).toHaveValue("europe-docker.pkg.dev/gardener-project/releases/gardener/ops-toolbelt:latest");
    await expect(dialog.getByRole("group", { name: "host access" }).locator("label")).toHaveText(["chroot into /host", "host root at /host", "host network"]);
    await expect(dialog.getByRole("checkbox", { name: "chroot into /host" })).not.toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "host root at /host" })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "host network" })).toBeChecked();
    await node.fill("33");
    await page.keyboard.press("Tab"); // completes to the match
    await expect(node).toHaveValue("ip-10-0-3-33.ec2.internal");
    // chroot needs the mount: unchecking host root unchecks chroot, checking chroot checks it
    await dialog.getByRole("checkbox", { name: "chroot into /host" }).check();
    await expect(dialog).toContainText("shell chrooted into it");
    await dialog.getByRole("checkbox", { name: "host root at /host" }).uncheck();
    await expect(dialog.getByRole("checkbox", { name: "chroot into /host" })).not.toBeChecked();
    await dialog.getByRole("checkbox", { name: "chroot into /host" }).check();
    await expect(dialog.getByRole("checkbox", { name: "host root at /host" })).toBeChecked();
    await dialog.getByRole("checkbox", { name: "host network" }).uncheck();
    // the namespace completes from the context's namespaces
    const ns = dialog.getByRole("combobox", { name: "namespace" });
    await ns.fill("kube-s");
    await page.keyboard.press("Tab");
    await expect(ns).toHaveValue("kube-system");
    await dialog.getByRole("combobox", { name: "image" }).fill("busybox:ops");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter"); // the first ⏎ takes nothing (no suggestion), so it starts
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await inspect(page)).focus).toBe("terminal");
    const header = page.locator("section[data-pane] header").filter({ hasText: "node shell" });
    await expect(header).toContainText("ip-10-0-3-33.ec2.internal");
    await expect(header).toContainText("busybox:ops · chroot /host");
    await expect(header).not.toContainText("host network");
    await expect(header).toContainText("kube-system/ops-pod-kubewing-e2e-"); // the user (headless tapes: e2e)
    await expect.poll(() => termText(page)).toContain("ip-10-0-3-33.ec2.internal:ops-pod-kubewing-e2e-");
    expect(await termText(page)).toContain('Pulling: Pulling image "busybox:ops"');
    expect(await termText(page)).toContain('runs "chroot /host sh -c');
    await page.keyboard.press("Control+D");
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
    // the next dialog starts with what ran: namespace and checkboxes (history.yaml, so also after a restart)
    await page.keyboard.press("ControlOrMeta+Alt+O");
    await expect(ns).toHaveValue("kube-system");
    await expect(dialog.getByRole("checkbox", { name: "chroot into /host" })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "host root at /host" })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "host network" })).not.toBeChecked();
    await ns.focus();
    await page.keyboard.press("ArrowDown");
    await expect(dialog.getByRole("listbox", { name: "namespace suggestions" }).getByRole("option").first()).toContainText("kube-systemlast used");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("⌥⌘O from a terminal pane: no row, an empty node; unknown nodes and empty images are refused in the dialog", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-3");
    await page.keyboard.press("x"); // one container: straight to its shell
    await expect.poll(async () => (await inspect(page)).focus).toBe("terminal");
    await page.keyboard.press("ControlOrMeta+Alt+O");
    const dialog = page.getByRole("dialog", { name: "node shell" });
    const node = dialog.getByRole("combobox", { name: "node" });
    await expect(node).toHaveValue("");
    await expect(dialog.getByRole("listbox", { name: "node suggestions" }).getByRole("option")).toHaveCount(3); // listed right away
    // checked in the dialog once the nodes are listed (before that Go refuses it: "no node … on tape")
    await expect(dialog.getByRole("status", { name: "node completion status" })).toHaveCount(0);
    await node.fill("nope");
    await node.press("Enter");
    await expect(dialog.getByRole("alert")).toHaveText('no node "nope" (↓ lists them)');
    await node.fill("ip-10-0-1-11.ec2.internal");
    await dialog.getByRole("combobox", { name: "image" }).fill(" ");
    await node.press("Enter");
    await expect(dialog.getByRole("alert")).toHaveText("an image is needed, e.g. the ops-toolbelt");
    // one image history with debug containers: an earlier debug's image and the last ops pod's are offered
    await dialog.getByRole("combobox", { name: "image" }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(dialog.getByRole("listbox", { name: "image suggestions" })).toContainText("alpine:3.20");
    await expect(dialog.getByRole("listbox", { name: "image suggestions" })).toContainText("busybox:ops");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect((await inspect(page)).focus).toBe("terminal"); // back to the shell
    await page.keyboard.press("Control+D");
  });

  test("ops pod on a node row of a dev context: confirmed with its settings; a failed image keeps the pane", async ({ page }) => {
    const menu = (p: Page) => p.getByRole("menu");
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    await page.getByRole("combobox", { name: "context" }).selectOption("tape-dev");
    await page.getByRole("combobox", { name: "resource" }).fill("nodes");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await focused(page)).rows.length).toBe(3);
    await select(page, "n-1");
    // the context menu offers it on node rows
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(menu(page).getByRole("menuitem", { name: "node shell… ⌥⌘O" })).toBeEnabled();
    await expect(menu(page).getByRole("menuitem", { name: /exec shell/ })).toBeDisabled();
    await menu(page).getByRole("menuitem", { name: "node shell… ⌥⌘O" }).click();
    const dialog = page.getByRole("dialog", { name: "node shell" });
    await expect(dialog).toContainText("of tape-dev");
    await expect(dialog.getByRole("combobox", { name: "node" })).toHaveValue("ip-10-0-1-11.ec2.internal");
    await dialog.getByRole("combobox", { name: "image" }).fill("fail/nope");
    await dialog.getByRole("combobox", { name: "image" }).press("Enter");
    const confirm = page.getByRole("alertdialog", { name: "confirm opspod" });
    // the remembered settings of the first ops pod test
    await expect(confirm).toContainText("node shell on node ip-10-0-1-11.ec2.internal on tape-dev (image fail/nope, namespace kube-system, chroot /host)");
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("session ended")).toContainText("ImagePullBackOff");
    await expect.poll(() => termText(page)).toContain("deleting kube-system/ops-pod-kubewing-e2e-");
    await page.keyboard.press("Control+D");
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
  });

  test("ops pod with a persistent volume: bound ones complete, the claim's namespace is taken", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-3");
    await page.keyboard.press("ControlOrMeta+Alt+O");
    const dialog = page.getByRole("dialog", { name: "node shell" });
    const pv = dialog.getByRole("combobox", { name: "persistent volume" });
    await pv.focus();
    await page.keyboard.press("ArrowDown");
    const list = dialog.getByRole("listbox", { name: "persistent volume suggestions" });
    await expect(list.getByRole("option")).toHaveCount(3);
    await expect(list.getByRole("option", { name: /pv-etcd-main/ })).toContainText("garden/main-etcd-0 · 25Gi · gp3 · RWO");
    // not bound: listed with the reason, not pickable
    await expect(list.getByRole("option", { name: /pv-spare/ })).toHaveAttribute("aria-disabled", "true");
    await expect(list.getByRole("option", { name: /pv-spare/ })).toContainText("available, no claim to mount through");
    await pv.fill("spare");
    await page.keyboard.press("Tab");
    await expect(pv).toHaveValue("spare"); // ⇥ doesn't complete to it
    await pv.fill("etcd");
    await page.keyboard.press("Tab");
    await expect(pv).toHaveValue("pv-etcd-main");
    const ns = dialog.getByRole("combobox", { name: "namespace" });
    // a namespace set before (or remembered) must NOT be clobbered when a PV is selected,
    // and a conflict with the claim's namespace is flagged, not silently overwritten
    await ns.fill("kube-system");
    await expect(ns).toHaveValue("kube-system");
    await expect(dialog).toContainText("the volume mounts only in its claim's namespace garden");
    // empty → the pod lands in the claim's namespace (shown as the placeholder/hint, not forced in)
    await ns.fill("");
    await expect(dialog).toContainText("empty → the volume's claim namespace garden");
    await page.keyboard.press("Escape"); // close the namespace suggestion list before clicking below it
    await dialog.getByRole("checkbox", { name: "read-only" }).check();
    // an empty mount path uses the shown /pv
    await expect(dialog).toContainText("pv-etcd-main at /pv (read-only)");
    await dialog.getByRole("combobox", { name: "image" }).fill("busybox:pv");
    // ⏎ in the mount path field starts (empty = /pv)
    const mountPath = dialog.getByRole("textbox", { name: "mount path" });
    await mountPath.focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await inspect(page)).focus).toBe("terminal");
    const header = page.locator("section[data-pane] header").filter({ hasText: "node shell" });
    await expect(header).toContainText("garden/ops-pod-kubewing-e2e-");
    await expect(header).toContainText("pv-etcd-main at /pv (ro)");
    await page.keyboard.press("Control+D");
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
  });

  test("show YAML renders the pod; edited, it's what starts; edits that break the ops pod are refused", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-3");
    await page.keyboard.press("ControlOrMeta+Alt+O");
    const dialog = page.getByRole("dialog", { name: "node shell" });
    await dialog.getByRole("combobox", { name: "image" }).fill("busybox:yaml");
    await dialog.getByRole("combobox", { name: "namespace" }).fill("ops");
    await dialog.getByRole("button", { name: "show YAML…" }).click();
    const editor = dialog.locator("[data-editor=yaml] .view-lines");
    await expect(editor).toContainText("nodeName: ip-10-0-2-22.ec2.internal");
    await expect(editor).toContainText("image: busybox:yaml");
    await expect(editor).toContainText("namespace: ops");
    // (the commented priorityClassName line is asserted precisely in the Go bridge test)
    // the form is locked while the YAML is what starts
    await expect(dialog.getByRole("combobox", { name: "image" })).toBeDisabled();
    await expect(dialog).toContainText("this is what starts");
    // Esc in the find widget closes it, not the YAML
    const textarea = dialog.getByRole("textbox", { name: "pod YAML" });
    await textarea.focus();
    await page.keyboard.press("ControlOrMeta+F");
    await expect(dialog.locator(".find-widget.visible")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await expect(dialog).not.toContainText("esc again drops");
    // edit: a spec-level field at the end of the YAML. Select-all then ArrowRight
    // collapses the cursor to the document end deterministically (⌘End can land
    // elsewhere after the find widget closed); insertText skips Monaco's auto-indent.
    const append = async (line: string) => {
      await textarea.focus();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.insertText("\n" + line);
    };
    await append("  priorityClassName: system-cluster-critical");
    await expect(dialog).toContainText("edited: this is what starts");
    // Esc on edits asks first; typing again takes the question back
    await page.keyboard.press("Escape");
    await expect(dialog).toContainText("esc again drops the YAML edits");
    await page.keyboard.type(" ");
    await page.keyboard.press("Backspace");
    await expect(dialog).not.toContainText("esc again drops");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect.poll(async () => (await inspect(page)).focus).toBe("terminal");
    const header = page.locator("section[data-pane] header").filter({ hasText: "node shell" });
    await expect(header).toContainText("busybox:yaml · ");
    await expect(header).toContainText("edited YAML");
    await expect(header).toContainText("ops/ops-pod-kubewing-e2e-");
    await page.keyboard.press("Control+D");
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");

    // a broken edit: refused with the reason, the dialog and the YAML stay
    await page.keyboard.press("ControlOrMeta+Alt+O");
    await dialog.getByRole("button", { name: "show YAML…" }).click();
    await expect(editor).toContainText("nodeName: ip-10-0-2-22.ec2.internal");
    await append("  bogusField: 1");
    await expect(editor).toContainText("bogusField"); // the edit landed before we submit
    await textarea.focus();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(dialog.getByRole("alert")).toContainText("unknown field");
    // Esc twice drops the edits, back to the (unlocked) form; a third closes the dialog
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(dialog.getByRole("combobox", { name: "image" })).toBeEnabled();
    await dialog.getByRole("combobox", { name: "image" }).focus();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("ops pods are refused on read-only contexts, in the dialog", async ({ page }) => {
    await openStatic(page, "tape-prod");
    await select(page, "s-web-3");
    await page.keyboard.press("ControlOrMeta+Alt+O");
    const dialog = page.getByRole("dialog", { name: "node shell" });
    await expect(dialog.getByRole("combobox", { name: "node" })).toHaveValue("ip-10-0-2-22.ec2.internal");
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText("read-only context");
    await expect(dialog).toBeVisible();
  });

  test("f forwards the pod's ports; ⌥⌘P lists them, ⌫ stops", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    await page.keyboard.press("f");
    const dialog = page.getByRole("dialog", { name: "port-forward" });
    const ports = dialog.getByRole("combobox", { name: "ports" });
    // several declared ports: nothing prefilled, a list to pick from instead
    await expect(ports).toHaveValue("");
    const declared = dialog.getByRole("listbox", { name: "declared ports" });
    await expect(declared.getByRole("option")).toHaveText(["8080http · TCP · app", "9090metrics · TCP · app", "5353dns · UDP · sidecar · can't forward"]);
    // the UDP-only port is listed but can't be picked: the highlight skips it
    await expect(declared.getByRole("option", { name: /5353/ })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("ArrowUp"); // wraps from the first to the last forwardable one
    await expect(declared.getByRole("option", { selected: true })).toContainText("9090");
    // typing a name filters; ⏎ picks, and a picked port isn't offered again
    await page.keyboard.type("met");
    await expect(declared.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(ports).toHaveValue("9090:9090 ");
    await expect(declared.getByRole("option")).toHaveText(["8080http · TCP · app", "5353dns · UDP · sidecar · can't forward"]);
    // after a pick nothing is highlighted, and the hint says ⏎ forwards now; ↓ picks another
    await expect(declared.getByRole("option", { selected: true })).toHaveCount(0);
    await expect(dialog).toContainText("↓ pick a port · ⏎ forward on 127.0.0.1");
    await page.keyboard.press("ArrowDown");
    await expect(declared.getByRole("option", { selected: true })).toContainText("8080");
    await expect(dialog).toContainText("⏎ add the highlighted port");
    await page.keyboard.press("ArrowUp"); // wraps (the UDP port is skipped): still 8080, the only one left
    await expect(declared.getByRole("option", { selected: true })).toContainText("8080");
    await page.keyboard.press("Escape"); // an open list closes first, the dialog stays
    await expect(declared).toHaveCount(0);
    await expect(dialog).toBeVisible();
    // a typed spec still works as before
    await ports.fill("18080:8080");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("message")).toContainText("127.0.0.1:18080 → 8080");
    await expect(page.getByLabel("active port-forwards")).toHaveText("⇄ 1");
    await page.keyboard.press("ControlOrMeta+Alt+P");
    const list = page.getByRole("listbox", { name: "active port-forwards" });
    await expect(list.getByRole("option")).toHaveCount(1);
    await expect(list.getByRole("option").first()).toContainText("shop/web-1");
    expect((await inspect(page)).focus).toBe("forwards");
    await page.keyboard.press("x");
    await expect(list).toHaveCount(0);
    await expect(page.getByLabel("active port-forwards")).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect((await inspect(page)).focus).toBe("table");
  });

  test("f again shows the pod's running forwards (✕ stops) and doesn't offer their ports; the ⇄ badge opens the list", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    await page.keyboard.press("f");
    const dialog = page.getByRole("dialog", { name: "port-forward" });
    await dialog.getByRole("combobox", { name: "ports" }).fill("9090");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    // reopened: the running forward is listed, 9090 is no longer offered
    await page.keyboard.press("f");
    const running = dialog.getByRole("listbox", { name: "running port-forwards" });
    await expect(running).toContainText("→ 9090");
    const declared = dialog.getByRole("listbox", { name: "declared ports" });
    await expect(declared.getByRole("option")).toHaveText(["8080http · TCP · app", "5353dns · UDP · sidecar · can't forward"]);
    await dialog.getByRole("button", { name: /^stop 127\.0\.0\.1:\d+ → 9090$/ }).click();
    await expect(running).toHaveCount(0);
    await expect(dialog.getByRole("combobox", { name: "ports" })).toBeFocused(); // ✕ doesn't take the focus
    await expect(page.getByLabel("active port-forwards")).toHaveCount(0);
    // keyboard: ⇧⇥ from the ports field into the running forwards, ↑/↓ pick, ⌫ stops, esc back
    const ports = dialog.getByRole("combobox", { name: "ports" });
    for (const p of ["8080", "9090"]) {
      await ports.fill(p);
      await page.keyboard.press("Enter");
      await expect(dialog).toHaveCount(0);
      await page.keyboard.press("f");
    }
    await expect(running.getByRole("option")).toHaveCount(2);
    await page.keyboard.press("Shift+Tab");
    await expect(running).toBeFocused();
    await expect(running.getByRole("option", { selected: true })).toContainText("→ 8080");
    await page.keyboard.press("j"); // arrows only: j does nothing
    await expect(running.getByRole("option", { selected: true })).toContainText("→ 8080");
    await page.keyboard.press("ArrowDown");
    await expect(running.getByRole("option", { selected: true })).toContainText("→ 9090");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Backspace"); // stops 8080
    await expect(running.getByRole("option")).toHaveCount(1);
    await expect(running.getByRole("option", { selected: true })).toContainText("→ 9090");
    await page.keyboard.press("Escape"); // back to the field, the dialog stays
    await expect(ports).toBeFocused();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Control+D"); // not a stop key any more: nothing happens, the pane stays
    await expect(running.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("x"); // in the list x stops; typed in the field it would be text
    await expect(running).toHaveCount(0);
    await expect(ports).toBeFocused(); // the last one gone: back in the field
    await expect(ports).toHaveValue(""); // the x didn't land in the field
    expect(Object.keys((await inspect(page)).panes)).toHaveLength(1);
    // the badge: a button that opens the list of all forwards, ✕ stops there too
    await dialog.getByRole("combobox", { name: "ports" }).fill("8080");
    await page.keyboard.press("Enter");
    const badge = page.getByRole("button", { name: "active port-forwards" });
    await expect(badge).toHaveText("⇄ 1");
    await expect(badge).toHaveAttribute("title", "port-forwards (⌥⌘P)"); // the live key, in macOS modifier order
    await badge.click();
    const list = page.getByRole("dialog", { name: "port-forwards" });
    await expect(list).toContainText("shop/web-1");
    await list.getByRole("button", { name: /^stop .* → 8080$/ }).click();
    await expect(list).toContainText("none");
    await expect(badge).toHaveCount(0);
  });

  test("⌘⌥P opens the list as macOS delivers it (⌥ turns P into π)", async ({ page }) => {
    await ready(page);
    // Playwright's press() sends key "p"; WebKit/Chrome on macOS send the ⌥ character
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "π", code: "KeyP", metaKey: true, altKey: true, bubbles: true })),
    );
    await expect(page.getByRole("dialog", { name: "port-forwards" })).toBeVisible();
    expect((await inspect(page)).focus).toBe("forwards");
  });

  test("invalid ports are rejected in the dialog", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    await page.keyboard.press("f");
    const dialog = page.getByRole("dialog", { name: "port-forward" });
    await dialog.getByRole("combobox", { name: "ports" }).fill("80:abc");
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText('invalid port "80:abc"');
  });

  test("a pod with a single declared port gets it prefilled, without a list; a low port gets a local one above 8000", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-3");
    await page.keyboard.press("f");
    const dialog = page.getByRole("dialog", { name: "port-forward" });
    const ports = dialog.getByRole("combobox", { name: "ports" });
    await expect(ports).toHaveValue("8443:443"); // 443 needs root locally
    await expect(dialog.getByRole("listbox", { name: "declared ports" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("one port: ⏎ picks it, ⏎ again forwards; two: ⏎, ↓ ⏎, then ⏎ forwards both", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    const dialog = page.getByRole("dialog", { name: "port-forward" });
    const ports = dialog.getByRole("combobox", { name: "ports" });
    // the ports arrive asynchronously: wait for the list before pressing keys
    const highlighted = dialog.getByRole("listbox", { name: "declared ports" }).getByRole("option", { selected: true });
    // one: the first port is highlighted when the dialog opens
    await page.keyboard.press("f");
    await expect(highlighted).toContainText("8080");
    await page.keyboard.press("Enter");
    await expect(ports).toHaveValue("8080:8080 ");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("message")).toContainText("→ 8080");
    // two: stop the first forward so both ports are offered again
    const stop = async () => {
      await page.getByRole("button", { name: "active port-forwards" }).click();
      const list = page.getByRole("dialog", { name: "port-forwards" });
      while ((await list.getByRole("option").count()) > 0) await page.keyboard.press("x");
      await page.keyboard.press("Escape");
    };
    await stop();
    await page.keyboard.press("f");
    await expect(highlighted).toContainText("8080");
    await page.keyboard.press("Enter"); // 8080
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter"); // 9090
    await expect(ports).toHaveValue("8080:8080 9090:9090 ");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("message")).toContainText("→ 8080, 127.0.0.1:9090 → 9090");
    // each port is its own forward: listed and stopped on its own, in both dialogs
    await expect(page.getByRole("button", { name: "active port-forwards" })).toHaveText("⇄ 2");
    await page.keyboard.press("f");
    const running = dialog.getByRole("listbox", { name: "running port-forwards" });
    await expect(running.getByRole("option")).toHaveText([/→ 8080✕$/, /→ 9090✕$/]);
    await page.keyboard.press("Escape");
    await stop();
  });

  test("ports picked together that partly fail: the good ones start, the failed ones stay with the error", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    await page.keyboard.press("f");
    const dialog = page.getByRole("dialog", { name: "port-forward" });
    const ports = dialog.getByRole("combobox", { name: "ports" });
    await ports.fill("9090 80:8080"); // 80 locally needs root
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("alert")).toHaveText(/^80:8080: .*permission denied/);
    await expect(ports).toHaveValue("80:8080 "); // only the failed one is left to fix
    await expect(dialog.getByRole("listbox", { name: "running port-forwards" }).getByRole("option")).toHaveText([/→ 9090✕$/]);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("x");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("a forward that fails shows its error with the port list closed", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1"); // several ports: the list is open while typing
    await page.keyboard.press("f");
    const dialog = page.getByRole("dialog", { name: "port-forward" });
    const declared = dialog.getByRole("listbox", { name: "declared ports" });
    // the list is open while picking; a typed local port below 1024 can't be bound
    await expect(declared).toBeVisible();
    await dialog.getByRole("combobox", { name: "ports" }).fill("80:8080"); // a local:remote spec matches no entry: ⏎ submits
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText("permission denied");
    await expect(declared).toHaveCount(0); // closed: the error isn't covered
    await dialog.getByRole("combobox", { name: "ports" }).fill(""); // typing again opens it
    await expect(declared).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("not a pod: exec and port-forward are refused", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-cfg");
    await page.keyboard.press("x");
    await expect(page.getByLabel("message")).toContainText("exec needs a pod, not configmap");
    expect((await inspect(page)).focus).toBe("table");
  });

  test("read-only context: exec refused; describe still works", async ({ page }) => {
    await openStatic(page, "tape-prod");
    await select(page, "s-web-1");
    await page.keyboard.press("x");
    await expect(page.getByLabel("message")).toContainText("read-only context");
    expect(Object.values((await inspect(page)).panes).some((p) => (p as { term?: unknown }).term)).toBe(false);
    await page.keyboard.press("d");
    await expect(page.getByRole("dialog", { name: "object detail" }).locator(".view-lines")).toContainText("Name:         web-1");
  });
  test.describe("edit", () => {
    const dialog = (page: Page) => page.getByRole("dialog", { name: "edit object" });
    /**
     * Changes one value in the editor by typing: find it (⌘F), close the find
     * widget (the match stays selected) and type over it. Typed, not pasted:
     * the editor's keys are text, and Monaco's auto-indent stays out of it.
     */
    async function retype(page: Page, from: string, to: string) {
      await expect(dialog(page).locator("[data-editor=yaml] .view-lines")).toContainText(from);
      await dialog(page).getByRole("textbox", { name: "edit YAML" }).focus();
      await page.keyboard.press("ControlOrMeta+F");
      await page.keyboard.insertText(from);
      await page.keyboard.press("Escape");
      await expect(dialog(page).locator(".find-widget.visible")).toHaveCount(0);
      await page.keyboard.type(to);
      await expect(dialog(page).locator("[data-editor=yaml] .view-lines")).toContainText(to);
    }

    test("e opens the object; ⌘S previews the server's dry run; ⏎ writes it and the table shows it", async ({ page }) => {
      await openStatic(page);
      await select(page, "s-settings");
      await page.keyboard.press("e");
      await expect(dialog(page)).toContainText("ConfigMap settings");
      expect((await inspect(page)).focus).toBe("edit");
      // keys are text in the editor: typing "green" (r: refresh, e: edit, n …) only edits
      await retype(page, "blue", "green");
      expect((await inspect(page)).overlays).toEqual(["edit"]);
      await expect(dialog(page)).toContainText("edit (changed)");
      await page.keyboard.press("ControlOrMeta+S");
      await expect(dialog(page)).toContainText("preview (server dry run");
      expect((await inspect(page)).focus).toBe("editpreview");
      await expect(dialog(page).getByRole("status", { name: "change position" })).toHaveText("1 / 1");
      const diff = dialog(page).locator('[data-viewer="diff"]');
      await expect(diff).toContainText("mode: blue");
      await expect(diff).toContainText("mode: green");
      // esc goes back to editing, with the text kept; ⌘S again previews it
      await page.keyboard.press("Escape");
      expect((await inspect(page)).focus).toBe("edit");
      await expect(dialog(page).locator("[data-editor=yaml] .view-lines")).toContainText("mode: green");
      await page.keyboard.press("ControlOrMeta+S");
      await expect(dialog(page)).toContainText("preview (server dry run");
      await page.keyboard.press("Enter");
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.getByLabel("message")).toHaveText("edited e2e-static/settings");
      expect((await inspect(page)).focus).toBe("table");
      // the watch delivers the new version: the YAML view shows it
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog", { name: "object detail" }).locator(".view-lines")).toContainText("mode: green");
      // e from the YAML view edits the version just written
      await page.keyboard.press("e");
      await expect(dialog(page).locator("[data-editor=yaml] .view-lines")).toContainText("mode: green");
      await expect(dialog(page).locator("[data-editor=yaml] .view-lines")).toContainText('resourceVersion: "8"');
      // nothing changed: esc closes at once
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
      expect((await inspect(page)).overlays).toEqual([]);
    });

    test("the editor is modal: ⌥↓ moves a line, ⌘D deletes it (no split behind it), ⌘S still previews", async ({ page }) => {
      await openStatic(page);
      await select(page, "s-settings");
      await page.keyboard.press("e");
      const lines = dialog(page).locator("[data-editor=yaml] .view-lines");
      await expect(lines).toContainText('replicas: "3"');
      const panes = Object.keys((await inspect(page)).panes).length;
      // the find leaves the cursor on the line of the match
      await dialog(page).getByRole("textbox", { name: "edit YAML" }).focus();
      await page.keyboard.press("ControlOrMeta+F");
      await page.keyboard.insertText('replicas: "3"');
      await page.keyboard.press("Escape");
      // ⌥↓/⌥↑: the line swaps with the next one and back (Monaco's line elements aren't in document order: by position)
      const order = () =>
        lines.locator(".view-line").evaluateAll((els) =>
          els
            .map((el) => ({ top: parseFloat((el as HTMLElement).style.top), text: (el.textContent ?? "").replace(/\s+/g, " ").trim() }))
            .sort((a, b) => a.top - b.top)
            .map((l) => l.text),
        );
      const at = (await order()).indexOf('replicas: "3"');
      expect(at).toBeGreaterThan(-1);
      await page.keyboard.press("Alt+ArrowDown");
      await expect.poll(async () => (await order()).indexOf('replicas: "3"')).toBe(at + 1);
      await page.keyboard.press("Alt+ArrowUp");
      await expect.poll(async () => (await order()).indexOf('replicas: "3"')).toBe(at);
      await page.keyboard.press("Meta+D");
      await expect(lines).not.toContainText("replicas");
      expect(Object.keys((await inspect(page)).panes)).toHaveLength(panes);
      expect((await inspect(page)).focus).toBe("edit");
      await page.keyboard.press("ControlOrMeta+S");
      await expect(dialog(page)).toContainText("preview (server dry run");
      await expect(dialog(page).locator('[data-viewer="diff"]')).toContainText('replicas: "3"');
      expect((await inspect(page)).focus).toBe("editpreview");
      // the preview too: no split behind it
      await page.keyboard.press("Meta+D");
      expect(Object.keys((await inspect(page)).panes)).toHaveLength(panes);
      expect((await inspect(page)).focus).toBe("editpreview");
    });

    test("changes ask before esc discards them; nothing changed is refused in the editor", async ({ page }) => {
      await openStatic(page);
      await select(page, "s-settings");
      await page.keyboard.press("e");
      await expect(dialog(page).locator("[data-editor=yaml] .view-lines")).toContainText("apiVersion"); // read from the server first
      await page.keyboard.press("ControlOrMeta+S");
      await expect(dialog(page).getByRole("alert")).toHaveText("no changes");
      await retype(page, "settings", "settingsx"); // the name: changed, but never sent
      await page.keyboard.press("Escape");
      await expect(dialog(page).getByRole("status")).toHaveText("unsaved changes: esc again discards them");
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
      expect((await inspect(page)).focus).toBe("table");
    });

    test("a refused edit (admission webhook, renamed object) stays in the editor with the reason", async ({ page }) => {
      await openStatic(page);
      await select(page, "s-locked");
      await page.keyboard.press("e");
      await retype(page, "blue", "red");
      await page.keyboard.press("ControlOrMeta+S");
      await expect(dialog(page).getByRole("alert")).toContainText("denied the request: locked by policy");
      expect((await inspect(page)).focus).toBe("edit");
      await retype(page, "name: locked", "name: unlocked");
      await page.keyboard.press("ControlOrMeta+S");
      await expect(dialog(page).getByRole("alert")).toContainText("name and namespace must stay shop/locked");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
    });

    test("a context that confirms edits asks after the preview; esc there goes back to it", async ({ page }) => {
      await openStatic(page, "tape-dev");
      await select(page, "s-settings");
      await page.keyboard.press("e");
      await retype(page, "dev-before", "dev-after");
      await page.keyboard.press("ControlOrMeta+S");
      await expect(dialog(page)).toContainText("preview (server dry run");
      await expect(dialog(page)).toContainText("DEV");
      await page.keyboard.press("Enter");
      const confirm = page.getByRole("alertdialog", { name: "confirm edit" });
      await expect(confirm).toContainText("edit e2e-static/settings -n shop on tape-dev");
      await page.keyboard.press("Escape");
      await expect(confirm).toHaveCount(0);
      expect((await inspect(page)).focus).toBe("editpreview");
      await page.keyboard.press("Enter");
      await confirm.getByRole("button").first().click();
      await expect(page.getByLabel("message")).toHaveText("edited e2e-static/settings");
    });

    test("read-only context: the menu entry is disabled and e is refused", async ({ page }) => {
      await openStatic(page, "tape-prod");
      await select(page, "s-settings");
      await page.keyboard.press("e");
      await expect(page.getByLabel("message")).toContainText("read-only context");
      await expect(dialog(page)).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+Enter");
      await expect(page.getByRole("menu").getByRole("menuitem", { name: /edit YAML…/ })).toContainText("read-only context");
      await page.keyboard.press("Escape");
    });
  });

  test("long lines wrap by default; w toggles it for the session, also in describe", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-cfg");
    await page.keyboard.press("Enter");
    const viewer = page.locator('[data-viewer="single"]');
    await expect(viewer.locator(".view-lines")).toContainText("replicas");
    // wrapped: the long data line fits, the horizontal slider fills its track; unwrapped the view scrolls
    const overflow = () =>
      viewer.evaluate((el) => {
        const track = el.querySelector(".scrollbar.horizontal") as HTMLElement, slider = track.querySelector(".slider") as HTMLElement;
        return slider.offsetWidth < track.offsetWidth - 1;
      });
    await expect(viewer).toHaveAttribute("data-wrap", "true");
    await expect.poll(overflow).toBe(false);
    await page.keyboard.press("w");
    await expect(viewer).toHaveAttribute("data-wrap", "false");
    await expect.poll(overflow).toBe(true);
    // the choice holds for describe and for the next object
    await page.keyboard.press("Shift+D");
    await expect(page.locator('[data-viewer="single"]')).toHaveAttribute("data-wrap", "false");
    await page.keyboard.press("w");
    await expect(page.locator('[data-viewer="single"]')).toHaveAttribute("data-wrap", "true");
    await page.keyboard.press("Escape");
  });
});

test.describe("context menu (⌘⏎, right-click)", () => {
  async function openStatic(page: Page, context = "") {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    if (context) await page.getByRole("combobox", { name: "context" }).selectOption(context);
    await page.getByRole("combobox", { name: "resource" }).fill("e2e-static");
    await page.keyboard.press("Enter");
    await expect.poll(async () => {
      const p = await focused(page);
      return p.spec.resource === "e2e-static" && p.status?.synced && p.rows.some((r) => r.key === "s-web-1");
    }).toBe(true);
  }
  async function select(page: Page, key: string) {
    const rows = (await focused(page)).rows;
    await page.keyboard.press("g");
    for (let i = 0; i < rows.findIndex((r) => r.key === key); i++) await page.keyboard.press("j");
  }
  const menu = (page: Page) => page.getByRole("menu");

  test("⌘⏎ lists every row action with its shortcut; ⏎ runs the highlighted one", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(menu(page)).toMatchAriaSnapshot(`
      - menu "actions for web-1":
        - text: web-1 · pod · shop
        - menuitem "view YAML ⏎"
        - menuitem "edit YAML… e"
        - menuitem "describe d"
        - menuitem "diff last change · no change seen yet" [disabled]
        - menuitem "copy name"
        - menuitem "copy cell… ⌘⇧C"
        - menuitem "jump to… ⌘J"
        - separator
        - menuitem "exec shell x"
        - menuitem "debug container… b"
        - menuitem "node shell… ⌥⌘O"
        - menuitem "port-forward… f"
        - separator
        - menuitem "delete… ⌘⌫"
    `);
    expect((await inspect(page)).focus).toBe("menu");
    // j/k skip the disabled diff entry: edit YAML → describe → copy name → describe
    await page.keyboard.press("j");
    await expect(menu(page).locator("[data-active]")).toContainText("edit YAML…");
    await page.keyboard.press("j");
    await expect(menu(page).locator("[data-active]")).toContainText("describe");
    await page.keyboard.press("j");
    await expect(menu(page).locator("[data-active]")).toContainText("copy name");
    await page.keyboard.press("k");
    await expect(menu(page).locator("[data-active]")).toContainText("describe");
    await page.keyboard.press("Enter");
    await expect(menu(page)).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "object detail" }).locator(".view-lines")).toContainText("Name:         web-1");
    await page.keyboard.press("Escape");
    expect((await inspect(page)).focus).toBe("table");
  });

  // layout tests use e2e-pods: no test deletes from it, so its rows are stable once
  // its scripted steps (restart at 2s, recreate at 3s) are done
  async function openSettled(page: Page) {
    await openTape(page);
    await afterTapeSteps(page);
  }

  test("⌘⏎ anchors the menu to the selected row (below it, flush with the row)", async ({ page }) => {
    await openSettled(page);
    const grid = (await page.locator("section[data-pane] canvas").first().boundingBox())!;
    const rowBottom = (i: number) => grid.y + 24 + (i + 1) * 22; // header 24px, rows 22px (no scrolling: 4 rows)
    const tops: number[] = [];
    for (const i of [0, 2]) {
      await page.keyboard.press("g");
      for (let n = 0; n < i; n++) await page.keyboard.press("j");
      await expect.poll(async () => (await focused(page)).selected).toBe(i);
      await page.keyboard.press("ControlOrMeta+Enter");
      await expect(menu(page)).toHaveAttribute("data-placement", "below");
      const m = (await menu(page).boundingBox())!;
      expect(Math.abs(m.y - rowBottom(i))).toBeLessThan(3);
      expect(Math.abs(m.x - grid.x)).toBeLessThan(3);
      tops.push(m.y);
      await page.keyboard.press("Escape");
    }
    expect(tops[1]! - tops[0]!).toBeCloseTo(44, -1); // it follows the selection: two rows down
  });

  test("a menu opening under a resting pointer keeps the first entry; moving the mouse still highlights", async ({ page }) => {
    await openSettled(page);
    const active = () => menu(page).locator("[data-active]").innerText();
    // find where "edit YAML…" (2nd entry) appears, then park the pointer there
    await page.keyboard.press("ControlOrMeta+Enter");
    const item = (await menu(page).getByRole("menuitem").nth(1).boundingBox())!;
    await page.keyboard.press("Escape");
    await page.mouse.move(item.x + 40, item.y + item.height / 2);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ControlOrMeta+Enter");
      await expect(menu(page)).toBeVisible();
      await page.waitForTimeout(100); // let any hover events fire
      expect(await active()).toContain("view YAML");
      await page.keyboard.press("Escape");
    }
    // real movement inside the open menu highlights what's under the pointer
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.mouse.move(item.x + 60, item.y + item.height / 2, { steps: 4 });
    await expect.poll(active).toContain("edit YAML…");
  });

  test("⌘⏎ flips the menu above the row when there's no room below", async ({ page }) => {
    await openSettled(page);
    // stack a split below so the table's last row sits low in the window, with room above it
    await page.setViewportSize({ width: 1400, height: 560 });
    await page.keyboard.press("ControlOrMeta+D"); // split: the new (bottom) pane is focused
    // the split's fresh relist has no tombstone for the recreated pod, so it may have one row less
    await expect.poll(async () => (await focused(page)).status?.synced).toBe(true);
    const last = (await focused(page)).total - 1;
    await page.keyboard.press("Shift+G"); // its last row, near the window bottom
    await expect.poll(async () => (await focused(page)).selected).toBe(last);
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(menu(page)).toHaveAttribute("data-placement", "above");
    const m = (await menu(page).boundingBox())!;
    const pane = (await page.locator(`section[data-pane="${(await inspect(page)).focusedPane}"] canvas`).first().boundingBox())!;
    const rowTop = pane.y + 24 + last * 22;
    expect(Math.abs(m.y + m.height - rowTop)).toBeLessThan(3); // its bottom edge meets the row's top
    expect(m.y).toBeGreaterThanOrEqual(0);
  });

  test("esc closes and restores focus and selection; j/k don't move the table meanwhile", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    const sel = (await focused(page)).selected;
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    expect((await inspect(page)).focus).toBe("table");
    expect((await focused(page)).selected).toBe(sel);
  });

  test("non-pods and read-only contexts get disabled entries with the reason", async ({ page }) => {
    await openStatic(page, "tape-prod");
    await select(page, "s-cfg");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(menu(page).getByRole("menuitem", { name: /exec shell/ })).toHaveAttribute("aria-disabled", "true");
    await expect(menu(page).getByRole("menuitem", { name: /exec shell/ })).toContainText("needs a pod, not configmap");
    await page.keyboard.press("Escape");
    await select(page, "s-web-1");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(menu(page).getByRole("menuitem", { name: /delete/ })).toContainText("read-only context");
    await expect(menu(page).getByRole("menuitem", { name: /exec shell/ })).toContainText("read-only context");
    await expect(menu(page).getByRole("menuitem", { name: /port-forward/ })).not.toHaveAttribute("aria-disabled");
  });

  test("menu actions go through the same paths: exec opens a terminal, delete still confirms", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    await page.keyboard.press("ControlOrMeta+Enter");
    await menu(page).getByRole("menuitem", { name: /exec shell/ }).click();
    // web-1 has two containers: the same picker as e
    await page.getByRole("menu", { name: "exec into web-1" }).waitFor();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await inspect(page)).focus).toBe("terminal");
    await expect.poll(() => page.locator("[data-terminal] .xterm-rows").innerText()).toContain("$");
    await page.keyboard.press("Control+D"); // ends the shell, the pane goes with it
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
    await page.keyboard.press("ControlOrMeta+Enter");
    await menu(page).getByRole("menuitem", { name: /delete/ }).click();
    const confirm = page.getByRole("alertdialog", { name: "confirm delete" });
    await expect(confirm).toContainText("delete e2e-static/web-1");
    await page.keyboard.press("Escape"); // web-1 must survive: other tests use it
    await expect(confirm).toHaveCount(0);
  });

  test("right-click selects the row and opens the menu at the pointer; click runs", async ({ page }) => {
    await openStatic(page);
    const rows = (await focused(page)).rows;
    const idx = rows.findIndex((r) => r.key === "s-web-1");
    const grid = page.locator("section[data-pane] canvas").first();
    const box = (await grid.boundingBox())!;
    // header 24px, rows 22px
    const y = box.y + 24 + idx * 22 + 11;
    await page.mouse.click(box.x + 60, y, { button: "right" });
    await expect(menu(page)).toBeVisible();
    expect((await focused(page)).selected).toBe(idx);
    const mb = (await menu(page).boundingBox())!;
    expect(Math.abs(mb.x - (box.x + 60))).toBeLessThan(4);
    await menu(page).getByRole("menuitem", { name: /view YAML/ }).click();
    await expect(page.getByRole("dialog", { name: "object detail" }).locator(".view-lines")).toContainText("name: web-1");
  });

  test("⌘⇧C copies a cell of the row; right-click highlights the cell clicked; the whole row is tab-separated", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    await openStatic(page);
    await select(page, "s-web-1");
    const { columns: cols, rows } = await focused(page);
    const idx = rows.findIndex((r) => r.key === "s-web-1");
    const name = cols.indexOf("NAME");
    await page.keyboard.press("ControlOrMeta+Shift+C");
    const picker = page.getByRole("menu", { name: "copy cell" });
    await expect(picker.getByRole("menuitem")).toHaveText([...cols.map((c) => new RegExp(`^${c}`)), /^whole row\s*tab-separated/]);
    expect((await inspect(page)).focus).toBe("menu");
    // nothing copied last: the first cell
    await expect(picker.locator("[data-active]")).toContainText(rows[idx]!.cells[0]!);
    for (let i = 0; i < name; i++) await page.keyboard.press("j");
    await expect(picker.locator("[data-active]")).toContainText("web-1");
    await page.keyboard.press("Enter");
    await expect(picker).toHaveCount(0);
    await expect.poll(clipboard).toBe("web-1");
    await expect(page.getByRole("status", { name: "pane status" })).toContainText("copied NAME web-1");
    expect((await inspect(page)).focus).toBe("table");

    // the column copied last is highlighted again: ⌘⇧C ⏎ on the next row copies its name
    await page.keyboard.press("j");
    await page.keyboard.press("ControlOrMeta+Shift+C");
    await expect(picker.locator("[data-active]")).toContainText(rows[idx + 1]!.cells[name]!);
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    expect((await inspect(page)).focus).toBe("table");

    // right-click on the first cell (NAMESPACE): "copy cell…" in the menu highlights it, at the menu's place
    const box = (await page.locator("section[data-pane] canvas").first().boundingBox())!;
    await page.mouse.click(box.x + 30, box.y + 24 + idx * 22 + 11, { button: "right" });
    await menu(page).getByRole("menuitem", { name: /copy cell/ }).click();
    await expect(page.getByRole("menu")).toHaveCount(1); // the picker replaced the menu
    await expect(picker.locator("[data-active]")).toContainText(cols[0]!);
    const pb = (await picker.boundingBox())!;
    expect(Math.abs(pb.x - (box.x + 30))).toBeLessThan(4);

    // the whole row: every cell, tab-separated
    for (let i = 0; i < cols.length; i++) await page.keyboard.press("j");
    await expect(picker.locator("[data-active]")).toContainText("whole row");
    await page.keyboard.press("Enter");
    await expect.poll(clipboard).toBe(rows[idx]!.cells.join("\t"));
  });
});

test.describe("jump to (⌘J)", () => {
  const jump = (page: Page) => page.getByRole("menu", { name: /^jump from/ });
  async function openRel(page: Page, resource: string, objects: number) {
    await openTape(page, resource, objects);
  }
  async function select(page: Page, key: string) {
    const rows = (await focused(page)).rows;
    await page.keyboard.press("g");
    for (let i = 0; i < rows.findIndex((r) => r.key === key); i++) await page.keyboard.press("j");
    await expect.poll(async () => (await focused(page)).rows[(await focused(page)).selected]?.key).toBe(key);
  }

  // the header's ← / → buttons (of the focused pane by default): where each leads (their title), or greyed out
  const nav = async (page: Page, dir: "back" | "forward", pane?: string) =>
    page.locator(`section[data-pane="${pane ?? (await inspect(page)).focusedPane}"]`).getByRole("button", { name: dir, exact: true });
  async function leads(page: Page, dir: "back" | "forward", to: string | null, pane?: string) {
    const b = await nav(page, dir, pane);
    if (to === null) return expect(b).toBeDisabled();
    await expect(b).toBeEnabled();
    await expect(b).toHaveAttribute("title", new RegExp(`^${dir} to ${to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
  }

  test("pod → ⌘J → owner chain; ⏎ jumps in place, ⌘← goes back to the same pod row, ⌘→ redoes the jump", async ({ page }) => {
    await openRel(page, "rel-pods", 6);
    await select(page, "rp-web-b");
    const startRow = (await focused(page)).selected;
    await page.keyboard.press("ControlOrMeta+J");
    await expect(jump(page)).toMatchAriaSnapshot(`
      - menu "jump from web-7d9f-b":
        - text: jump from pod web-7d9f-b · shop ⏎ here · ⇧⏎ split
        - separator "namespace"
        - menuitem "rel-pods in shop"
        - menuitem "namespace object shop"
        - separator "owners"
        - menuitem "replicaset web-7d9f controller"
        - menuitem "↑ deployment web controller"
        - separator "owned"
        - menuitem "scan for owned… in shop"
        - separator "events"
        - menuitem "events 2"
    `);
    expect((await inspect(page)).focus).toBe("menu");
    // the highlight starts on the direct owner; j steps up the chain
    await expect(jump(page).locator("[data-active]")).toContainText("replicaset web-7d9f");
    await page.keyboard.press("j");
    await expect(jump(page).locator("[data-active]")).toContainText("deployment web");
    await page.keyboard.press("Enter");
    await expect(jump(page)).toHaveCount(0);
    // the pane shows the deployment, filtered by name: the filter bar says why
    await expect.poll(async () => {
      const p = await focused(page);
      return p.status?.synced ? `${p.spec.resource} ${(p.spec as { namespace?: string }).namespace} ${p.spec.filter} ${p.rows.map((r) => r.key)}` : "";
    }).toBe('rel-deployments shop o.metadata.name == "web" rd-web');
    await expect(page.getByLabel("cel")).toHaveValue('o.metadata.name == "web"');
    await leads(page, "back", "rel-pods");
    await leads(page, "forward", null);
    // esc no longer goes back (it's for overlays and fields only)
    await page.keyboard.press("Escape");
    expect((await focused(page)).spec.resource).toBe("rel-deployments");
    // ⌘←: back on the pods, the same row selected again; the deployment is forward now
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    const pods = async () => {
      const p = await focused(page);
      return p.spec.resource === "rel-pods" && p.status?.synced ? p.rows[p.selected]?.key : "";
    };
    await expect.poll(pods).toBe("rp-web-b");
    expect((await focused(page)).selected).toBe(startRow);
    // behind it only the launch view, which ⌘O (openTape) left
    await leads(page, "back", "pods");
    await leads(page, "forward", "rel-deployments");
    // ⌘→ redoes the jump, filter and all
    await page.keyboard.press("ControlOrMeta+ArrowRight");
    await expect.poll(async () => {
      const p = await focused(page);
      return p.status?.synced ? `${p.spec.resource} ${p.spec.filter} ${p.rows.map((r) => r.key)}` : "";
    }).toBe('rel-deployments o.metadata.name == "web" rd-web');
    await leads(page, "back", "rel-pods");
    await leads(page, "forward", null);
    // and back again
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect.poll(pods).toBe("rp-web-b");
  });

  test("v shows the row's events in place (by kind + name, its namespace only); ⌘← back to the row; also from the jump menu and for a node", async ({ page }) => {
    await openRel(page, "rel-pods", 6);
    await select(page, "rp-web-b");
    const startRow = (await focused(page)).selected;
    await page.keyboard.press("v");
    // not the other pod's event, not lab's namesake
    const shown = async () => {
      const p = await focused(page);
      return p.status?.synced ? `${p.spec.resource} ${(p.spec as { namespace?: string }).namespace} ${p.rows.map((r) => r.key).sort()}` : "";
    };
    await expect.poll(shown).toBe("rel-events shop re-1,re-2");
    await expect(page.getByLabel("field selector")).toHaveText("involvedObject.kind=Pod,involvedObject.name=web-7d9f-b");
    await leads(page, "back", "rel-pods");
    // an event has no events of its own
    await page.keyboard.press("v");
    await expect(page.getByLabel("message")).toContainText("an event has no events of its own");
    expect((await focused(page)).spec.resource).toBe("rel-events");
    const backOnPod = async () => {
      const p = await focused(page);
      return p.spec.resource === "rel-pods" && p.status?.synced ? p.rows[p.selected]?.key : "";
    };
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect.poll(backOnPod).toBe("rp-web-b");
    expect((await focused(page)).selected).toBe(startRow);
    await expect(page.getByLabel("field selector")).toHaveCount(0);

    // from the detail view, and the jump menu's events entry: the same jump
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "object detail" })).toBeVisible();
    await page.keyboard.press("v");
    await expect(page.getByRole("dialog", { name: "object detail" })).toHaveCount(0);
    await expect.poll(shown).toBe("rel-events shop re-1,re-2");
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect.poll(backOnPod).toBe("rp-web-b");
    await page.keyboard.press("ControlOrMeta+J");
    await jump(page).getByRole("menuitem", { name: "events 2" }).click();
    await expect.poll(shown).toBe("rel-events shop re-1,re-2");
    // ⇧⏎: in a split below, the pods stay
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect.poll(backOnPod).toBe("rp-web-b");
    await page.keyboard.press("ControlOrMeta+J");
    await jump(page).getByRole("menuitem", { name: "events 2" }).hover();
    await expect(jump(page).locator("[data-active]")).toContainText("events");
    await page.keyboard.press("Shift+Enter");
    await expect.poll(shown).toBe("rel-events shop re-1,re-2");
    expect(Object.keys((await inspect(page)).panes)).toHaveLength(2);

    // cluster-scoped: a node's events are found in any namespace
    await openRel(page, "rel-nodes", 2);
    await select(page, "rnd-1");
    await page.keyboard.press("v");
    await expect.poll(async () => {
      const p = await focused(page);
      return p.status?.synced ? `${p.spec.resource} ${(p.spec as { namespace?: string }).namespace ?? ""} ${p.rows.map((r) => r.key)}` : "";
    }).toBe("rel-events  re-6");
  });

  test("⌘O to a new source is a step in the history as a jump is; the same source or a filter edit isn't", async ({ page }) => {
    await openRel(page, "rel-pods", 6);
    await leads(page, "back", "pods"); // the launch view
    await select(page, "rp-web-b");
    const reopen = async (resource: string, namespace?: string) => {
      await page.keyboard.press("ControlOrMeta+O");
      await page.getByRole("combobox", { name: "resource" }).fill(resource);
      if (namespace !== undefined) await page.getByRole("combobox", { name: "namespace" }).fill(namespace);
      await page.getByRole("combobox", { name: "resource" }).press("Enter");
    };
    await reopen("rel-deployments");
    await expect.poll(async () => (await focused(page)).spec.resource).toBe("rel-deployments");
    await leads(page, "back", "rel-pods");
    // ⌘←: the pods again, with the row that was selected
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect.poll(async () => {
      const p = await focused(page);
      return p.spec.resource === "rel-pods" && p.status?.synced ? p.rows[p.selected]?.key : "";
    }).toBe("rp-web-b");
    await leads(page, "forward", "rel-deployments");
    // the same source again, or a grep: no step (the forward history stays)
    await reopen("rel-pods");
    await page.keyboard.press("/");
    await page.keyboard.type("web");
    await expect.poll(async () => (await focused(page)).spec.grep).toBe("web");
    await page.keyboard.press("Escape");
    await leads(page, "back", "pods");
    await leads(page, "forward", "rel-deployments");
    // only the namespace changes: a step, and as a new navigation it drops the forward history
    await reopen("rel-pods", "shop");
    await expect.poll(async () => ((await focused(page)).spec as { namespace?: string }).namespace).toBe("shop");
    await leads(page, "back", "rel-pods");
    await leads(page, "forward", null);
    // back to all namespaces, the grep still there (filters belong to the view)
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect.poll(async () => {
      const p = await focused(page);
      return `${p.spec.resource} ${(p.spec as { namespace?: string }).namespace ?? ""} ${p.spec.grep}`;
    }).toBe("rel-pods  web");
  });

  test("← / → buttons as in a browser: greyed out with nowhere to go, a click is one step, holding lists the history", async ({ page }) => {
    await openRel(page, "rel-pods", 6);
    await select(page, "rp-web-b");
    await page.keyboard.press("ControlOrMeta+J");
    await jump(page).getByRole("menuitem", { name: /replicaset web-7d9f/ }).click();
    await expect.poll(async () => {
      const p = await focused(page);
      return p.status?.synced ? `${p.spec.resource} ${p.rows.map((r) => r.key)}` : "";
    }).toBe("rel-replicasets rr-web-7d9f");
    await page.keyboard.press("ControlOrMeta+J");
    await jump(page).getByRole("menuitem", { name: /deployment web/ }).click();
    await expect.poll(async () => (await focused(page)).spec.resource).toBe("rel-deployments");
    await leads(page, "forward", null);

    // a click: one step back, the row selected again; focus stays on the table
    await (await nav(page, "back")).click();
    await expect.poll(async () => {
      const p = await focused(page);
      return p.spec.resource === "rel-replicasets" && p.status?.synced ? p.rows[p.selected]?.key : "";
    }).toBe("rr-web-7d9f");
    expect((await inspect(page)).focus).toBe("table");
    await leads(page, "forward", "rel-deployments");
    await (await nav(page, "forward")).click();
    await expect.poll(async () => (await focused(page)).spec.resource).toBe("rel-deployments");

    // holding ←: the back history below it, nearest first; nothing moved yet
    const list = page.getByRole("menu", { name: "back history" });
    const back = await nav(page, "back");
    await back.hover();
    await page.mouse.down();
    await expect(list).toBeVisible();
    await page.mouse.up();
    await expect(list).toBeVisible(); // the release ends the hold, not the list
    expect((await focused(page)).spec.resource).toBe("rel-deployments");
    await expect(list.getByRole("menuitem")).toHaveText([/^rel-replicasets -n shop/, /^rel-pods -A/, /^pods /]);
    await expect(list.locator("[data-active]")).toContainText("rel-replicasets");
    expect((await inspect(page)).focus).toBe("menu");
    // keys as in any menu: j moves, esc closes, nothing happened
    await page.keyboard.press("j");
    await expect(list.locator("[data-active]")).toContainText("rel-pods");
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    expect((await inspect(page)).focus).toBe("table");
    expect((await focused(page)).spec.resource).toBe("rel-deployments");

    // right-click opens it too; a click elsewhere closes it
    await back.click({ button: "right" });
    await expect(list).toBeVisible();
    await page.locator("section[data-pane] header").getByLabel("filter").click();
    await expect(list).toHaveCount(0);
    expect((await focused(page)).spec.resource).toBe("rel-deployments");

    // picking an entry two steps back goes there at once; what it passed over is forward now
    await back.click({ button: "right" });
    await list.getByRole("menuitem", { name: /^rel-pods/ }).click();
    await expect(list).toHaveCount(0);
    await expect.poll(async () => {
      const p = await focused(page);
      return p.spec.resource === "rel-pods" && p.status?.synced ? p.rows[p.selected]?.key : "";
    }).toBe("rp-web-b");
    await leads(page, "back", "pods");
    await leads(page, "forward", "rel-replicasets");
    const fwd = page.getByRole("menu", { name: "forward history" });
    await (await nav(page, "forward")).click({ button: "right" });
    await expect(fwd.getByRole("menuitem")).toHaveText([/^rel-replicasets/, /^rel-deployments/]);
    // ⏎ on the highlight (j stops at the last one)
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await focused(page)).spec.resource).toBe("rel-deployments");
    await leads(page, "forward", null);
    await expect(await nav(page, "forward")).toBeDisabled();
  });

  test("⌘O after a jump to events: the field selector stays behind (no field for it in the dialog)", async ({ page }) => {
    await openRel(page, "rel-pods", 6);
    await select(page, "rp-web-b");
    await page.keyboard.press("v");
    await expect(page.getByLabel("field selector")).toHaveText("involvedObject.kind=Pod,involvedObject.name=web-7d9f-b");
    await page.keyboard.press("ControlOrMeta+O");
    await page.getByRole("combobox", { name: "resource" }).fill("rel-pods");
    await page.keyboard.press("Enter");
    await expect.poll(async () => {
      const p = await focused(page);
      const spec = p.spec as { namespace?: string; fieldSelector?: string };
      return p.spec.resource === "rel-pods" && p.status?.synced ? `${spec.namespace}|${spec.fieldSelector ?? ""}|${p.rows.map((r) => r.key).sort()}` : "";
    }).toBe("shop||rp-gizmo-0,rp-orphan-0,rp-web-a,rp-web-b,rp-web-stray"); // the events' namespace kept, every pod in it
    await expect(page.getByLabel("field selector")).toHaveCount(0);
    // the events view is a step back, with its selector
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect(page.getByLabel("field selector")).toHaveText("involvedObject.kind=Pod,involvedObject.name=web-7d9f-b");
  });

  test("⌘O after a jump to an owner: the jump's CEL filter stays behind, one typed since stays", async ({ page }) => {
    await openRel(page, "rel-pods", 6);
    const toOwner = async () => {
      await select(page, "rp-web-b");
      await page.keyboard.press("ControlOrMeta+J");
      await expect(jump(page).locator("[data-active]")).toContainText("replicaset web-7d9f");
      await page.keyboard.press("j");
      await expect(jump(page).locator("[data-active]")).toContainText("deployment web");
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("cel")).toHaveValue('o.metadata.name == "web"');
    };
    const shown = async () => {
      const p = await focused(page);
      return p.spec.resource === "rel-deployments" && p.status?.synced ? `${p.spec.filter}|${p.rows.map((r) => r.key).sort()}` : "";
    };
    const reopen = async () => {
      await page.keyboard.press("ControlOrMeta+O");
      await expect(page.getByRole("combobox", { name: "resource" })).toHaveValue("rel-deployments");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog", { name: "open source" })).toHaveCount(0);
    };
    // ⌘O ⏎ on the same resource: every deployment, the filter field empty
    await toOwner();
    await reopen();
    await expect.poll(shown).toBe("|rd-api,rd-web");
    await expect(page.getByLabel("cel")).toHaveValue("");
    // a filter typed over the jump's is the user's: ⌘O keeps it
    await page.keyboard.press("ControlOrMeta+ArrowLeft"); // the same source again wasn't a navigation: back on the pods
    // with the row it had selected restored (else that lands amid select's keys)
    await expect.poll(async () => {
      const p = await focused(page);
      return p.spec.resource === "rel-pods" && p.status?.synced ? p.rows[p.selected]?.key : "";
    }).toBe("rp-web-b");
    await toOwner();
    await page.getByLabel("cel").fill('o.metadata.name == "api"');
    await page.keyboard.press("Enter");
    await expect.poll(shown).toBe('o.metadata.name == "api"|rd-api');
    await page.keyboard.press("Escape");
    expect((await inspect(page)).focus).toBe("table");
    await reopen();
    await expect.poll(shown).toBe('o.metadata.name == "api"|rd-api');
  });

  test("a new jump after going back drops the forward history", async ({ page }) => {
    await openRel(page, "rel-pods", 6);
    await select(page, "rp-web-a");
    await page.keyboard.press("ControlOrMeta+J");
    await jump(page).getByRole("menuitem", { name: /replicaset web-7d9f/ }).click();
    await expect.poll(async () => (await focused(page)).spec.resource).toBe("rel-replicasets");
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await leads(page, "forward", "rel-replicasets");
    await expect.poll(async () => (await focused(page)).rows.length).toBe(6);
    await select(page, "rp-web-a");
    await page.keyboard.press("ControlOrMeta+J");
    await jump(page).getByRole("menuitem", { name: /deployment web/ }).click();
    await expect.poll(async () => (await focused(page)).spec.resource).toBe("rel-deployments");
    await leads(page, "forward", null);
    await page.keyboard.press("ControlOrMeta+ArrowRight");
    await expect(page.getByLabel("message")).toContainText("nothing to go forward to");
  });

  test("deployment → owned replica sets and pods (counted); ⇧⏎ opens a split below", async ({ page }) => {
    await openRel(page, "rel-deployments", 2);
    await select(page, "rd-web");
    await page.keyboard.press("ControlOrMeta+J");
    await expect(jump(page).getByRole("menuitem", { name: "rel-replicasets 1" })).toBeVisible();
    // the stray pod matches the selector (counted), lab's doesn't
    await expect(jump(page).getByRole("menuitem", { name: "rel-pods 3" })).toBeVisible();
    await expect(jump(page).getByRole("menuitem", { name: /no owner/ })).toBeDisabled();
    await expect(jump(page).locator("[data-active]")).toContainText("rel-replicasets");
    await page.keyboard.press("Shift+Enter");
    await expect.poll(async () => (await inspect(page)).tabs[(await inspect(page)).activeTab]!.focused).not.toBe("v1");
    await expect.poll(async () => {
      const p = await focused(page);
      return p.status?.synced ? `${p.spec.resource} ${p.spec.filter} ${p.rows.map((r) => r.key)}` : "";
    }).toBe('rel-replicasets o.metadata.ownerReferences.exists(r, r.uid == "rd-web") rr-web-7d9f');
    // a split has no back stack of its own (the pane it came from has the launch view behind it)
    const split = (await inspect(page)).focusedPane;
    await leads(page, "back", null, split);
    await leads(page, "back", "pods", "v1");
  });

  test("gone owners are listed disabled with why; a custom resource's owned scan finds config maps", async ({ page }) => {
    await openRel(page, "rel-pods", 6);
    await select(page, "rp-orphan-0");
    await page.keyboard.press("ControlOrMeta+J");
    await expect(jump(page).getByRole("menuitem", { name: /replicaset old-5c4b/ })).toBeDisabled();
    await expect(jump(page).getByRole("menuitem", { name: /replicaset old-5c4b/ })).toContainText("deleted");
    await page.keyboard.press("Escape");
    expect((await inspect(page)).focus).toBe("table");

    await openRel(page, "rel-widgets", 1);
    await page.keyboard.press("ControlOrMeta+J");
    // the CRD's scale subresource: the pods its selector matches
    await expect(jump(page).getByRole("menuitem", { name: "rel-pods 1" })).toBeVisible();
    await jump(page).getByRole("menuitem", { name: /scan for owned/ }).click();
    // tape resource names; the pods are already listed above (same kind), so not repeated
    await expect(jump(page).getByRole("menuitem", { name: "rel-configmaps 2" })).toBeVisible();
    await expect(jump(page).getByRole("menuitem", { name: /^rel-pods/ })).toHaveCount(1); // the known entry only
    await expect(jump(page).getByRole("menuitem", { name: /scan done/ })).toContainText("scanned 8 types");
    await jump(page).getByRole("menuitem", { name: "rel-configmaps 2" }).click();
    await expect.poll(async () => {
      const p = await focused(page);
      return p.status?.synced ? p.rows.map((r) => r.key).join(" ") : "";
    }).toBe("rc-gizmo-config rc-gizmo-scripts");
  });

  test("a namespace jumps to its pods; a claim to its volume and attachments, a volume to its attachments", async ({ page }) => {
    const shown = async () => {
      const p = await focused(page);
      return p.status?.synced ? `${p.spec.resource} ${(p.spec as { namespace?: string }).namespace ?? ""} ${p.rows.map((r) => r.key).sort()}` : "";
    };
    await openRel(page, "rel-namespaces", 2);
    await select(page, "rn-shop");
    await page.keyboard.press("ControlOrMeta+J");
    await jump(page).getByRole("menuitem", { name: "rel-pods 5" }).click();
    await expect.poll(shown).toBe("rel-pods shop rp-gizmo-0,rp-orphan-0,rp-web-a,rp-web-b,rp-web-stray");

    await openRel(page, "rel-pvcs", 7);
    await select(page, "rpvc-data-0");
    await page.keyboard.press("ControlOrMeta+J");
    await expect(jump(page)).toMatchAriaSnapshot(`
      - menu "jump from data-0":
        - text: jump from persistentvolumeclaim data-0 · shop ⏎ here · ⇧⏎ split
        - separator "namespace"
        - menuitem "rel-pvcs in shop"
        - menuitem "namespace object shop"
        - separator "owners"
        - menuitem "no owner · no ownerReferences" [disabled]
        - separator "owned"
        - menuitem "scan for owned… in shop"
        - separator "references"
        - menuitem "persistentvolume pv-data-0"
        - menuitem "rel-volumeattachments 2"
        - separator "events"
        - menuitem "events 0"
    `);
    // straight to the attachments, by the volume's name (CEL: no field selector for it)
    await jump(page).getByRole("menuitem", { name: "rel-volumeattachments 2" }).click();
    await expect.poll(shown).toBe("rel-volumeattachments  rva-a,rva-b");
    await expect(page.getByLabel("cel")).toHaveValue('o.spec.source.persistentVolumeName == "pv-data-0"');
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect.poll(async () => (await focused(page)).rows[(await focused(page)).selected]?.key).toBe("rpvc-data-0");

    // via the volume: from there, its attachments
    await page.keyboard.press("ControlOrMeta+J");
    await jump(page).getByRole("menuitem", { name: "persistentvolume pv-data-0" }).click();
    await expect.poll(shown).toBe("rel-pvs  rpv-data-0");
    await page.keyboard.press("ControlOrMeta+J");
    await expect(jump(page).getByRole("menuitem", { name: "persistentvolumeclaim data-0" })).toBeVisible();
    await jump(page).getByRole("menuitem", { name: "rel-volumeattachments 2" }).click();
    await expect.poll(shown).toBe("rel-volumeattachments  rva-a,rva-b");

    // a pending claim has no volume yet
    await openRel(page, "rel-pvcs", 7);
    await select(page, "rpvc-pending");
    await page.keyboard.press("ControlOrMeta+J");
    await expect(jump(page).getByRole("menuitem", { name: /^persistentvolume/ })).toContainText("not bound");
    await expect(jump(page).getByRole("menuitem", { name: /^persistentvolume/ })).toBeDisabled();
  });

  test("a pod jumps to its claims, their volumes and the volumes' attachments", async ({ page }) => {
    await openRel(page, "rel-pods", 6);
    await select(page, "rp-gizmo-0");
    await page.keyboard.press("ControlOrMeta+J");
    // in volume order (the ephemeral volume's claim too), each claim followed by its volume; the config map volume isn't listed
    await expect(jump(page)).toMatchAriaSnapshot(`
      - menu "jump from gizmo-0":
        - text: jump from pod gizmo-0 · shop ⏎ here · ⇧⏎ split
        - separator "namespace"
        - menuitem "rel-pods in shop"
        - menuitem "namespace object shop"
        - separator "owners"
        - menuitem "widget gizmo controller"
        - separator "owned"
        - menuitem "scan for owned… in shop"
        - separator "references"
        - menuitem "persistentvolumeclaim data-0"
        - menuitem "persistentvolume pv-data-0"
        - menuitem "persistentvolumeclaim gizmo-0-scratch"
        - menuitem "persistentvolume pv-scratch"
        - menuitem "persistentvolumeclaim cache · not found" [disabled]
        - menuitem "rel-volumeattachments 3"
        - separator "events"
        - menuitem "events 0"
    `);
    const shown = async () => {
      const p = await focused(page);
      return p.status?.synced ? `${p.spec.resource} ${(p.spec as { namespace?: string }).namespace ?? ""} ${p.rows.map((r) => r.key).sort()}` : "";
    };
    await jump(page).getByRole("menuitem", { name: "rel-volumeattachments 3" }).click();
    await expect.poll(shown).toBe("rel-volumeattachments  rva-a,rva-b,rva-scratch");
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect.poll(async () => (await focused(page)).rows[(await focused(page)).selected]?.key).toBe("rp-gizmo-0");
    await page.keyboard.press("ControlOrMeta+J");
    await jump(page).getByRole("menuitem", { name: "persistentvolumeclaim gizmo-0-scratch" }).click();
    await expect.poll(shown).toBe("rel-pvcs shop rpvc-scratch");
  });

  test("a stateful set jumps to its claims, their volumes and attachments, each as one counted entry", async ({ page }) => {
    await openRel(page, "rel-statefulsets", 3);
    await select(page, "rss-db");
    await page.keyboard.press("ControlOrMeta+J");
    // db's claims by the controller's names (not dbx's namesakes)
    await expect(jump(page)).toMatchAriaSnapshot(`
      - menu "jump from db":
        - text: jump from statefulset db · shop ⏎ here · ⇧⏎ split
        - separator "namespace"
        - menuitem "rel-statefulsets in shop"
        - menuitem "namespace object shop"
        - separator "owners"
        - menuitem "no owner · no ownerReferences" [disabled]
        - separator "owned"
        - menuitem "rel-pods · none 0" [disabled]
        - menuitem "scan for owned… in shop"
        - separator "references"
        - menuitem "rel-pvcs 2"
        - menuitem "rel-pvs 2"
        - menuitem "rel-volumeattachments 1"
        - separator "events"
        - menuitem "events 0"
    `);
    const shown = async () => {
      const p = await focused(page);
      return p.status?.synced ? `${p.spec.resource} ${(p.spec as { namespace?: string }).namespace ?? ""} ${p.rows.map((r) => r.key).sort()}` : "";
    };
    await jump(page).getByRole("menuitem", { name: "rel-pvcs 2" }).click();
    await expect.poll(shown).toBe("rel-pvcs shop rpvc-db-0,rpvc-db-1");
    await expect(page.getByLabel("cel")).toHaveValue('o.metadata.name.matches("^(data)-db-[0-9]+$")');
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect.poll(async () => (await focused(page)).rows[(await focused(page)).selected]?.key).toBe("rss-db");
    await page.keyboard.press("ControlOrMeta+J");
    await jump(page).getByRole("menuitem", { name: "rel-pvs 2" }).click();
    await expect.poll(shown).toBe("rel-pvs  rpv-db-0,rpv-db-1");
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect.poll(async () => (await focused(page)).rows[(await focused(page)).selected]?.key).toBe("rss-db");
    await page.keyboard.press("ControlOrMeta+J");
    await jump(page).getByRole("menuitem", { name: "rel-volumeattachments 1" }).click();
    await expect.poll(shown).toBe("rel-volumeattachments  rva-db-1");
  });

  test("the ⌘⏎ menu's jump to… opens the jump menu in its place", async ({ page }) => {
    await openRel(page, "rel-pods", 6);
    await select(page, "rp-web-a");
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.getByRole("menu").getByRole("menuitem", { name: "jump to… ⌘J" }).click();
    await expect(jump(page)).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect((await inspect(page)).focus).toBe("table");
  });
});
