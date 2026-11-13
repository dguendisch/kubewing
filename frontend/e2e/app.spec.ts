import { expect, test, type Page } from "@playwright/test";

type Inspect = {
  focus: string;
  focusedPane: string;
  overlays: string[];
  /** The active tab's object views, by pane. */
  objects: Record<string, { key: string; view: string; diff: boolean; split: boolean; from?: string; follow: boolean; followOff?: string; decoded: number; editing: boolean; editLevels: number; title?: string }>;
  cursor: number;
  decodeCursor: number;
  editCursor: number;
  place?: { line: number; col: number };
  selected?: string;
  activeTab: number;
  tabs: { id: string; focused: string; layout: unknown }[];
  panes: Record<string, { spec: { resource: string; grep: string; filter: string; labelSelector?: string; sort?: string }; serverId?: string; total: number; selected: number; type?: string; view?: { columns?: { name: string; path?: string; expr?: string }[]; widths?: Record<string, number> }; columns: string[]; rows: { key: string; cells: string[]; mark?: string; changed?: number[]; marked?: boolean }[]; status?: { synced: boolean; at?: string; recording?: boolean; marked?: number }; textSel?: { key: string; column: string; text: string; start: number; end: number; age?: boolean }; logs?: { session: string; title: string; filter: string; timestamps: boolean; follow: boolean; exited?: string } }>;
  logs?: Record<string, { lines: number; streams: { pod: string; container: string; state: string }[]; dropped: number; screen: string; viewportY: number; length: number; rows: number }>;
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

/** What was the detail overlay: the focused pane shows an object (in place or in a split), nothing over it. */
const viewing = async (page: Page) => {
  const s = await inspect(page);
  return s.overlays.length === 0 && !!s.objects[s.focusedPane];
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

test("a large list shows its progress while syncing, until the objects arrive", async ({ page }) => {
  // e2e-slow: the list takes 2s, reporting 1,500 of 4,213 objects meanwhile
  await ready(page);
  await page.keyboard.press("ControlOrMeta+O");
  await page.getByRole("combobox", { name: "resource" }).fill("e2e-slow");
  await page.keyboard.press("Enter");
  const status = page.getByRole("status", { name: "pane status" });
  await expect(status.getByLabel("syncing")).toHaveText("● syncing 35% (1,500/4,213)");
  await expect.poll(async () => (await focused(page)).status?.synced, tapeSteps).toBe(true);
  await expect(status.getByLabel("syncing")).toHaveCount(0);
  await expect(status).toContainText("1 shown / 1 objects");
});

test.describe("columns (per resource type)", () => {
  // one backend serves the whole run, and columns.yaml with it: leave e2e-wide and nodes as they were
  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      const b = (window as unknown as { __kw: { bridge(): { setTypeMetrics(t: string, g: string, c: null, p: null): Promise<void>; setColumnWidths(t: string, w: null): Promise<void> } } }).__kw.bridge();
      // the columns and both metric groups' saved places
      for (const t of ["e2e-wide", "nodes"]) {
        await b.setTypeMetrics(t, "usage", null, null);
        await b.setTypeMetrics(t, "alloc", null, null);
        await b.setColumnWidths(t, null);
      }
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
    await expect(columnList(page)).toHaveText([/NAMESPACE/, /NAME/, /STATUS/, /AGE/, /IP\s*wide/, /NODE\s*wide/, /CPU\s*metrics/, /%CPU\/R/, /%CPU\/L/, /MEM\s*metrics/, /%MEM\/R/, /%MEM\/L/]);
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
    await expect(options).toHaveText([/NAMESPACE/, /STATUS/, /NAME/, /AGE/, /HOST\s*spec\.nodeName/, /IP/, /NODE/, /CPU/, /%CPU\/R/, /%CPU\/L/, /MEM/, /%MEM\/R/, /%MEM\/L/]);
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

  test("keyboard only: ⏎ completes a path step by step, adds it, saves from the empty fields; ⌫ keeps the focus in the list", async ({ page }) => {
    await openTape(page, "e2e-wide", 2);
    await page.keyboard.press("o");
    const path = dialog(page).getByRole("combobox", { name: "column path" });
    const suggestions = dialog(page).getByRole("listbox", { name: "column path suggestions" });
    await path.focus();
    await page.keyboard.type("sp");
    await page.keyboard.press("Enter");
    // a map key is a step: the list goes on with its keys, no ↓ needed
    await expect(path).toHaveValue("spec.");
    await expect(suggestions).toContainText("nodeName");
    await page.keyboard.type("nod");
    await page.keyboard.press("Enter");
    await expect(path).toHaveValue("spec.nodeName");
    await expect(suggestions).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(columnList(page)).toHaveText([/NAMESPACE/, /NAME/, /STATUS/, /AGE/, /NODENAME\s*spec\.nodeName/, /IP/, /NODE/, /CPU/, /%CPU\/R/, /%CPU\/L/, /MEM/, /%MEM\/R/, /%MEM\/L/]);
    await expect(path).toHaveValue("");
    // ⏎ again, with nothing to add: saves
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeHidden();
    await expect.poll(async () => (await focused(page)).columns).toEqual(["NAMESPACE", "NAME", "STATUS", "AGE", "NODENAME"]);

    await page.keyboard.press("o");
    await columnList(page).nth(4).focus();
    await page.keyboard.press("Delete");
    await expect(columnList(page)).toHaveText([/NAMESPACE/, /NAME/, /STATUS/, /AGE/, /IP/, /NODE/, /CPU/, /%CPU\/R/, /%CPU\/L/, /MEM/, /%MEM\/R/, /%MEM\/L/]);
    await expect(columnList(page).nth(4)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeHidden();
    await expect.poll(async () => (await focused(page)).columns).toEqual(["NAMESPACE", "NAME", "STATUS", "AGE"]);
  });

  test("⌫ on a completed path's final dot stops there: the list closes and ⏎ adds the map itself", async ({ page }) => {
    await openTape(page, "e2e-wide", 2);
    await page.keyboard.press("o");
    const path = dialog(page).getByRole("combobox", { name: "column path" });
    const suggestions = dialog(page).getByRole("listbox", { name: "column path suggestions" });
    await path.focus();
    await page.keyboard.type("sp");
    await page.keyboard.press("Enter");
    await expect(path).toHaveValue("spec.");
    await expect(suggestions).toBeVisible();
    await page.keyboard.press("Backspace");
    await expect(path).toHaveValue("spec");
    await expect(suggestions).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(columnList(page).nth(4)).toHaveText(/SPEC\s*spec(?!\.)/);
    await expect(path).toHaveValue("");
    // ↓ still opens the list there, and typing on does too
    await page.keyboard.type("spec.");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("ArrowDown");
    await expect(suggestions).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.type(".");
    await expect(suggestions).toContainText("nodeName");
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
    await expect(columnList(page)).toHaveText([/NAMESPACE/, /AGE/, /NAME/, /STATUS/, /IP/, /NODE/, /CPU/, /%CPU\/R/, /%CPU\/L/, /MEM/, /%MEM\/R/, /%MEM\/L/]);
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

  test("m: the metric columns (kubectl top) for the type, filled from the polled usage; m again hides them", async ({ page }) => {
    await openTape(page, "e2e-wide", 2);
    await page.keyboard.press("ControlOrMeta+D"); // a second pane of the type
    await expect.poll(async () => (await focused(page)).columns).toEqual(["NAMESPACE", "NAME", "STATUS", "AGE"]);
    await page.keyboard.press("m");
    // right after NAME
    const top = ["NAMESPACE", "NAME", "CPU", "%CPU/R", "%CPU/L", "MEM", "%MEM/R", "%MEM/L", "STATUS", "AGE"];
    await expect.poll(async () => (await focused(page)).columns).toEqual(top);
    await expect(page.getByLabel("message")).toContainText("metrics on");
    // web-0 requests 500m/256Mi and is limited to 1/1Gi; web-1 sets nothing (no percentages)
    await expect.poll(async () => (await focused(page)).rows.map((r) => r.cells.slice(2, 8))).toEqual([
      ["250m", "50%", "25%", "128.0Mi", "50%", "12%"],
      ["1200m", "", "", "64.0Mi", "", ""],
    ]);
    // the other pane follows
    await expect.poll(async () => Object.values((await inspect(page)).panes).filter((p) => p.spec.resource === "e2e-wide").map((p) => p.columns)).toEqual([top, top]);
    // the column dialog shows them as the metrics switch
    await page.keyboard.press("o");
    await expect(page.getByLabel("metrics", { exact: true })).toBeChecked();
    await page.keyboard.press("Escape");
    await page.keyboard.press("m");
    await expect.poll(async () => (await focused(page)).columns).toEqual(["NAMESPACE", "NAME", "STATUS", "AGE"]);
  });

  test("metric columns start narrow; a dragged width stays across m off and on", async ({ page }) => {
    await openTape(page, "e2e-wide", 2);
    await page.keyboard.press("m");
    await expect.poll(async () => (await focused(page)).columns).toContain("CPU");
    // NAMESPACE 120, NAME 260 (it grows into the free width: measured from the right instead) — CPU's edge is
    // found by its default width of 64 after NAME's end; NAME's end is where CPU's header starts
    const box = (await page.locator("section[data-pane] canvas").first().boundingBox())!;
    const y = box.y + 12;
    // the metric columns and STATUS/AGE after them: 64+68+68+72+68+68 + 120 + 70 from the right edge
    const cpuStart = box.x + box.width - (64 + 68 + 68 + 72 + 68 + 68 + 120 + 70);
    await page.mouse.move(cpuStart + 63, y);
    await page.mouse.down();
    await page.mouse.move(cpuStart + 80, y, { steps: 4 });
    await page.mouse.move(cpuStart + 100, y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await focused(page)).view?.widths?.["CPU"]).toBe(100);
    await page.keyboard.press("m");
    await expect.poll(async () => (await focused(page)).columns).not.toContain("CPU");
    await page.keyboard.press("m");
    await expect.poll(async () => (await focused(page)).columns).toContain("CPU");
    expect((await focused(page)).view?.widths?.["CPU"]).toBe(100);
  });

  test("moved metric columns come back where they were after m off and on, here and from the dialog", async ({ page }) => {
    await openTape(page, "e2e-wide", 2);
    await page.keyboard.press("m");
    await expect.poll(async () => (await focused(page)).columns).toEqual(["NAMESPACE", "NAME", "CPU", "%CPU/R", "%CPU/L", "MEM", "%MEM/R", "%MEM/L", "STATUS", "AGE"]);
    // STATUS moved before them (⌥↑ six times), and MEM before CPU
    await page.keyboard.press("o");
    await columnList(page).nth(8).focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press("Alt+ArrowUp");
    await columnList(page).nth(6).focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("Alt+ArrowUp");
    await page.keyboard.press("Enter");
    const moved = ["NAMESPACE", "NAME", "STATUS", "MEM", "CPU", "%CPU/R", "%CPU/L", "%MEM/R", "%MEM/L", "AGE"];
    await expect.poll(async () => (await focused(page)).columns).toEqual(moved);
    await page.keyboard.press("m");
    await expect.poll(async () => (await focused(page)).columns).toEqual(["NAMESPACE", "NAME", "STATUS", "AGE"]);
    await page.keyboard.press("m");
    await expect.poll(async () => (await focused(page)).columns).toEqual(moved);
    // the dialog's switch too: off and OK, then on and OK
    await page.keyboard.press("o");
    await page.getByLabel("metrics", { exact: true }).uncheck();
    await dialog(page).getByRole("button", { name: "OK" }).click();
    await expect.poll(async () => (await focused(page)).columns).toEqual(["NAMESPACE", "NAME", "STATUS", "AGE"]);
    await page.keyboard.press("o");
    await page.getByLabel("metrics", { exact: true }).check();
    await dialog(page).getByRole("button", { name: "OK" }).click();
    await expect.poll(async () => (await focused(page)).columns).toEqual(moved);
  });

  test("metrics without metrics-server: empty usage cells and a hint; the nodes' requests and limits still; not offered for other kinds", async ({ page }) => {
    await openTape(page, "nodes", 3);
    const status = page.getByRole("status", { name: "pane status" });
    // m: only the usage columns
    await page.keyboard.press("m");
    await expect.poll(async () => (await focused(page)).columns).toEqual(["NAMESPACE", "NAME", "CPU", "%CPU", "MEM", "%MEM", "STATUS"]);
    await expect(status.getByLabel("metrics hint")).toContainText("metrics unavailable");
    expect((await focused(page)).rows.map((r) => r.cells.slice(2, 6).join(""))).toEqual(["", "", ""]);
    await page.keyboard.press("m");
    await expect(status.getByLabel("metrics hint")).toHaveCount(0);

    // ⇧M: the requests and limits of the nodes' pods (unfinished-pods.yaml), no metrics-server needed, as kubectl describe node;
    // listing the pods takes a while (the tape's 1s): the status line says so meanwhile
    await page.keyboard.press("Shift+M");
    const alloc = ["%CPU REQ", "%CPU LIM", "%MEM REQ", "%MEM LIM", "%EPH REQ", "%EPH LIM", "PODS", "%PODS", "%nvidia.com/gpu REQ"];
    await expect.poll(async () => (await focused(page)).columns).toEqual(["NAMESPACE", "NAME", ...alloc, "STATUS"]);
    await expect(status.getByLabel("requests/limits loading")).toHaveText("loading requests/limits…");
    // 1500m and 4Gi requested of 2 cpu / 8Gi, 1 cpu limited, 5Gi/10Gi of 50Gi ephemeral storage, 2 of 10 pods, 1 of 2 GPUs;
    // the init container counts as the max (1 cpu), a node without GPUs has no GPU percentage; a node without pods
    await expect.poll(async () => (await focused(page)).rows.map((r) => r.cells.slice(2, 11))).toEqual([
      ["75%", "50%", "50%", "0%", "10%", "20%", "2", "20%", "50%"],
      ["50%", "0%", "0%", "0%", "0%", "0%", "1", "10%", ""],
      ["0%", "0%", "0%", "0%", "0%", "0%", "0", "0%", ""],
    ]);
    await expect(status.getByLabel("requests/limits loading")).toHaveCount(0);
    // m and ⇧M are independent: with both on, requests/limits stay where they are
    await page.keyboard.press("m");
    await expect.poll(async () => (await focused(page)).columns).toEqual(["NAMESPACE", "NAME", "CPU", "%CPU", "MEM", "%MEM", ...alloc, "STATUS"]);
    await page.keyboard.press("Shift+M");
    await expect.poll(async () => (await focused(page)).columns).toEqual(["NAMESPACE", "NAME", "CPU", "%CPU", "MEM", "%MEM", "STATUS"]);
    await page.keyboard.press("m");

    await openTape(page, "e2e-deploys");
    await page.keyboard.press("m");
    await expect(page.getByLabel("message")).toContainText("metrics (kubectl top) are for pods and nodes");
    await page.keyboard.press("Shift+M");
    await expect(page.getByLabel("message")).toContainText("requests/limits of their pods are for nodes");
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

test("filter bar: / focuses, grep narrows rows, esc puts the previous grep back and returns to table", async ({ page }) => {
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
  await expect(page.getByLabel("filter")).toHaveValue("");
  await expect.poll(async () => (await focused(page)).total).toBe(3);
  // ⏎ keeps it; esc goes back to that, not to empty
  await page.keyboard.press("/");
  await page.keyboard.type("etcd");
  await page.keyboard.press("Enter");
  await page.keyboard.press("/");
  await page.keyboard.type(" !x");
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("filter")).toHaveValue("etcd");
  expect((await focused(page)).spec.grep).toBe("etcd");
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

test("grep: a held-back term after an applied grep keeps the field (regression: it reset to the applied part)", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("/");
  const field = page.getByLabel("filter", { exact: true });
  for (const [typed, applied] of [["etcd | ", "etcd | "], ["a", "etcd"], ["pi-1", "etcd"]] as const) {
    await page.keyboard.type(typed);
    await expect.poll(async () => (await focused(page)).spec.grep).toBe(applied);
    await page.waitForTimeout(250); // slower than the debounce
  }
  await expect(field).toHaveValue("etcd | api-1");
  await expect(page.getByRole("status", { name: "grep draft" })).toContainText("| api-1 · ⏎ apply");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await focused(page)).rows.map((r) => r.cells[1]).sort()).toEqual(["api-1", "etcd-0"]);
  // the same for a negated term
  await page.keyboard.press("/");
  await field.fill("api ");
  await expect.poll(async () => (await focused(page)).spec.grep).toBe("api ");
  await page.keyboard.type("!api-1");
  await page.waitForTimeout(250);
  await expect(field).toHaveValue("api !api-1");
  // ^ and $ anchor to a cell
  await field.fill("^api -0$");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await focused(page)).rows.map((r) => r.cells[1])).toEqual(["api-0"]);
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

test("label selector: click or l focuses it and keeps focus while typing, ⏎ goes back to the table; tab moves between the filter fields", async ({ page }) => {
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
  // ⏎ applies and goes back to the list, like grep's
  await expect(labels).not.toBeFocused();
  expect((await inspect(page)).focus).toBe("table");
  await labels.click();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByLabel("filter", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(labels).toBeFocused();
  expect((await inspect(page)).focus).toBe("filter");
  await page.keyboard.press("Escape");
  expect((await inspect(page)).focus).toBe("table");
  await expect(labels).not.toBeFocused();
  // / and ⇥ from the table land in the label field (l is the logs' key)
  await page.keyboard.press("/");
  await page.keyboard.press("Tab");
  await expect(labels).toBeFocused();
  await expect(labels).toHaveValue("app=api");
  // esc drops a draft: the applied selector comes back, nothing applied
  await page.keyboard.type(",tier=x");
  await page.keyboard.press("Escape");
  if ((await inspect(page)).focus !== "table") await page.keyboard.press("Escape"); // the first may only close the suggestions
  expect((await inspect(page)).focus).toBe("table");
  await expect(labels).toHaveValue("app=api");
  expect((await focused(page)).spec.labelSelector).toBe("app=api");
  // back in the field, the shorter value from esc completes as before (the caret was past its end)
  await page.keyboard.press("/");
  await page.keyboard.press("Tab");
  await expect(labels).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(",ap");
  await expect(page.getByRole("listbox", { name: "label suggestions" }).getByRole("option").first()).toContainText("app");
  await page.keyboard.press("Escape");
  if ((await inspect(page)).focus !== "table") await page.keyboard.press("Escape");
  await page.keyboard.press("/");
  await expect(page.getByLabel("filter", { exact: true })).toBeFocused();
});

test("label selector completes keys and values from the live objects; ↓ opens the list", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("/");
  await page.keyboard.press("Tab");
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

test("label completion isn't limited by the applied selector, only by the draft's other requirements", async ({ page }) => {
  // rel-pods honors selectors: app=web leaves 4 of its 6 pods loaded
  await openTape(page, "rel-pods", 6);
  await page.keyboard.press("/");
  await page.keyboard.press("Tab");
  const labels = page.getByLabel("label selector");
  const list = page.getByRole("listbox", { name: "label suggestions" });
  await page.keyboard.type("app=web");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await focused(page)).total).toBe(4);
  // the keys of every pod, also those app=web filtered out
  await labels.fill("");
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("option")).toHaveText(["app4/6", "widget1/6"]);
  // switching the selector: the other key's values, without emptying the field first
  await labels.fill("widget=");
  await expect(list.getByRole("option")).toHaveText(["gizmo1/6"]);
  // the draft's other requirements still narrow: no widget among app=web
  await labels.fill("app=web,");
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("option")).toHaveText(["app4/4"]);
});

test("cel filter: / ⇥ ⇥ focuses, a draft previews without touching the table, ⏎ applies and goes back to the table", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("/");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
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
  await expect(cel).not.toBeFocused();
  expect((await inspect(page)).focus).toBe("table");
  // a parse error is refused with the reason; the applied filter stays, and so does the focus
  await page.keyboard.press("/");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("End");
  await page.keyboard.type(" &&");
  await expect(cel).toHaveAttribute("aria-invalid", "true");
  await page.keyboard.press("Enter");
  expect((await focused(page)).spec.filter).toBe('o.metadata.labels.app == "etcd"');
  await expect(cel).toBeFocused();
  // the error only shows while the field has focus; unfocused, the red border and tooltip remain
  const grep = page.getByLabel("filter", { exact: true });
  await grep.click();
  await expect(preview).toHaveCount(0);
  await expect(cel).toHaveAttribute("aria-invalid", "true");
  await expect(cel).toHaveAttribute("title", /Syntax error/);
  await page.keyboard.press("Escape");
  await page.keyboard.press("/");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(preview).toContainText("Syntax error");
  // esc drops the draft: the applied filter is back in the field, and keys go to the table
  await page.keyboard.press("Escape");
  await expect(cel).toHaveValue('o.metadata.labels.app == "etcd"');
  await expect(cel).not.toHaveAttribute("aria-invalid", "true");
  await expect(cel).not.toBeFocused();
  expect((await inspect(page)).focus).toBe("table");
  expect((await focused(page)).spec.filter).toBe('o.metadata.labels.app == "etcd"');
  // empty + ⏎ clears
  await cel.fill("");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await focused(page)).total).toBe(3);
  // leaving the field applies a valid draft, like ⏎
  await cel.fill('o.metadata.labels.app == "api"');
  await grep.click();
  await expect.poll(async () => (await focused(page)).rows.map((r) => r.cells[1])).toEqual(["api-0", "api-1"]);
  await expect(cel).not.toHaveClass(/border-dashed/);
});

test("cel filter completes field paths from the live objects", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("/");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.type("o.metadata.la");
  const list = page.getByRole("listbox", { name: "cel suggestions" });
  await expect(list.getByRole("option").first()).toContainText("labels");
  await expect(list.getByRole("option").first()).toContainText("map · 3/3");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("cel", { exact: true })).toHaveValue("o.metadata.labels");
});

test("cel filter: ↓ opens the suggestions at the caret, ↑ in an empty field recalls recent filters", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("/");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
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
  await page.keyboard.press("/");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
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
  await page.keyboard.press("/");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
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
  const dialog = page.getByRole("region", { name: "object detail" });
  await expect(dialog).toContainText("app: etcd");
  await dialog.getByText("app: etcd").click();
  await page.keyboard.press("=");
  await expect.poll(async () => (await focused(page)).spec.filter).toBe('o.metadata.labels.app == "etcd"');
  await expect.poll(async () => (await focused(page)).rows.map((r) => r.cells[1])).toEqual(["etcd-0"]);
  // back in the table it filtered
  expect((await inspect(page)).objects).toEqual({});
  expect((await inspect(page)).focus).toBe("table");
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

test("a failing watch shows disconnected; ⌘⇧R or a click on it reconnects", async ({ page }) => {
  await openTape(page, "e2e-disconnect", 1);
  const status = page.getByRole("status", { name: "pane status" });
  const state = status.getByRole("button", { name: "reconnect" });
  await expect(state).toHaveText("● connected");
  // the watch fails: the rows stay, the state says so
  await expect(state).toHaveText("● disconnected", tapeSteps);
  await expect(status.getByRole("button", { name: "pane error" })).toContainText("network is unreachable");
  expect((await focused(page)).total).toBe(1);
  // a reconnect lists anew: connected again (until the tape's failure comes again)
  await page.keyboard.press("ControlOrMeta+Shift+R");
  await expect(state).toHaveText("● connected");
  await expect(status.getByLabel("message")).toHaveText("reconnected (current): 1 view reloading");
  await expect(status.getByRole("button", { name: "pane error" })).toHaveCount(0);
  await expect(state).toHaveText("● disconnected", tapeSteps);
  await state.click();
  await expect(state).toHaveText("● connected");
  // keys still go to the table
  expect((await inspect(page)).focus).toBe("table");
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
    await expect.poll(() => viewing(page)).toBe(true);
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
    await expect.poll(() => sel(page)).toMatchObject({ column: "AGE", clock: { type: "age" } });
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

test("j/k move selection, enter shows the object in place, d toggles diff, esc back to the table", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  expect((await focused(page)).selected).toBe(1);
  const serverId = (await focused(page)).serverId;
  await page.keyboard.press("Enter");
  let s = await inspect(page);
  expect(s.overlays).toEqual([]);
  expect(s.focus).toBe("detail");
  // in the pane, not over the tab: the same pane, its table hidden under it
  expect(Object.keys(s.objects)).toEqual([s.focusedPane]);
  expect(s.objects[s.focusedPane]).toMatchObject({ split: false, view: "yaml" });
  const pane = page.locator(`section[data-pane="${s.focusedPane}"]`);
  await expect(pane.getByRole("region", { name: "object detail" })).toContainText("kind: Pod");
  // the table's grid and filter bar are hidden under it (not gone: back, it's as it was)
  const grid = pane.locator("canvas:not(.decorationsOverviewRuler)").first();
  await expect(grid).toBeHidden();
  await expect(pane.getByRole("textbox", { name: "filter" })).toBeHidden();
  await page.keyboard.press("d");
  await expect(page.getByRole("region", { name: "object detail" })).toContainText("diff");
  await page.keyboard.press("Escape");
  s = await inspect(page);
  expect(s.objects).toEqual({});
  expect(s.focus).toBe("table");
  expect((await focused(page)).selected).toBe(1);
  // the same table, not a new watch
  expect((await focused(page)).serverId).toBe(serverId);
  await expect(grid).toBeVisible();
});

test("back from an object opened over the table, the table is scrolled as it was", async ({ page }) => {
  // short enough that the tape's rows don't fit: the last row is scrolled to
  await page.setViewportSize({ width: 1400, height: 260 });
  await openTape(page, "e2e-static", 8);
  await page.keyboard.press("Shift+G");
  const pane = page.locator(`section[data-pane="${(await inspect(page)).focusedPane}"]`);
  const scroller = pane.locator(".dvn-scroller");
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const top = await scroller.evaluate((el) => el.scrollTop);
  await page.keyboard.press("Enter");
  await expect(pane.getByRole("region", { name: "object detail" })).toContainText("kind:");
  await page.keyboard.press("Escape");
  await expect.poll(async () => Object.keys((await inspect(page)).objects)).toEqual([]);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(top);
});

test("⏎ in place is a history step: Esc back to the table, ⌘→ forward to the object again", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("j");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "object detail" })).toContainText("kind: Pod");
  await expect(page.getByRole("button", { name: "back" })).toBeEnabled();
  // (⌘← is the start of the line in the YAML view, as in VS Code)
  await page.keyboard.press("Escape");
  await expect.poll(async () => Object.keys((await inspect(page)).objects)).toEqual([]);
  expect((await focused(page)).selected).toBe(1);
  await page.keyboard.press("ControlOrMeta+ArrowRight");
  await expect.poll(() => viewing(page)).toBe(true);
  await expect(page.getByRole("region", { name: "object detail" })).toContainText("kind: Pod");
});

test("⇧⏎ opens the object in a split to the right; esc closes it, focus back on its table", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("j");
  const table = (await inspect(page)).focusedPane;
  const serverId = (await focused(page)).serverId;
  await page.keyboard.press("Shift+Enter");
  let s = await inspect(page);
  const split = s.focusedPane;
  expect(split).not.toBe(table);
  expect(s.focus).toBe("detail");
  expect(s.objects[split]).toMatchObject({ split: true, from: table, follow: false, view: "yaml" });
  // side by side, on the table's watch (no second one)
  expect(s.tabs[s.activeTab]!.layout).toMatchObject({ type: "split", dir: "row" });
  expect(s.panes[split]!.serverId).toBe(serverId);
  const right = page.locator(`section[data-pane="${split}"]`);
  await expect(right.getByRole("region", { name: "object detail" })).toContainText("kind: Pod");
  // the table is still there, next to it
  await expect(page.locator(`section[data-pane="${table}"] canvas`).first()).toBeVisible();
  // a second one, to compare: back in the table (⌘⌥←), the next row, ⇧⏎ again
  await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
  await expect.poll(async () => (await inspect(page)).focus).toBe("table");
  expect((await inspect(page)).focusedPane).toBe(table);
  await page.keyboard.press("j");
  await page.keyboard.press("Shift+Enter");
  await expect.poll(async () => Object.keys((await inspect(page)).objects).length).toBe(2);
  s = await inspect(page);
  expect(Object.keys(s.objects).sort()).toEqual([split, s.focusedPane].sort());
  // esc closes the newest split; the focus goes back to the table
  await page.keyboard.press("Escape");
  s = await inspect(page);
  expect(s.focusedPane).toBe(table);
  expect(s.focus).toBe("table");
  expect(Object.keys(s.objects)).toEqual([split]);
  expect(s.panes[table]!.serverId).toBe(serverId);
});

test("closing a split next to an object view gives the keys back to its viewer", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("Shift+Enter");
  const view = (await inspect(page)).focusedPane;
  await expect(page.locator(`section[data-pane="${view}"]`).getByRole("region", { name: "object detail" })).toContainText("kind: Pod");
  const inViewer = () => page.evaluate((id) => !!document.activeElement?.closest(`section[data-pane="${id}"] .monaco-editor`), view);
  await expect.poll(inViewer).toBe(true);
  // a split of the viewer pane (⌘D), closed again: the viewer has the keys, not just the border
  await page.keyboard.press("ControlOrMeta+D");
  await expect.poll(async () => (await inspect(page)).focusedPane).not.toBe(view);
  await page.keyboard.press("Control+D");
  await expect.poll(async () => (await inspect(page)).focusedPane).toBe(view);
  await expect.poll(inViewer).toBe(true);
  expect((await inspect(page)).focus).toBe("detail");
});

test("follow: off by default; on, the split shows the table's selected row; off, it stays", async ({ page }) => {
  await openTape(page);
  await afterTapeSteps(page);
  const table = (await inspect(page)).focusedPane;
  const rows = (await focused(page)).rows;
  await page.keyboard.press("Shift+Enter");
  const split = (await inspect(page)).focusedPane;
  const right = page.locator(`section[data-pane="${split}"]`);
  const view = right.getByRole("region", { name: "object detail" }).locator(".view-lines");
  await expect(view).toContainText(`name: ${rows[0]!.cells[1]}`);
  const follow = right.getByRole("checkbox", { name: "follow selection" });
  await expect(follow).not.toBeChecked();
  // the table's selection moves: a pinned split stays
  await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
  await page.keyboard.press("j");
  await expect.poll(async () => (await inspect(page)).panes[table]!.selected).toBe(1);
  await expect(view).toContainText(`name: ${rows[0]!.cells[1]}`);
  // on: it shows the selected row, and follows it
  await follow.check();
  await expect(follow).toBeChecked();
  await expect(view).toContainText(`name: ${rows[1]!.cells[1]}`);
  await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
  await page.keyboard.press("j");
  await expect(view).toContainText(`name: ${rows[2]!.cells[1]}`);
  expect((await inspect(page)).objects[split]).toMatchObject({ follow: true, key: rows[2]!.key });
  // off again: it stays on the object it shows
  await follow.uncheck();
  await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
  await page.keyboard.press("k");
  await expect.poll(async () => (await inspect(page)).panes[table]!.selected).toBe(1);
  await expect(view).toContainText(`name: ${rows[2]!.cells[1]}`);
  // its table closed: it stays (its own hold on the watch), following can't be turned on
  await page.keyboard.press("Control+D");
  await expect.poll(async () => (await inspect(page)).focusedPane).toBe(split);
  await expect(view).toContainText(`name: ${rows[2]!.cells[1]}`);
  await expect(follow).toBeDisabled();
  await expect(follow).not.toBeChecked();
});

test("a held esc climbs out of a decoded value but stops at the top; a fresh press closes the split", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("Shift+Enter");
  const split = (await inspect(page)).focusedPane;
  // a held key: keydown with repeat set
  const held = () => page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", repeat: true, bubbles: true })));
  await held();
  await held();
  expect((await inspect(page)).objects[split]).toBeDefined();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await inspect(page)).objects[split]).toBeUndefined();
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
  // longer than the window: it scrolls down, never sideways (two columns, not more to the right)
  const scroller = sheet.locator("[tabindex='-1']");
  const size = await scroller.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight }));
  expect(size.sw).toBeLessThanOrEqual(size.cw);
  expect(size.sh).toBeGreaterThan(size.ch);
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

test("cmd+f searches the cheat sheet; enter steps matches, esc closes find then the sheet", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "keyboard shortcuts" });
  await expect(sheet).toContainText("split down");
  // ⌘F opens the find box and focuses it
  await page.keyboard.press("ControlOrMeta+F");
  expect((await inspect(page)).focus).toBe("helpfind");
  const find = sheet.getByRole("textbox", { name: "find" });
  await expect(find).toBeFocused();
  // typing narrows to the matches (the match count shows how many)
  await page.keyboard.type("port-forward");
  await expect(sheet.getByLabel("matches")).toContainText("of");
  // the active match row is highlighted and scrolled into view
  await expect(sheet.getByText("port-forward…", { exact: true })).toBeVisible();
  // ⏎ steps to the next match, the count's position advances
  const first = await sheet.getByLabel("matches").textContent();
  await page.keyboard.press("Enter");
  expect(await sheet.getByLabel("matches").textContent()).not.toBe(first);
  // a section heading matches too: "time-travel" has no entry by that word, yet its rows are found
  await find.fill("time-travel");
  await expect(sheet.getByLabel("matches")).toContainText("of");
  await expect(sheet.getByRole("heading", { name: "time-travel" })).toBeVisible();
  // Esc closes the find but leaves the sheet open
  await page.keyboard.press("Escape");
  let s = await inspect(page);
  expect(s.focus).toBe("help");
  expect(s.overlays).toEqual(["help"]);
  await expect(find).toHaveCount(0);
  // Esc again closes the sheet
  await page.keyboard.press("Escape");
  s = await inspect(page);
  expect(s.overlays).toEqual([]);
  expect(s.focus).toBe("table");
});

test("the ? button at the right end of the tab bar toggles the cheat sheet", async ({ page }) => {
  await openTape(page);
  const button = page.getByRole("button", { name: "keyboard shortcuts" });
  await expect(button).toHaveAttribute("title", "keyboard shortcuts (?)");
  await button.click();
  const sheet = page.getByRole("dialog", { name: "keyboard shortcuts" });
  await expect(sheet).toContainText("split down");
  expect((await inspect(page)).focus).toBe("help");
  await button.click();
  await expect(sheet).toHaveCount(0);
  expect((await inspect(page)).overlays).toEqual([]);
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

test("naming: double-click or cmd+shift+i names a tab, cmd+i or a double-click on the header a pane; esc undoes, empty clears", async ({ page }) => {
  await openTape(page);
  const tab = page.getByRole("tab", { selected: true });
  await tab.dblclick();
  const tabField = page.getByRole("textbox", { name: "tab name" });
  await expect(tabField).toBeFocused();
  await page.keyboard.type("incident");
  await page.keyboard.press("Enter");
  await expect(tab).toHaveAccessibleName("incident");
  expect((await inspect(page)).focus).toBe("table");
  // esc puts the old name back
  await page.keyboard.press("ControlOrMeta+Shift+I");
  await page.keyboard.type("other");
  await expect(tabField).toHaveValue("other");
  await page.keyboard.press("Escape");
  await expect(tab).toHaveAccessibleName("incident");

  // the pane: its name shows in the header; the tab has its own name, so it stays
  await page.keyboard.press("ControlOrMeta+I");
  await page.keyboard.type("web pods");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-pane=v1] header").getByLabel("pane name")).toHaveText("web pods");
  await expect(tab).toHaveAccessibleName("incident");
  // an empty tab name clears it: the tab shows the focused pane's name
  await tab.dblclick();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  await expect(tab).toHaveAccessibleName("web pods");

  // a double-click on the header's empty stretch renames the pane; typing goes to the field, not the table's keys
  const header = (await page.locator("[data-pane=v1] header").boundingBox())!;
  const filter = (await page.locator("[data-pane=v1]").getByRole("textbox", { name: "filter" }).boundingBox())!;
  await page.mouse.dblclick(filter.x - 20, header.y + header.height / 2);
  await expect(page.getByRole("textbox", { name: "pane name" })).toBeFocused();
  await page.keyboard.type("dj");
  await page.keyboard.press("Enter");
  expect((await inspect(page)).panes.v1!.selected).toBe(0);
  await expect(page.locator("[data-pane=v1] header").getByLabel("pane name")).toHaveText("dj");
  // a split doesn't take the name along
  await page.keyboard.press("ControlOrMeta+D");
  await expect(page.locator("[data-pane=v2]")).toBeVisible();
  await expect(page.locator("[data-pane=v2] header").getByLabel("pane name")).toHaveCount(0);
});

test("dragging a tab reorders the tabs (the active one stays active); esc puts them back; a click still just selects", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("ControlOrMeta+T");
  await page.keyboard.press("ControlOrMeta+T");
  const order = async () => (await inspect(page)).tabs.map((t) => t.id);
  const [a, b, c] = await order();
  const at = async (id: string) => {
    const r = (await page.locator(`[role=tablist] [data-tab=${id}]`).boundingBox())!;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const drag = async (id: string, to: { x: number; y: number }, finish: () => Promise<void>) => {
    const from = await at(id);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 10, from.y, { steps: 2 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await finish();
  };
  // the first tab onto the last one's right half: it goes last
  const last = await at(c!);
  await drag(a!, { x: last.x + 20, y: last.y }, () => page.mouse.up());
  expect(await order()).toEqual([b, c, a]);
  expect((await inspect(page)).tabs[(await inspect(page)).activeTab]!.id).toBe(a); // released on it: it's the one shown
  // the shortcuts follow the order
  await expect(page.locator(`[role=tablist] [data-tab=${a}]`)).toHaveAttribute("aria-keyshortcuts", "Meta+3");

  // esc while dragging: back as it was
  await drag(c!, await at(b!), () => page.keyboard.press("Escape"));
  expect(await order()).toEqual([b, c, a]);
  await page.mouse.up();
  expect(await order()).toEqual([b, c, a]);

  // a press without moving is a click: the tab is shown, nothing moves
  await page.locator(`[role=tablist] [data-tab=${b}]`).click();
  expect(await order()).toEqual([b, c, a]);
  expect((await inspect(page)).activeTab).toBe(0);
});

test("a tab's ✕ shows on hover at its left: clicking on the same spot closes tab after tab; splits ask first", async ({ page }) => {
  await openTape(page);
  await page.keyboard.press("ControlOrMeta+Shift+D"); // t1 holds two panes
  for (let i = 0; i < 3; i++) await page.keyboard.press("ControlOrMeta+T");
  const order = async () => (await inspect(page)).tabs.map((t) => t.id);
  const [t1, t2, t3, t4] = await order();
  const close = (id: string) => page.locator(`[role=tablist] :has(> [data-tab=${id}]) > button[aria-label^="close tab"]`);
  await expect(close(t2!)).toBeHidden();
  await page.locator(`[role=tablist] [data-tab=${t2}]`).hover();
  await expect(close(t2!)).toBeVisible();
  const r = (await close(t2!).boundingBox())!;
  const tab = (await page.locator(`[role=tablist] [data-tab=${t2}]`).boundingBox())!;
  expect(r.x - tab.x).toBeLessThan(tab.width / 3); // on the left
  // the pointer stays put: the next tab moves under it
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  expect(await order()).toEqual([t1, t3, t4]);
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  expect(await order()).toEqual([t1, t4]);
  // the tab with splits asks, as ⌘W does
  await page.locator(`[role=tablist] [data-tab=${t1}]`).hover();
  await close(t1!).click();
  await expect(page.getByRole("alertdialog", { name: "confirm close tab" })).toBeVisible();
  await page.keyboard.press("Enter");
  expect(await order()).toEqual([t4]);
});

test("more tabs than fit wrap into rows (same height each, full titles); the panes make room", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 600 });
  await openTape(page);
  const bar = page.getByRole("tablist");
  const one = (await bar.boundingBox())!.height;
  const tabs = page.getByRole("tab");
  const tabHeight = (await tabs.first().boundingBox())!.height;
  for (let i = 0; i < 7; i++) await page.keyboard.press("ControlOrMeta+T");
  await expect(tabs).toHaveCount(8);
  const rows = new Set(await Promise.all((await tabs.all()).map(async (t) => Math.round((await t.boundingBox())!.y))));
  expect(rows.size).toBeGreaterThan(1);
  for (const t of await tabs.all()) expect((await t.boundingBox())!.height).toBe(tabHeight); // not squeezed
  const barBox = (await bar.boundingBox())!;
  expect(barBox.height).toBeGreaterThan(one);
  // the pane area starts below the last row, nothing overlaps
  const area = (await page.locator(`[data-tab-area]:visible`).boundingBox())!;
  expect(area.y).toBeGreaterThanOrEqual(barBox.y + barBox.height);
  // dragging the last tab onto the first row's start puts it first
  const order = async () => (await inspect(page)).tabs.map((t) => t.id);
  const ids = await order();
  const last = (await tabs.last().boundingBox())!;
  const first = (await tabs.first().boundingBox())!;
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width / 2 + 10, last.y + last.height / 2, { steps: 2 });
  await page.mouse.move(first.x + 5, first.y + first.height / 2, { steps: 10 });
  await page.mouse.up();
  expect(await order()).toEqual([ids.at(-1), ...ids.slice(0, -1)]);
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

test("cmd+ctrl+arrows move the focused pane's divider, also in what dockview shows", async ({ page }) => {
  await openTape(page);
  // v1 | (v2 / v3), focus v3
  await page.keyboard.press("ControlOrMeta+Shift+D");
  await page.keyboard.press("ControlOrMeta+D");
  const box = async (id: string) => (await page.locator(`[data-pane=${id}]`).boundingBox())!;
  const w1 = (await box("v1")).width;
  const h3 = (await box("v3")).height;
  await page.keyboard.press("Control+Meta+ArrowLeft"); // v3's left divider: v1 shrinks
  await expect.poll(async () => (await box("v1")).width).toBeLessThan(w1 - 20);
  await page.keyboard.press("Control+Meta+ArrowUp"); // v3's divider above it: v3 grows
  await expect.poll(async () => (await box("v3")).height).toBeGreaterThan(h3 + 20);
  await page.keyboard.press("Control+Meta+ArrowDown"); // and back
  await expect.poll(async () => Math.abs((await box("v3")).height - h3)).toBeLessThan(3);
  expect((await inspect(page)).focusedPane).toBe("v3"); // the focus stays
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

  // the file is the shared fixture: edits are dropped, and only its own text is saved back
  test("⌘, edits config.yaml: the reference beside it, problems while typing, ⌘S saves and applies", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+,");
    const dialog = page.getByRole("dialog", { name: "settings" });
    await expect(dialog).toContainText("testdata/config/config.yaml");
    await expect.poll(async () => (await inspect(page)).overlays).toEqual(["config"]);
    const editor = dialog.locator("[data-editor=yaml]");
    await expect(editor.locator(".view-lines")).toContainText("theme: e2e");
    // an existing file has the reference beside it, every setting with its default
    const reference = dialog.getByRole("textbox", { name: "reference" });
    await expect(reference).toHaveCount(1);
    await expect(dialog).toContainText("every setting with its default");
    // the toggle leaves the focus in the editor (WKWebView doesn't focus a clicked button: Esc would reach nothing)
    await dialog.getByRole("textbox", { name: "config.yaml" }).focus();
    await dialog.getByRole("button", { name: "reference" }).click();
    await expect(reference).toHaveCount(0);
    await dialog.getByRole("button", { name: "reference" }).click();
    await expect(reference).toHaveCount(1);
    expect(await page.evaluate(() => !!document.activeElement?.closest("[data-editor]"))).toBe(true);
    // the reference hidden while it has the focus: the dialog takes it, Esc still closes
    await reference.focus();
    await dialog.getByRole("button", { name: "reference" }).click();
    await expect(reference).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+,");
    await expect(editor.locator(".view-lines")).toContainText("theme: e2e");
    await expect(reference).toHaveCount(1);

    // a typo shows while typing, as Go would load it
    const textarea = dialog.getByRole("textbox", { name: "config.yaml" });
    await textarea.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.insertText("\nbogus: 1");
    await expect(dialog).toContainText("edited");
    await expect(dialog.getByRole("alert", { name: "config problems" })).toContainText('unknown field "bogus"');
    // Esc on edits asks first, a second one drops them
    await page.keyboard.press("Escape");
    await expect(dialog).toContainText("esc again drops the edits");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");

    // reopened, the file is as it was; ⌘S writes it back unchanged and applies it
    await page.keyboard.press("ControlOrMeta+,");
    await expect(editor.locator(".view-lines")).toContainText("theme: e2e");
    await expect(dialog.getByRole("alert", { name: "config problems" })).toHaveCount(0);
    await textarea.focus();
    await page.keyboard.press("ControlOrMeta+S");
    await expect(dialog).toContainText("saved and applied");
    await expect(page.getByRole("alert", { name: "config errors" })).toHaveCount(0);
    // saved: Esc closes at once
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  // Go asks the system (CoreText) whether the font is installed on load and save, not while typing (config_test.go);
  // the save here is stubbed to what Go's would return, so the shared fixture isn't written. The main banner waits behind the dialog.
  test("⌘, reports a font that isn't installed on save, not while typing; the main banner is hidden while the editor is open", async ({ page }) => {
    await ready(page);
    type Kw = { __kw: { bridge(): { saveConfig(f: string, t: string): Promise<unknown>; config(): Promise<{ errors: string[] }> }; config: { setState(s: object): void } } };
    // a problem of the saved config: the banner shows it, until the editor opens
    await page.evaluate(() => (window as unknown as Kw).__kw.config.setState({ errors: ["config.yaml: saved problem"], dismissed: false }));
    const banner = page.getByRole("alert", { name: "config errors" });
    await expect(banner).toContainText("saved problem");
    await page.keyboard.press("ControlOrMeta+,");
    const dialog = page.getByRole("dialog", { name: "settings" });
    await expect(dialog.locator("[data-editor=yaml] .view-lines")).toContainText("theme: e2e");
    await expect(banner).toHaveCount(0);
    // a save that writes nothing and comes back as Go's reload would: the font's problem among the file's
    await page.evaluate(() => {
      const b = (window as unknown as Kw).__kw.bridge();
      b.saveConfig = (_f, text) =>
        b.config().then((c) => ({ ...c, errors: text.includes("No Such Font") ? ['config.yaml: font.family: "No Such Font Anywhere" is not installed, using the default font'] : [] }));
    });
    const textarea = dialog.getByRole("textbox", { name: "config.yaml" });
    await textarea.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.insertText("\nfont: {family: No Such Font Anywhere}");
    const problems = dialog.getByRole("alert", { name: "config problems" });
    // while typing: nothing (the live check doesn't look fonts up)
    await expect(dialog).toContainText("edited");
    await page.waitForTimeout(600);
    await expect(problems).toHaveCount(0);
    // saved: the editor lists it (the banner stays hidden behind it)
    await page.keyboard.press("ControlOrMeta+S");
    await expect(dialog).toContainText("saved and applied, defaults used where there are problems");
    await expect(problems).toHaveText('font.family: "No Such Font Anywhere" is not installed, using the default font');
    await expect(banner).toHaveCount(0);
    // typing again clears it until the next save
    await page.keyboard.press("End");
    await page.keyboard.insertText(" ");
    await expect(dialog).toContainText("edited");
    await expect(problems).toHaveCount(0);
    // closed (the edit dropped): the banner is back
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(banner).toContainText("saved problem");
    await page.getByRole("button", { name: "dismiss" }).click();
  });

  // the file is the shared fixture: edits are dropped, and only its own text is saved back
  test("⌥⌘, edits keybindings.yaml: every default beside it, unknown commands while typing, ⌘S saves and applies", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+Alt+,");
    const dialog = page.getByRole("dialog", { name: "keyboard shortcuts" });
    await expect(dialog).toContainText("testdata/config/keybindings.yaml");
    await expect.poll(async () => (await inspect(page)).overlays).toEqual(["config"]);
    const editor = dialog.locator("[data-editor=yaml]");
    await expect(editor.locator(".view-lines")).toContainText("row.down");
    // the reference: every default binding as an entry
    await expect(dialog.getByRole("textbox", { name: "reference" })).toHaveCount(1);
    await expect(dialog).toContainText("every default binding");

    // an unknown command shows while typing, numbered as in the file
    const textarea = dialog.getByRole("textbox", { name: "keybindings.yaml" });
    await textarea.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.insertText('\n- {key: "cmd+k", command: row.dwn}');
    await expect(dialog.getByRole("alert", { name: "config problems" })).toContainText('[1] (cmd+k): unknown command "row.dwn"');
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");

    // reopened as it was; ⌘S writes it back unchanged and applies it
    await page.keyboard.press("ControlOrMeta+Alt+,");
    await expect(dialog.getByRole("alert", { name: "config problems" })).toHaveCount(0);
    await textarea.focus();
    await page.keyboard.press("ControlOrMeta+S");
    await expect(dialog).toContainText("saved and applied");
    await expect(page.getByRole("alert", { name: "config errors" })).toHaveCount(0);
    // outside the editor (whose keys are Monaco's): ⌘, doesn't switch files (edits would go unasked), ⌥⌘, again closes it
    await dialog.focus();
    await page.keyboard.press("ControlOrMeta+,");
    await expect(page.getByRole("dialog", { name: "settings" })).toHaveCount(0);
    await expect(dialog).toHaveCount(1);
    await page.keyboard.press("ControlOrMeta+Alt+,");
    await expect(dialog).toHaveCount(0);
  });
});

// config.yaml's font, applied as a reload would (the shared config.yaml keeps the default font)
test.describe("font (config.yaml font)", () => {
  type Font = { family?: string; size?: number; ligatures?: boolean };
  const setFont = (page: Page, font: Font | undefined) =>
    page.evaluate((font) => {
      const kw = (window as unknown as { __kw: { config: { getState(): { config?: { config: object } } }; applyConfig(c: object): void } }).__kw;
      const c = kw.config.getState().config!;
      kw.applyConfig({ ...c, config: { ...c.config, font } });
    }, font);
  const applied = async (page: Page) => (await inspect(page) as unknown as { config: unknown }).config as { font: { family: string; size: number; ligatures: boolean }; errors: string[] };
  test.afterEach(async ({ page }) => setFont(page, undefined));

  test("the default: theme.css's stack (SF Mono, Menlo), 12px, no ligatures", async ({ page }) => {
    await ready(page);
    const f = (await applied(page)).font;
    expect(f.family).toContain("Menlo");
    expect(f.family).not.toContain("JetBrains");
    expect(f.size).toBe(12);
    expect(f.ligatures).toBe(false);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontVariantLigatures)).toBe("none");
    expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe("12px");
  });

  test("family, size and ligatures apply live to the DOM, the table, Monaco and terminals; the defaults stay behind the family", async ({ page }) => {
    await openTape(page);
    await setFont(page, { family: "Courier New", size: 16, ligatures: true });
    await expect.poll(async () => (await applied(page)).font.size).toBe(16);
    const f = (await applied(page)).font;
    expect(f.family).toMatch(/^"Courier New", .*Menlo/);
    expect(f.ligatures).toBe(true);
    // DOM: base size, smaller UI text follows it, ligatures from the setting
    const css = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.className = "text-small";
      document.body.append(probe);
      const small = getComputedStyle(probe).fontSize;
      probe.remove();
      const b = getComputedStyle(document.body);
      return { size: b.fontSize, family: b.fontFamily, ligatures: b.fontVariantLigatures, small };
    });
    expect(css).toEqual({ size: "16px", family: expect.stringContaining("Courier New"), ligatures: "normal", small: "15px" });
    // table: rows 16 + 10 px below a 16 + 12 px header (the row under a click is the one at that height)
    const rows = (await focused(page)).rows;
    const grid = page.locator("section[data-pane] canvas").first();
    const box = (await grid.boundingBox())!;
    await page.mouse.click(box.x + 60, box.y + 28 + 2 * 26 + 13);
    await expect.poll(async () => (await focused(page)).selected).toBe(2);
    await page.mouse.click(box.x + 60, box.y + 28 + 26 + 13);
    await expect.poll(async () => (await focused(page)).selected).toBe(1);
    expect(rows.length).toBeGreaterThan(2);
    // Monaco: an editor opened now, and one already open when the font changes again
    await page.keyboard.press("Enter");
    const viewer = page.locator('[data-viewer="single"] .monaco-editor');
    await expect(viewer).toBeVisible();
    const lines = viewer.locator(".view-lines");
    await expect.poll(() => lines.evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
    expect(await lines.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"Courier New", "SF Mono"/);
    await setFont(page, { size: 10 });
    await expect.poll(() => lines.evaluate((el) => getComputedStyle(el).fontSize)).toBe("10px");
    // Monaco appends its own fallbacks (Menlo, Monaco, "Courier New"): the configured stack leads
    expect(await lines.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"SF Mono", ui-monospace, Menlo, monospace/);
    expect(await lines.evaluate((el) => getComputedStyle(el).fontFeatureSettings)).toContain('"liga" 0');
  });

  test("a terminal takes the font, also when it changes while it's open", async ({ page }) => {
    await openTape(page);
    await page.keyboard.press("Control+T");
    await expect.poll(async () => (await inspect(page)).focus).toBe("terminal");
    await expect(page.locator("[data-terminal] .xterm-rows")).toContainText("local:tape$");
    const term = async () => {
      const s = await inspect(page);
      const id = (s.panes[s.focusedPane] as unknown as { term: { session: string } }).term.session;
      return (s as unknown as { terminals: Record<string, { fontSize: number; fontFamily: string }> }).terminals[id]!;
    };
    await expect.poll(async () => (await term()).fontSize).toBe(12);
    const rowHeight = () => page.locator("[data-terminal] .xterm-rows > div").first().evaluate((el) => el.getBoundingClientRect().height);
    const before = await rowHeight();
    await setFont(page, { family: "Courier New", size: 18 });
    await expect.poll(async () => (await term()).fontSize).toBe(18);
    expect((await term()).fontFamily).toContain("Courier New");
    // the cells grew: a row of the screen is taller
    await expect.poll(rowHeight).toBeGreaterThan(before);
    await page.keyboard.press("Control+D");
  });

  test("⌘+ / ⌘- zoom every pane from font.size, within 8 … 24 px, a reload keeps the zoom, ⌘0 drops it", async ({ page }) => {
    await openTape(page);
    const size = async () => (await applied(page)).font.size;
    const body = () => page.evaluate(() => getComputedStyle(document.body).fontSize);
    await page.keyboard.press("Meta+Equal");
    await expect.poll(size).toBe(13);
    // ⌘+ as typed (⌘⇧=) zooms too
    await page.keyboard.press("Meta+Shift+Equal");
    await expect.poll(size).toBe(14);
    expect(await body()).toBe("14px");
    // the YAML editor takes the zoomed size, and follows a step while open
    await page.keyboard.press("Enter");
    const lines = page.locator('[data-viewer="single"] .monaco-editor .view-lines');
    await expect.poll(() => lines.evaluate((el) => getComputedStyle(el).fontSize)).toBe("14px");
    await page.keyboard.press("Meta+Minus");
    await expect.poll(() => lines.evaluate((el) => getComputedStyle(el).fontSize)).toBe("13px");
    // a reload with another font.size keeps the zoom on top of it
    await setFont(page, { size: 16 });
    await expect.poll(size).toBe(17);
    for (let i = 0; i < 10; i++) await page.keyboard.press("Meta+Equal");
    await expect.poll(size).toBe(24);
    // at the bound one step back is one px back
    await page.keyboard.press("Meta+Minus");
    await expect.poll(size).toBe(23);
    await page.keyboard.press("Meta+Digit0");
    await expect.poll(size).toBe(16);
    expect(await body()).toBe("16px");
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
    // an error message is clickable: all of it, above the status line
    const msg = pane(page).getByRole("button", { name: "message" });
    await msg.click();
    const pop = page.getByRole("dialog", { name: "error detail" });
    await expect(pop.getByLabel("error text")).toContainText("read-only context");
    const [p, e] = [await pop.boundingBox(), await msg.boundingBox()];
    expect(p!.y + p!.height).toBeLessThanOrEqual(e!.y);
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);
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

  test("focusFollowsMouse: moving the mouse over a pane focuses it, not while a field or dialog has the focus", async ({ page }) => {
    await openTape(page);
    const setFollow = (on: boolean) =>
      page.evaluate((on) => {
        const c = (window as unknown as { __kw: { config: { setState(f: (s: { config?: { config: object } }) => object): void } } }).__kw.config;
        c.setState((s) => ({ config: { ...s.config!, config: { ...s.config!.config, focusFollowsMouse: on } } }));
      }, on);
    await page.keyboard.press("ControlOrMeta+Shift+D"); // v1 | v2, focus v2
    const panes = page.locator("main > div:not([hidden]) section[data-pane]");
    const center = async (i: number) => {
      const b = (await panes.nth(i).boundingBox())!;
      return [b.x + b.width / 2, b.y + b.height / 2] as const;
    };
    // off (the default): hovering does nothing
    await page.mouse.move(...(await center(0)), { steps: 4 });
    expect((await inspect(page)).focusedPane).toBe("v2");
    await setFollow(true);
    await page.mouse.move(...(await center(1)), { steps: 4 });
    await expect.poll(async () => (await inspect(page)).focusedPane).toBe("v2");
    await page.mouse.move(...(await center(0)), { steps: 4 });
    await expect.poll(async () => (await inspect(page)).focusedPane).toBe("v1");
    expect((await inspect(page)).focus).toBe("table");
    // the grep field keeps the focus while typing, the pointer elsewhere
    await page.keyboard.press("/");
    await expect.poll(async () => (await inspect(page)).focus).toBe("filter");
    await page.mouse.move(...(await center(1)), { steps: 4 });
    expect((await inspect(page)).focusedPane).toBe("v1");
    expect((await inspect(page)).focus).toBe("filter");
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
    // back in the table, the pointer resting over v2 changes nothing until it moves
    expect((await inspect(page)).focusedPane).toBe("v1");
    const [x, y] = await center(1);
    await page.mouse.move(x + 20, y, { steps: 4 });
    await expect.poll(async () => (await inspect(page)).focusedPane).toBe("v2");
    // a resting pointer under a new split doesn't take the focus from it
    await page.keyboard.press("ControlOrMeta+D"); // v2 over v3, focus v3
    await expect.poll(async () => (await inspect(page)).focusedPane).toBe("v3");
    await page.waitForTimeout(200);
    expect((await inspect(page)).focusedPane).toBe("v3");
    await setFollow(false);
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

    test("the grip shows while the mouse moves", async ({ page }) => {
      await openTape(page);
      await expect(grip(page, "v1")).toHaveCount(0); // the only pane there is: nowhere to go
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
    const dialog = page.getByRole("region", { name: "object detail" });
    await expect(dialog.locator(".view-lines")).toContainText("name: api-1");
    await page.keyboard.press("d");
    await expect(dialog.locator('[data-viewer="diff"] .monaco-diff-editor')).toBeVisible();
    // the restart added containerStatuses: an inserted line on the modified side
    await expect(dialog.locator('[data-viewer="diff"]').locator(".line-insert, .char-insert, .gutter-insert").first()).toBeAttached();
    await page.keyboard.press("d");
    await expect(dialog.locator('[data-viewer="single"]')).toBeVisible();
  });

  test("the YAML viewer's keys as in VS Code: ⌥←/⌥→ a word (⇧ selects), ⌘←/⌘→ start/end of line, ⌃←/⌃→ fold/unfold", async ({ page }) => {
    await openApi1(page);
    const view = page.getByRole("region", { name: "object detail" });
    const line = view.locator(".view-line", { hasText: "name: api-1" }).first();
    await line.click();
    const at = async () => (await inspect(page)).place!;
    const row = (await at()).line;
    const text = (await line.textContent())!.replace(/\u00a0/g, " ");
    const indent = text.length - text.trimStart().length;
    expect(indent).toBeGreaterThan(0);
    // as VS Code: the line's first non-blank, then its start
    await page.keyboard.press("Meta+ArrowLeft");
    expect(await at()).toMatchObject({ line: row, col: indent });
    await page.keyboard.press("Meta+ArrowLeft");
    expect(await at()).toMatchObject({ line: row, col: 0 });
    // still the YAML view: ⌘← isn't the history's back here
    await expect(view).toBeVisible();
    await page.keyboard.press("Meta+ArrowRight");
    expect(await at()).toMatchObject({ line: row, col: text.length });
    await page.keyboard.press("Meta+ArrowLeft");
    expect((await at()).col).toBe(indent);
    await page.keyboard.press("Alt+ArrowRight");
    expect((await at()).col).toBe(text.indexOf("name") + "name".length);
    // ":" is a word of its own, as in VS Code
    await page.keyboard.press("Alt+Shift+ArrowRight");
    await page.keyboard.press("Alt+Shift+ArrowRight");
    await expect.poll(async () => (await inspect(page)).selected).toBe(": api");
    // back a word, from the selection's end: the start of "api"
    await page.keyboard.press("Alt+ArrowLeft");
    expect((await at()).col).toBe(text.indexOf("api"));
    expect((await inspect(page)).selected).toBe("");

    // ⌃← folds the section at the cursor (its lines hidden), ⌃→ unfolds it
    await view.locator(".view-line", { hasText: /^metadata:/ }).click();
    await expect(view.locator(".view-lines")).toContainText("name: api-1");
    await page.keyboard.press("Control+ArrowLeft");
    await expect(view.locator(".view-lines")).not.toContainText("name: api-1");
    await page.keyboard.press("Control+ArrowRight");
    await expect(view.locator(".view-lines")).toContainText("name: api-1");
  });

  test("diff: ↑/↓ buttons and j/k step through the changes; the cursor starts on the first", async ({ page }) => {
    await openApi1(page);
    const dialog = page.getByRole("region", { name: "object detail" });
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
    expect(await viewing(page)).toBe(true); // still the yaml (d: diff), wrap untouched (w)
    await expect(page.locator('[data-viewer="single"]')).toHaveAttribute("data-wrap", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator(".find-widget.visible")).toHaveCount(0);
    expect(await viewing(page)).toBe(true);
    await page.keyboard.press("Escape");
    expect((await inspect(page)).objects).toEqual({});
    expect((await inspect(page)).focus).toBe("table");
  });
});

// e2e-versions: deployment web scaled 1 → 2 (1s) → 3 (1.5s), then a new image (2s): four versions.
test("diff without recorded history: previous → current, no versions; record changes is off", async ({ page }) => {
  await openTape(page, "e2e-versions", 1);
  const record = page.getByRole("button", { name: "record changes" });
  await expect(record).toHaveAttribute("aria-pressed", "false");
  // after the scale-up to 3 (1.5s): the diff then has a previous version
  await expect.poll(async () => (await focused(page)).rows[0]?.cells, tapeSteps).toContain("3/3");
  await page.keyboard.press("Enter");
  await page.keyboard.press("d");
  const dialog = page.getByRole("region", { name: "object detail" });
  await expect(dialog.locator('[data-viewer="diff"] .monaco-diff-editor')).toBeVisible();
  await expect(dialog).toContainText("previous → current");
  await expect(dialog.getByRole("status", { name: "diff versions" })).toHaveCount(0);
  await page.keyboard.press("["); // nothing to step to
  expect(await viewing(page)).toBe(true);
});

test("diff versions: record changes (⇧R), then [ / ] step through it, the changed fields above the diff", async ({ page }) => {
  await openTape(page, "e2e-versions", 1);
  // before the tape's first change (1s): the current object is the first version
  await page.keyboard.press("Shift+R");
  const record = page.getByRole("button", { name: "record changes" });
  await expect(record).toHaveAttribute("aria-pressed", "true");
  await expect(record).toHaveText(/recording/);
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-viewer="single"] .monaco-editor')).toBeVisible();
  const dialog = page.getByRole("region", { name: "object detail" });
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
  expect(await viewing(page)).toBe(true);
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

// e2e-secrets: a managed resource's brotli manifests (scaled 1 → 2 at 1s), a copy of them to write edits to, a TLS pair and a token.
// Each test opens its own namespace (its own watch, so the tape starts over), sorted by name.
test.describe("decode (⏎ in the YAML)", () => {
  async function openSecrets(page: Page, record = false) {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    await page.getByRole("combobox", { name: "resource" }).fill("e2e-secrets");
    await page.getByRole("combobox", { name: "namespace" }).fill(`dec-${test.info().testId.slice(0, 8)}`);
    await page.getByRole("combobox", { name: "resource" }).press("Enter");
    if (record) {
      await expect.poll(async () => (await focused(page)).spec.resource === "e2e-secrets" && !!(await focused(page)).serverId).toBe(true);
      await page.keyboard.press("Shift+R");
    }
    await expect
      .poll(async () => {
        const p = await focused(page);
        return p.spec.resource === "e2e-secrets" && !!p.serverId && p.status?.synced ? p.total : -1;
      })
      .toBe(4);
  }
  /** Selects a row by name and opens its YAML. */
  async function yamlOf(page: Page, name: string) {
    const rows = (await focused(page)).rows;
    const i = rows.findIndex((r) => r.cells.includes(name));
    expect(i).toBeGreaterThanOrEqual(0);
    for (let n = 0; n < i; n++) await page.keyboard.press("j");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("region", { name: "object detail" });
    await expect(dialog.locator(".view-lines")).toContainText(name);
    return dialog;
  }
  const decoded = (page: Page) => page.getByRole("region", { name: "decoded value" });
  // the object view's and the decoded value's cursor lines (0-based)
  const cursors = async (page: Page) => {
    const s = await inspect(page);
    return { detail: s.cursor, decode: s.decodeCursor };
  };
  const steps = (page: Page) => decoded(page).getByRole("group", { name: "decode steps" });
  // the pane's header: the object, then each decoded level's own path
  const crumbs = (page: Page) => page.getByRole("navigation", { name: "object path" });
  const status = (page: Page) => page.getByRole("status", { name: "object status" });

  test("a managed resource's brotli manifests, a kubeconfig in them (deeper), esc back up level by level", async ({ page }) => {
    await openSecrets(page);
    const dialog = await yamlOf(page, "managedresource-vpn");
    await expect(dialog).toContainText("⏎: decode");
    await dialog.locator(".view-line", { hasText: "data.yaml.br:" }).click();
    await page.keyboard.press("Enter");
    const dec = decoded(page);
    // in the object view's place, the field in its header's path
    await expect(crumbs(page)).toContainText('managedresource-vpn›data["data.yaml.br"]');
    await expect(dialog).toBeHidden();
    await expect(steps(page)).toHaveText(/base64→brotli→yaml· \d+(\.\d)? (B|KiB)/);
    await expect(dec.locator(".view-lines")).toContainText("name: vpn-shoot");
    expect((await inspect(page)).focus).toBe("detail");
    // deeper: the kubeconfig in the second document
    await dec.locator(".view-line", { hasText: "kubeconfig:" }).click();
    const kubeconfigLine = (await cursors(page)).decode;
    await page.keyboard.press("Enter");
    await expect(crumbs(page)).toContainText('managedresource-vpn›data["data.yaml.br"]›doc 2: data.kubeconfig');
    await expect(crumbs(page).getByRole("button", { name: "doc 2: data.kubeconfig" })).toHaveAttribute("title", 'data["data.yaml.br"] → doc 2: data.kubeconfig');
    await expect(dec.locator(".view-lines")).toContainText("server: https://api.shoot.example.com");
    await expect(dec).toContainText("esc: up");
    // a plain value has nothing to decode: it says so in the pane's status line, and stays (the cursor too)
    await dec.locator(".view-line", { hasText: "server:" }).click();
    const server = (await cursors(page)).decode;
    expect(server).toBeGreaterThan(0);
    await page.keyboard.press("Enter");
    await expect(status(page)).toContainText("is plain text: nothing to decode");
    await expect(crumbs(page)).toContainText("doc 2: data.kubeconfig");
    expect((await cursors(page)).decode).toBe(server);
    // esc: a level up (the cursor back on kubeconfig:), then back to the YAML, then to the table
    await page.keyboard.press("Escape");
    await expect(dec.locator(".view-lines")).toContainText("name: vpn-shoot");
    await expect(crumbs(page)).not.toContainText("data.kubeconfig");
    expect((await cursors(page)).decode).toBe(kubeconfigLine);
    await page.keyboard.press("Escape");
    await expect(dec).toHaveCount(0);
    await expect(dialog).toBeVisible();
    expect(await viewing(page)).toBe(true);
    // the object's keys work again, on its cursor (still on data.yaml.br: it stayed under the decoded value)
    await page.keyboard.press("Enter");
    await expect(steps(page)).toContainText("brotli");
    await page.keyboard.press("Escape");
    // nothing to decode on the first level: the YAML view says so, in its status line (the cursor stays)
    await dialog.locator(".view-line", { hasText: "kind: Secret" }).click();
    const kind = (await cursors(page)).detail;
    await page.keyboard.press("Enter");
    await expect(status(page)).toContainText("kind is plain text: nothing to decode");
    expect((await cursors(page)).detail).toBe(kind);
    expect(await viewing(page)).toBe(true);
    await page.keyboard.press("Escape");
    expect((await inspect(page)).objects).toEqual({});
    expect((await inspect(page)).focus).toBe("table");
  });

  test.describe("editing decoded values (⌘E in the editor)", () => {
    const editor = (page: Page) => page.getByRole("region", { name: "edit object" });
    const levels = (page: Page) => page.getByRole("navigation", { name: "edit levels" });
    const shown = (page: Page) => editor(page).locator("[data-edit-level]:not(.hidden) .view-lines");
    const objectText = (page: Page) => editor(page).locator("[data-editor=yaml]").first().locator(".view-lines");
    const levelCount = async (page: Page) => {
      const s = await inspect(page);
      return s.objects[s.focusedPane]?.editLevels ?? -1;
    };
    /** Clicks the line of the shown editor (the top level's, else the object's) holding text. */
    async function clickLine(page: Page, text: string) {
      const n = await levelCount(page);
      const ed = n ? editor(page).locator(`[data-edit-level="${n}"]`) : editor(page).locator("[data-editor=yaml]").first();
      await ed.locator(".view-line", { hasText: text }).first().click();
    }
    /** Selects text in the shown editor (find) and types over it. */
    async function retype(page: Page, from: string, to: string) {
      await page.keyboard.press("ControlOrMeta+F");
      await page.keyboard.insertText(from);
      await page.keyboard.press("Escape");
      await expect(editor(page).locator(".find-widget.visible")).toHaveCount(0);
      await page.keyboard.type(to);
    }

    test("a managed resource's kubeconfig two levels down: edited, esc encodes it back up, ⌘S previews and ⏎ writes it", async ({ page }) => {
      await openSecrets(page);
      await yamlOf(page, "managedresource-edit");
      await page.keyboard.press("e");
      await expect(editor(page)).toContainText("Secret managedresource-edit");
      await clickLine(page, "data.yaml.br:");
      await page.keyboard.press("ControlOrMeta+E");
      await expect(levels(page)).toContainText('data["data.yaml.br"]');
      await expect(levels(page).getByLabel("edit chain")).toHaveText("base64 → brotli → yaml");
      await expect(shown(page)).toContainText("name: vpn-shoot");
      await expect.poll(() => levelCount(page)).toBe(1);
      expect((await inspect(page)).focus).toBe("edit");
      // deeper: doc 2's kubeconfig
      await clickLine(page, "kubeconfig:");
      await page.keyboard.press("ControlOrMeta+E");
      await expect(levels(page)).toContainText("doc 2: data.kubeconfig");
      await expect(shown(page)).toContainText("server: https://api.shoot.example.com");
      // a plain value can't go deeper: it says so, the level stays
      await clickLine(page, "server:");
      await page.keyboard.press("ControlOrMeta+E");
      await expect(page.getByRole("status", { name: "object status" })).toContainText("plain text");
      await expect.poll(() => levelCount(page)).toBe(2);
      await retype(page, "api.shoot.example.com", "api.new.example.com");
      await expect(shown(page)).toContainText("server: https://api.new.example.com");
      await expect(levels(page)).toContainText("changed");
      await expect(page.getByLabel("unsaved changes")).toBeVisible();
      // esc: up a level, the change encoded into the manifests (no "discard?" on the way)
      await page.keyboard.press("Escape");
      await expect.poll(() => levelCount(page)).toBe(1);
      await expect(levels(page)).toContainText("changed");
      await expect(shown(page)).toContainText("name: vpn-shoot");
      // ⌘S from a level: everything encoded into the object, then the server's dry run of it
      await page.keyboard.press("ControlOrMeta+S");
      await expect(editor(page)).toContainText("preview (server dry run");
      await expect.poll(() => levelCount(page)).toBe(0);
      const diff = editor(page).locator('[data-viewer="diff"]');
      await expect(diff).toContainText("data.yaml.br");
      await page.keyboard.press("Enter");
      await expect(editor(page)).toHaveCount(0);
      await expect(page.getByLabel("message").filter({ hasText: "edited" }).first()).toHaveText(/edited .*managedresource-edit/);
      // the object as written decodes to the edit
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("region", { name: "object detail" });
      await dialog.locator(".view-line", { hasText: "data.yaml.br:" }).click();
      await page.keyboard.press("Enter");
      await decoded(page).locator(".view-line", { hasText: "kubeconfig:" }).click();
      await page.keyboard.press("Enter");
      await expect(decoded(page).locator(".view-lines")).toContainText("server: https://api.new.example.com");
    });

    test("e in a decoded value opens the editor down to it; esc up keeps the change, ⌘Z there takes it back; a JWT can't be edited", async ({ page }) => {
      await openSecrets(page);
      const dialog = await yamlOf(page, "e2e-token");
      await dialog.locator(".view-line", { hasText: ".dockerconfigjson:" }).click();
      await page.keyboard.press("Enter");
      await expect(decoded(page).locator(".view-lines")).toContainText("registry.example.com");
      await expect(decoded(page)).toContainText("e: edit");
      // e: the editor, at the same value
      await page.keyboard.press("e");
      await expect(levels(page)).toContainText(".dockerconfigjson");
      await expect.poll(() => levelCount(page)).toBe(1);
      // one-line JSON: indented to edit
      await expect(shown(page)).toContainText('"registry.example.com": {');
      await retype(page, "registry.example.com", "registry.other.com");
      await page.keyboard.press("Escape");
      await expect.poll(() => levelCount(page)).toBe(0);
      await expect(objectText(page)).not.toContainText("eyJhdXRocyI6eyJyZWdpc3RyeS5leGFtcGxlLmNvbSI6");
      await expect(page.getByLabel("unsaved changes")).toBeVisible();
      // the encode is one edit in the object's editor: ⌘Z takes it back
      await page.keyboard.press("ControlOrMeta+Z");
      await expect(objectText(page)).toContainText("eyJhdXRocyI6eyJyZWdpc3RyeS5leGFtcGxlLmNvbSI6");
      await expect(page.getByLabel("unsaved changes")).toHaveCount(0);
      // a JWT: its signature would break
      await clickLine(page, "token:");
      await page.keyboard.press("ControlOrMeta+E");
      await expect(page.getByRole("status", { name: "object status" })).toContainText("JWT");
      await expect.poll(() => levelCount(page)).toBe(0);
      // a click on "object" in the header goes up from any level
      await clickLine(page, ".dockerconfigjson:");
      await page.keyboard.press("ControlOrMeta+E");
      await expect.poll(() => levelCount(page)).toBe(1);
      await levels(page).getByRole("button", { name: "object" }).click();
      await expect.poll(() => levelCount(page)).toBe(0);
    });
  });

  test("a click on the object in the header goes back up from any level; ⇧⏎ puts the decoded value in a split", async ({ page }) => {
    await openSecrets(page);
    const dialog = await yamlOf(page, "managedresource-vpn");
    await dialog.locator(".view-line", { hasText: "data.yaml.br:" }).click();
    await page.keyboard.press("Enter");
    await decoded(page).locator(".view-line", { hasText: "kubeconfig:" }).click();
    await page.keyboard.press("Enter");
    await expect(crumbs(page)).toContainText("doc 2: data.kubeconfig");
    // ⇧⏎: this level in a pane of its own, to compare; the one here stays
    const here = (await inspect(page)).focusedPane;
    await page.keyboard.press("Shift+Enter");
    const s = await inspect(page);
    expect(s.objects[s.focusedPane]).toMatchObject({ split: true, decoded: 2 });
    expect(s.objects[here]).toMatchObject({ split: false, decoded: 2 });
    await expect(page.locator(`section[data-pane="${s.focusedPane}"]`).getByRole("region", { name: "decoded value" }).locator(".view-lines")).toContainText("server: https://api.shoot.example.com");
    // back in the first: the object in its header, a click goes back to it from two levels down
    await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await page.locator(`section[data-pane="${here}"]`).getByRole("navigation", { name: "object path" }).getByRole("button", { name: "managedresource-vpn" }).click();
    await expect.poll(async () => (await inspect(page)).objects[here]?.decoded).toBe(0);
    await expect(page.locator(`section[data-pane="${here}"]`).getByRole("region", { name: "object detail" })).toBeVisible();
  });

  test("a click on a step leaves it out (the raw brotli bytes as a hex dump); ↺ detects again", async ({ page }) => {
    await openSecrets(page);
    const dialog = await yamlOf(page, "managedresource-vpn");
    await dialog.locator(".view-line", { hasText: "data.yaml.br:" }).click();
    await page.keyboard.press("Enter");
    await expect(steps(page)).toContainText("brotli");
    await steps(page).getByRole("button", { name: "brotli" }).click();
    await expect(steps(page)).toHaveText(/^base64→binary/);
    await expect(decoded(page).locator(".view-lines")).toContainText("# binary,");
    await steps(page).getByRole("button", { name: "↺ auto" }).click();
    await expect(steps(page)).toHaveText(/^base64→brotli→yaml/);
    // the rendering: off shows the decoded text as it is
    await steps(page).getByRole("button", { name: "yaml" }).click();
    await expect(steps(page)).toHaveText(/^base64→brotli→text/);
  });

  test("a TLS key: matches its certificate; the certificate's details", async ({ page }) => {
    await openSecrets(page);
    const dialog = await yamlOf(page, "api-tls");
    await dialog.locator(".view-line", { hasText: "tls.key:" }).click();
    await page.keyboard.press("Enter");
    const view = decoded(page).locator(".view-lines");
    await expect(view).toContainText("type: private key");
    await expect(view).toContainText("key: ECDSA P-256");
    await expect(view).toContainText('- "tls.crt (api.e2e.example.com)"');
    await page.keyboard.press("Escape");
    await dialog.locator(".view-line", { hasText: "tls.crt:" }).click();
    await page.keyboard.press("Enter");
    await expect(view).toContainText('subject: "CN=api.e2e.example.com"');
    await expect(view).toContainText("notAfter: 2036-01-01T00:00:00Z");
    await expect(steps(page)).toHaveText(/^base64→pem/);
    // the PEM text itself: the rendering off
    await steps(page).getByRole("button", { name: "pem" }).click();
    await expect(view).toContainText("-----BEGIN CERTIFICATE-----");
  });

  test("a token: the JWT's claims, its times annotated", async ({ page }) => {
    await openSecrets(page);
    const dialog = await yamlOf(page, "e2e-token");
    await dialog.locator(".view-line", { hasText: "token:" }).click();
    await page.keyboard.press("Enter");
    const view = decoded(page).locator(".view-lines");
    await expect(view).toContainText("# JWT, signature not verified");
    await expect(view).toContainText("sub: system:serviceaccount:kube-system:e2e");
    await expect(view).toContainText("exp: 2082758400  # 2036-01-01T00:00:00Z, in");
  });

  test("JSON stays JSON (colored as such), and goes deeper by its lines", async ({ page }) => {
    await openSecrets(page);
    const dialog = await yamlOf(page, "e2e-token");
    await dialog.locator(".view-line", { hasText: ".dockerconfigjson:" }).click();
    await page.keyboard.press("Enter");
    const dec = decoded(page);
    await expect(steps(page)).toHaveText(/^base64→json/);
    await expect(dec.locator(".view-lines")).toContainText('"registry.example.com": {');
    await expect(dec.locator(".view-lines")).not.toContainText("auths:");
    expect(await dec.locator(".view-lines").evaluate((el) => el.closest("[data-mode-id]")?.getAttribute("data-mode-id"))).toBe("json");
    // tokenized as JSON: a key and a string value in different colors (Monaco tokenizes after rendering: poll)
    const color = (text: string) => dec.locator(".view-lines span span", { hasText: text }).first().evaluate((el) => getComputedStyle(el).color);
    await expect.poll(async () => (await color('"auths"')) !== (await color('"ZTJl'))).toBe(true);
    await dec.locator(".view-line", { hasText: '"auth":' }).click();
    await page.keyboard.press("Enter");
    await expect(crumbs(page)).toContainText('auths["registry.example.com"].auth');
    await expect(dec.locator(".view-lines")).toContainText("e2e:s3cret");
  });

  test("the decoded diff: ⏎ in the object diff decodes both versions, [ / ] step them", async ({ page }) => {
    await openSecrets(page, true);
    // the scale-up (1s) is in: two versions
    await expect.poll(async () => (await inspect(page)).panes[(await inspect(page)).focusedPane]!.status?.recording).toBe(true);
    const dialog = await yamlOf(page, "managedresource-vpn");
    await page.keyboard.press("d");
    const versions = dialog.getByRole("status", { name: "diff versions" });
    await expect(versions).toContainText("v2", tapeSteps);
    await expect(dialog).toContainText("⏎: decode both sides");
    await dialog.locator(".editor.modified .view-line", { hasText: "data.yaml.br:" }).click();
    await page.keyboard.press("Enter");
    const dec = decoded(page);
    const diff = dec.locator('[data-viewer="diff"]');
    await expect(diff.locator(".editor.original .view-lines")).toContainText("replicas: 1");
    await expect(diff.locator(".editor.modified .view-lines")).toContainText("replicas: 2");
    await expect(dec.getByRole("status", { name: "change position" })).toHaveText("1 / 1");
    await expect(dec.getByRole("status", { name: "diff versions" })).toContainText("newest");
    // [: the first version, nothing before it
    await page.keyboard.press("[");
    await expect(dec).toContainText("no version before this one");
    await page.keyboard.press("]");
    await expect(diff.locator(".editor.modified .view-lines")).toContainText("replicas: 2");
    // back to the object diff, its own versions and j/k
    await page.keyboard.press("Escape");
    await expect(dec).toHaveCount(0);
    await expect(versions).toContainText("newest");
    await expect(dialog.getByRole("status", { name: "change position" })).toHaveText("1 / 1");
  });
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
    await expect(page.getByRole("button", { name: "record changes" })).toHaveAttribute("aria-pressed", "true");
    // recording began before the first change: all three are on the timeline later
    expect(await readyCell(page)).toBe("1/1");
    await expect.poll(async () => (await focused(page)).rows[0]?.cells.join(" "), tapeSteps).toContain("3/3");
    // the image change (4s) comes after the scale to 3: in the YAML once it's there
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "object detail" }).locator(".view-lines")).toContainText("web:2", tapeSteps);
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
    const dialog = page.getByRole("region", { name: "object detail" });
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
    await expect(page.getByRole("button", { name: "record changes" })).toHaveAttribute("aria-pressed", "true");
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
    const dialog = page.getByRole("region", { name: "object detail" });
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
  /** context false: in the focused pane, the page as it is (e.g. a new tab), not reloaded. */
  async function openStatic(page: Page, context: string | false = "") {
    if (context !== false) await ready(page);
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
  test("h hides deployments whose rollout is complete; kinds without a health rule get no checkbox", async ({ page }) => {
    await openTape(page, "e2e-deploys");
    const box = page.getByRole("checkbox", { name: "hide healthy" });
    await expect(page.locator("label", { has: box })).toHaveAttribute("title", /deployments whose replicas/);
    await page.keyboard.press("h");
    await expect.poll(async () => (await focused(page)).rows.map((r) => r.key)).toEqual(["d-web", "d-worker"]);
    await page.keyboard.press("ControlOrMeta+O");
    await page.getByRole("combobox", { name: "resource" }).fill("rel-configmaps");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await focused(page)).status?.synced).toBe(true);
    await expect(box).toHaveCount(0);
    // the toggle carried over with the spec turns off; turning it on again is refused here
    await page.keyboard.press("h");
    expect((await focused(page)).spec).not.toMatchObject({ hideHealthy: true });
    await page.keyboard.press("h");
    await expect(page.getByLabel("message")).toContainText("no health rule for configmaps");
  });

  // e2e-managedresources: kube-proxy is healthy; coredns is progressing, vpn-shoot's apply failed, metrics-server isn't reconciled yet
  test("h hides managed resources applied, healthy and not progressing (a rule of conditions)", async ({ page }) => {
    await openTape(page, "e2e-managedresources", 4);
    const box = page.getByRole("checkbox", { name: "hide healthy" });
    await expect(page.locator("label", { has: box })).toHaveAttribute("title", "hide managed resources applied, healthy and not progressing (h)");
    await page.keyboard.press("h");
    await expect.poll(async () => (await focused(page)).rows.map((r) => r.key).sort()).toEqual(["mr-failed", "mr-new", "mr-progressing"]);
  });

  // nodes: n-2 is cordoned, n-3 isn't Ready, so only n-1 is healthy
  test("h hides nodes that are Ready and not cordoned", async ({ page }) => {
    await openTape(page, "nodes", 3);
    await expect(page.locator("label", { has: page.getByRole("checkbox", { name: "hide healthy" }) })).toHaveAttribute("title", /nodes that are Ready and not cordoned/);
    await page.keyboard.press("h");
    await expect.poll(async () => (await focused(page)).rows.map((r) => r.key)).toEqual(["n-2", "n-3"]);
  });

  test("d describes in Monaco; y back to yaml", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    await page.keyboard.press("d");
    const dialog = page.getByRole("region", { name: "object detail" });
    await expect(dialog).toContainText("describe");
    await expect(dialog.locator(".view-lines")).toContainText("Name:         web-1");
    await expect(dialog.locator(".view-lines")).toContainText("app=web");
    await page.keyboard.press("y");
    await expect(dialog.locator(".view-lines")).toContainText("apiVersion: v1");
    await page.keyboard.press("Escape");
    expect((await inspect(page)).overlays).toEqual([]);
  });

  test("⇧D describes in a split to the right; ⇧⏎ on the menu's describe and edit entries does too", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    const table = (await inspect(page)).focusedPane;
    await page.keyboard.press("Shift+D");
    let s = await inspect(page);
    const split = s.focusedPane;
    expect(split).not.toBe(table);
    expect(s.objects[split]).toMatchObject({ split: true, from: table, view: "describe" });
    await expect(page.locator(`section[data-pane="${split}"]`).getByRole("region", { name: "object detail" }).locator(".view-lines")).toContainText("Name:         web-1");
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await inspect(page)).focusedPane).toBe(table);
    // the row menu: ⇧⏎ on describe (its entries come in async: wait for the first one)
    const active = page.getByRole("menu").locator("[data-active]");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(active).toContainText("view YAML");
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await expect(active).toContainText("describe");
    await page.keyboard.press("Shift+Enter");
    s = await inspect(page);
    expect(s.focusedPane).not.toBe(table);
    expect(s.objects[s.focusedPane]).toMatchObject({ split: true, view: "describe" });
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await inspect(page)).focusedPane).toBe(table);
    // ⇧⏎ on edit YAML: the editor in a split
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(active).toContainText("view YAML");
    await page.keyboard.press("j");
    await expect(active).toContainText("edit YAML");
    await page.keyboard.press("Shift+Enter");
    await expect.poll(async () => (await inspect(page)).focus).toBe("edit");
    s = await inspect(page);
    expect(s.objects[s.focusedPane]).toMatchObject({ split: true, editing: true, from: table });
  });

  test("describe diff: d compares with the previous look (times ignored), r takes a new look", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    const dialog = page.getByRole("region", { name: "object detail" });
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

  test.describe("panes in windows of their own", () => {
    type Kw = { __kw: { windowName: string; sendPane(id: string, to: string, at: unknown): Promise<void>; detachPane(id: string, at?: { x: number; y: number }): Promise<void>; bridge(): { windows(): Promise<{ name: string }[]> } } };
    /** The grip dropped outside every window (a browser can't drag there: the drop's own call). */
    const detach = async (page: Page, id: string) => {
      const popup = page.waitForEvent("popup");
      await page.evaluate((id) => (window as unknown as Kw).__kw.detachPane(id, { x: 40, y: 40 }), id);
      const w = await popup;
      await expect.poll(() => w.evaluate(() => !!(window as unknown as Partial<Kw>).__kw && (window as unknown as Kw).__kw.windowName)).toMatch(/^w\d+$/);
      return w;
    };

    test("a grip dropped outside the window detaches the pane into a window of its own: the same watch, its rows there, gone here", async ({ page }) => {
      await openStatic(page);
      await page.keyboard.press("ControlOrMeta+Shift+D"); // v1 | v2, the same listing
      // dragged and dropped within the window with no target: nothing happens, no window opens
      const only = (await page.locator('section[data-pane="v1"]').boundingBox())!;
      await page.mouse.move(only.x + only.width / 2, only.y + only.height / 2);
      await page.mouse.move(only.x + only.width / 2 + 5, only.y + only.height / 2);
      const g = (await page.locator('section[data-pane="v1"]').getByRole("button", { name: "move pane" }).boundingBox())!;
      await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
      await page.mouse.down();
      await page.mouse.move(only.x + only.width / 2, only.y + only.height / 2, { steps: 8 });
      await page.mouse.up();
      expect(page.context().pages()).toHaveLength(1);
      await expect.poll(async () => !!(await inspect(page)).panes.v2?.serverId).toBe(true);
      const serverId = (await inspect(page)).panes.v2!.serverId;
      const w = await detach(page, "v2");
      await expect.poll(async () => (await focused(w)).serverId).toBe(serverId);
      await expect.poll(async () => (await focused(w)).rows.some((r) => r.key === "s-web-1")).toBe(true);
      const s = await inspect(page);
      expect(Object.keys(s.panes)).toEqual(["v1"]);
      expect(s.tabs).toHaveLength(1);
      // the detached window's only pane is already a window of its own, but can move back (there's another window)
      await expect(w.getByRole("button", { name: "move pane" })).toHaveCount(1);
      await w.evaluate(() => (window as unknown as Kw).__kw.detachPane("v1"));
      expect(page.context().pages()).toHaveLength(2); // no third window
    });

    test("a shell moves to another window and back with its screen; the last pane leaving closes that window", async ({ page }) => {
      await openStatic(page);
      await select(page, "s-web-3");
      await page.keyboard.press("x");
      await expect.poll(() => termText(page)).toContain("web-3:app$");
      await page.keyboard.type("echo before");
      await page.keyboard.press("Enter");
      await expect.poll(() => termText(page)).toContain("echo before\necho before");
      const id = (await inspect(page)).focusedPane;
      const session = ((await focused(page)) as unknown as { term: { session: string } }).term.session;
      const w = await detach(page, id);
      const name = await w.evaluate(() => (window as unknown as Kw).__kw.windowName);
      // there: the same shell, its screen, and keys go to it
      await expect.poll(async () => ((await focused(w)) as unknown as { term?: { session: string } }).term?.session).toBe(session);
      await expect.poll(() => termText(w)).toContain("echo before\necho before");
      await w.locator("[data-terminal]").click();
      await w.keyboard.type("echo there");
      await w.keyboard.press("Enter");
      await expect.poll(() => termText(w)).toContain("echo there\necho there");
      await expect(page.locator("[data-terminal]")).toHaveCount(0);
      // back, as a drop below the table would: the screen comes along, the window it leaves closes
      const closed = w.waitForEvent("close");
      await w.evaluate(() => {
        const kw = (window as unknown as Kw).__kw;
        const s = (window as unknown as { __kw: { inspect(): { focusedPane: string } } }).__kw.inspect();
        return kw.sendPane(s.focusedPane, "main", { tab: "t1", pane: "v1", side: "bottom" });
      });
      await closed;
      await expect.poll(async () => ((await focused(page)) as unknown as { term?: { session: string } }).term?.session).toBe(session);
      const s = await inspect(page);
      expect(s.tabs[0]!.layout).toEqual({ type: "split", dir: "column", children: [{ type: "pane", id: "v1" }, { type: "pane", id: s.focusedPane }] });
      await expect.poll(() => termText(page)).toContain("echo there\necho there");
      await page.keyboard.type("echo back");
      await page.keyboard.press("Enter");
      await expect.poll(() => termText(page)).toContain("echo back\necho back");
      await expect.poll(() => page.evaluate(() => (window as unknown as Kw).__kw.bridge().windows().then((l) => l.map((x) => x.name)))).not.toContain(name);
    });

    test("another window's drag over this one shows where the pane would go here, and the drop tells it", async ({ page }) => {
      await openStatic(page);
      await page.keyboard.press("ControlOrMeta+Shift+D"); // v1 | v2
      const w = await detach(page, "v2"); // the drag comes from there
      // what the dragging window sends: the pointer over the bottom of v1, in this window's page
      const v1 = (await page.locator('section[data-pane="v1"]').boundingBox())!;
      const answers: unknown[] = [];
      await w.exposeFunction("kwAnswer", (m: unknown) => void answers.push(m));
      await w.evaluate(() => {
        const kw = (window as unknown as { __kw: { bridge(): { onWindow(cb: (m: { kind: string; data: unknown }) => void): void } } }).__kw;
        kw.bridge().onWindow((m) => m.kind === "dragtarget" && (window as unknown as { kwAnswer(d: unknown): void }).kwAnswer(m.data));
      });
      type Send = { __kw: { bridge(): { sendWindow(to: string, kind: string, data: unknown): Promise<void> } } };
      const send = (kind: string, data: unknown) => w.evaluate(([k, d]) => (window as unknown as Send).__kw.bridge().sendWindow("main", k, d), [kind, data] as const);
      await send("dragover", { title: "moving", x: v1.x + v1.width / 2, y: v1.y + v1.height * 0.9 });
      await expect(page.getByLabel("drop target")).toBeVisible();
      await expect(page.getByLabel("moving pane")).toHaveText("moving");
      await expect.poll(() => answers.at(-1)).toEqual({ target: { tab: "t1", pane: "v1", side: "bottom" }, drop: false });
      // released: the final target, and the preview goes
      await send("dragdrop", {});
      await expect.poll(() => answers.at(-1)).toEqual({ target: { tab: "t1", pane: "v1", side: "bottom" }, drop: true });
      await expect(page.getByLabel("drop target")).toBeHidden();
      // left without a drop: the preview goes too
      await send("dragover", { title: "moving", x: v1.x + 10, y: v1.y + v1.height / 2 });
      await expect(page.getByLabel("drop target")).toBeVisible();
      await send("dragleave", {});
      await expect(page.getByLabel("drop target")).toBeHidden();
    });

    test("closing a detached window ends the shell it shows", async ({ page }) => {
      await openStatic(page);
      await select(page, "s-web-3");
      await page.keyboard.press("x");
      await expect.poll(() => termText(page)).toContain("web-3:app$");
      const id = (await inspect(page)).focusedPane;
      const w = await detach(page, id);
      await expect.poll(() => termText(w)).toContain("web-3:app$");
      const name = await w.evaluate(() => (window as unknown as Kw).__kw.windowName);
      await w.close();
      await expect.poll(() => page.evaluate(() => (window as unknown as Kw).__kw.bridge().windows().then((l) => l.map((x) => x.name)))).not.toContain(name);
      // the pane of a closed window is gone everywhere
      expect(Object.keys((await inspect(page)).panes)).toEqual(["v1"]);
    });

    type KwTab = { __kw: { windowName: string; sendTab(id: string, to: string, at: number): Promise<void>; detachTab(id: string, at?: { x: number; y: number }): Promise<void>; inspect(): Inspect & { focusedPane: string } } };

    test("a tab dragged out of the window gets a window of its own with all its panes, and moves back into a place in the tab bar", async ({ page }) => {
      await openStatic(page);
      // t1: the listing; t3: a listing and a shell below it
      await page.keyboard.press("ControlOrMeta+T");
      await expect.poll(async () => (await inspect(page)).tabs.length).toBe(2);
      await openStatic(page, false);
      await select(page, "s-web-3");
      await page.keyboard.press("x");
      await expect.poll(() => termText(page)).toContain("web-3:app$");
      await page.keyboard.type("echo before");
      await page.keyboard.press("Enter");
      await expect.poll(() => termText(page)).toContain("echo before\necho before");
      const s0 = await inspect(page);
      const tab = s0.tabs[1]!;
      const [table, shell] = (tab.layout as { children: { id: string }[] }).children.map((c) => c.id);
      const serverId = s0.panes[table!]!.serverId;
      const session = ((await focused(page)) as unknown as { term: { session: string } }).term.session;
      const popup = page.waitForEvent("popup");
      await page.evaluate((id) => (window as unknown as KwTab).__kw.detachTab(id, { x: 40, y: 40 }), tab.id);
      const w = await popup;
      await expect.poll(() => w.evaluate(() => !!(window as unknown as Partial<KwTab>).__kw && (window as unknown as KwTab).__kw.windowName)).toMatch(/^w\d+$/);
      // there: the same table watch and shell, laid out as they were, the shell focused
      await expect.poll(async () => (await inspect(w)).tabs.length).toBe(1);
      const s1 = await inspect(w);
      expect(s1.tabs[0]!.layout).toMatchObject({ type: "split", dir: "column", children: [{ type: "pane" }, { type: "pane" }] });
      const [t2, sh2] = (s1.tabs[0]!.layout as { children: { id: string }[] }).children.map((c) => c.id);
      await expect.poll(async () => (await inspect(w)).panes[t2!]?.serverId).toBe(serverId);
      await expect.poll(async () => (await inspect(w)).panes[t2!]?.rows.some((r) => r.key === "s-web-1")).toBe(true);
      expect(s1.focusedPane).toBe(sh2);
      await expect.poll(async () => ((await focused(w)) as unknown as { term?: { session: string } }).term?.session).toBe(session);
      await expect.poll(() => termText(w)).toContain("echo before\necho before");
      await w.locator("[data-terminal]").click();
      await w.keyboard.type("echo there");
      await w.keyboard.press("Enter");
      await expect.poll(() => termText(w)).toContain("echo there\necho there");
      // gone here, with both its panes
      const s2 = await inspect(page);
      expect(s2.tabs.map((t) => t.id)).toEqual(["t1"]);
      expect(Object.keys(s2.panes)).not.toContain(table);
      expect(Object.keys(s2.panes)).not.toContain(shell);
      // back, before the first tab: the window it leaves closes
      const closed = w.waitForEvent("close");
      await w.evaluate(() => {
        const kw = (window as unknown as KwTab).__kw;
        return kw.sendTab(kw.inspect().tabs[0]!.id, "main", 0);
      });
      await closed;
      await expect.poll(async () => (await inspect(page)).tabs.length).toBe(2);
      const s3 = await inspect(page);
      expect(s3.activeTab).toBe(0);
      expect(s3.tabs[1]!.id).toBe("t1");
      await expect.poll(async () => ((await focused(page)) as unknown as { term?: { session: string } }).term?.session).toBe(session);
      await expect.poll(() => termText(page)).toContain("echo there\necho there");
      await page.keyboard.type("echo back");
      await page.keyboard.press("Enter");
      await expect.poll(() => termText(page)).toContain("echo back\necho back");
    });

    test("another window's tab drag over this one marks its place in the tab bar, and the drop tells it", async ({ page }) => {
      await openStatic(page);
      await page.keyboard.press("ControlOrMeta+T"); // t1, t3
      await expect.poll(async () => (await inspect(page)).tabs.length).toBe(2);
      const w = await detach(page, "v1");
      const answers: unknown[] = [];
      await w.exposeFunction("kwAnswer", (m: unknown) => void answers.push(m));
      await w.evaluate(() => {
        const kw = (window as unknown as { __kw: { bridge(): { onWindow(cb: (m: { kind: string; data: unknown }) => void): void } } }).__kw;
        kw.bridge().onWindow((m) => m.kind === "dragtarget" && (window as unknown as { kwAnswer(d: unknown): void }).kwAnswer(m.data));
      });
      type Send = { __kw: { bridge(): { sendWindow(to: string, kind: string, data: unknown): Promise<void> } } };
      const send = (kind: string, data: unknown) => w.evaluate(([k, d]) => (window as unknown as Send).__kw.bridge().sendWindow("main", k, d), [kind, data] as const);
      // over the left half of the only tab: before it
      const first = (await page.getByRole("tab").first().boundingBox())!;
      await send("dragover", { what: "tab", title: "moving", x: first.x + 4, y: first.y + first.height / 2 });
      await expect(page.getByLabel("drop target")).toBeVisible();
      await expect(page.getByLabel("moving tab")).toHaveText("moving");
      await expect.poll(() => answers.at(-1)).toEqual({ target: { at: 0 }, drop: false });
      // over the panes: after the last tab
      const main = (await page.locator("main").boundingBox())!;
      await send("dragover", { what: "tab", title: "moving", x: main.x + main.width / 2, y: main.y + main.height / 2 });
      await expect.poll(() => answers.at(-1)).toEqual({ target: { at: 1 }, drop: false });
      await send("dragdrop", {});
      await expect.poll(() => answers.at(-1)).toEqual({ target: { at: 1 }, drop: true });
      await expect(page.getByLabel("drop target")).toBeHidden();
    });

    test("a split object view moving with its table's tab keeps the table's watch and follows it there", async ({ page }) => {
      await openStatic(page);
      await page.keyboard.press("ControlOrMeta+T");
      await expect.poll(async () => (await inspect(page)).tabs.length).toBe(2);
      await openStatic(page, false);
      await select(page, "s-web-1");
      await page.keyboard.press("Shift+Enter");
      await expect.poll(async () => (await inspect(page)).objects[(await inspect(page)).focusedPane]?.split).toBe(true);
      await page.locator(`section[data-pane="${(await inspect(page)).focusedPane}"]`).getByRole("checkbox", { name: "follow selection" }).check();
      await expect.poll(async () => (await inspect(page)).objects[(await inspect(page)).focusedPane]?.follow).toBe(true);
      const s0 = await inspect(page);
      const serverId = s0.panes[(s0.tabs[1]!.layout as { children: { id: string }[] }).children[0]!.id]!.serverId;
      const popup = page.waitForEvent("popup");
      await page.evaluate((id) => (window as unknown as KwTab).__kw.detachTab(id), s0.tabs[1]!.id);
      const w = await popup;
      await expect.poll(async () => (await inspect(w).catch(() => undefined))?.tabs.length).toBe(1);
      const s1 = await inspect(w);
      const [table, view] = (s1.tabs[0]!.layout as { children: { id: string }[] }).children.map((c) => c.id);
      // the same watch, shared: no second one opened
      await expect.poll(async () => (await inspect(w)).panes[view!]?.serverId).toBe(serverId);
      expect(s1.panes[table!]!.serverId).toBe(serverId);
      expect(s1.objects[view!]).toMatchObject({ split: true, from: table, follow: true });
    });
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

  test("terminal.copyOnSelect: off by default, on it copies a mouse selection when released", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    await openStatic(page);
    await select(page, "s-web-3");
    await page.keyboard.press("x");
    await expect.poll(() => termText(page)).toContain("$");
    await page.evaluate(() => navigator.clipboard.writeText("before"));
    // off: selecting copies nothing
    await dragFirstRow(page, "[data-terminal]");
    await page.waitForTimeout(200);
    expect(await clipboard()).toBe("before");
    // on (a reloaded config applies to the open terminal)
    await setCopyOnSelect(page, true);
    await dragFirstRow(page, "[data-terminal]");
    await expect.poll(clipboard).toBe("tape shell in shop/web-3");
    // the shell still has the keyboard
    await page.keyboard.type("echo still here");
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page)).toContain("echo still here\necho still here");
    await setCopyOnSelect(page, false);
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

  test("⌃D in one of two shells hands the keys to the other: ⌃D ends that one too", async ({ page }) => {
    const shells = async () => Object.values((await inspect(page)).panes).filter((p) => (p as { term?: unknown }).term).length;
    await openStatic(page);
    await select(page, "s-web-3");
    await page.keyboard.press("x");
    await expect.poll(() => termText(page)).toContain("$");
    // back to the table for a second shell: it opens right below it, above the first
    await page.keyboard.press("ControlOrMeta+BracketLeft");
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
    await page.keyboard.press("x");
    await expect.poll(shells).toBe(2);
    await expect.poll(async () => (await page.locator("[data-terminal] .xterm-rows").allInnerTexts()).filter((t) => t.includes("$")).length).toBe(2);
    // the bottom shell ends: the one above it gets the focus, and its pane moves in the DOM
    await page.keyboard.press("ControlOrMeta+BracketRight");
    await page.keyboard.press("Control+D");
    await expect.poll(shells).toBe(1);
    expect((await inspect(page)).focus).toBe("terminal");
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[data-terminal]"))).toBe(true);
    await page.keyboard.press("Control+D");
    await expect.poll(shells).toBe(0);
    expect((await inspect(page)).focus).toBe("table");
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

  // n: ops pod on a node. Nodes complete from the nodes tape (Go's shared nodes watch); the tape
  // fake runs the echo shell (prompt node:ops-pod-…), names the shell command and fails images "fail/…".
  test("n on a pod: its node is prefilled, ↓ lists nodes, checkboxes set the pod; the shell opens below", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-3"); // runs on ip-10-0-2-22 (nodes.yaml)
    await page.keyboard.press("n");
    const dialog = page.getByRole("dialog", { name: "node shell" });
    const node = dialog.getByRole("combobox", { name: "node" });
    await expect(node).toHaveValue("ip-10-0-2-22.ec2.internal");
    await expect(node).toBeFocused();
    expect((await inspect(page)).focus).toBe("dialog");
    // the list isn't open at first (⏎ takes the prefilled one); ↓ lists the nodes with pool, zone and state
    const list = dialog.getByRole("listbox", { name: "node suggestions" });
    await expect(list).toHaveCount(0);
    await page.keyboard.press("ArrowDown");
    await expect(list.getByRole("option")).toHaveCount(3);
    await expect(list).toContainText("worker-a · eu-1b · cordoned");
    await expect(list).toContainText("not ready (unknown) · etcd · eu-1c");
    await expect(list.getByRole("option", { selected: true })).toHaveText(/ip-10-0-1-11/);
    // highlighting the prefilled node and pressing ⏎ only takes it (closes the list), doesn't launch
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
    // nothing highlighted in the image's list: ⏎ starts (a second one would reach the table once the dialog is gone)
    await page.keyboard.press("Enter");
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
    await page.keyboard.press("n");
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

  test("n on a row without a node (a config map): an empty node; unknown nodes and empty images are refused in the dialog", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-cfg");
    await page.keyboard.press("n");
    const dialog = page.getByRole("dialog", { name: "node shell" });
    const node = dialog.getByRole("combobox", { name: "node" });
    await expect(node).toHaveValue("");
    await node.press("ArrowDown");
    await expect(dialog.getByRole("listbox", { name: "node suggestions" }).getByRole("option")).toHaveCount(3);
    await node.press("Escape");
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
    expect((await inspect(page)).focus).toBe("table");
    // n is only the table's: in a shell it's typed
    await select(page, "s-web-3");
    await page.keyboard.press("x"); // one container: straight to its shell
    await expect.poll(async () => (await inspect(page)).focus).toBe("terminal");
    await page.keyboard.press("n");
    await expect.poll(() => termText(page)).toContain("$ n"); // typed into the shell
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press("Backspace"); // ⌃D ends the shell on an empty line only
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
    await expect(menu(page).getByRole("menuitem", { name: "node shell… n" })).toBeEnabled();
    await expect(menu(page).getByRole("menuitem", { name: /exec shell/ })).toBeDisabled();
    await menu(page).getByRole("menuitem", { name: "node shell… n" }).click();
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
    await page.keyboard.press("n");
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
    await page.keyboard.press("n");
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
    await page.keyboard.press("n");
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
    await page.keyboard.press("n");
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

  test("⌃T / ⌃⇧T: a local terminal on the pane's context and namespace, below / to the right", async ({ page }) => {
    await openStatic(page);
    const table = (await inspect(page)).focusedPane;
    await page.keyboard.press("Control+T");
    await expect.poll(async () => (await inspect(page)).focus).toBe("terminal");
    let s = await inspect(page);
    const below = s.focusedPane;
    expect((s.panes[below] as unknown as { term?: unknown }).term).toMatchObject({ context: "tape", local: {} });
    expect(s.tabs[0]!.layout).toMatchObject({ type: "split", dir: "column", children: [{ id: table }, { id: below }] });
    await expect(page.locator("section[data-pane] header").filter({ hasText: "terminal" })).toContainText("tape");
    // the tape's shell says what a real shell's kubeconfig would hold
    await expect.poll(() => termText(page)).toContain('local terminal: context tape, namespace ""');
    await expect.poll(() => termText(page)).toContain("local:tape$");
    // ⌃T is the shell's in a running terminal (transpose): typed, no new pane
    await page.keyboard.press("Control+T");
    await page.waitForTimeout(200);
    expect(Object.keys((await inspect(page)).panes)).toHaveLength(2);
    // from the table, ⌃⇧T: to its right, in the table's namespace
    await page.keyboard.press("Alt+ControlOrMeta+ArrowUp");
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
    await page.keyboard.press("ControlOrMeta+O");
    await page.getByRole("combobox", { name: "namespace" }).fill("shop");
    await page.getByRole("combobox", { name: "resource" }).fill("e2e-static");
    await page.keyboard.press("Enter");
    await expect.poll(async () => ((await focused(page)) as unknown as { pipeline: string }).pipeline).toContain(`"namespace":"shop"`);
    await page.keyboard.press("Control+Shift+T");
    await expect.poll(async () => Object.keys((await inspect(page)).panes).length).toBe(3);
    s = await inspect(page);
    expect(s.tabs[0]!.layout).toMatchObject({ type: "split", dir: "column", children: [{ type: "split", dir: "row", children: [{ id: table }, { id: s.focusedPane }] }, { id: below }] });
    const right = page.locator(`section[data-pane="${s.focusedPane}"] [data-terminal] .xterm-rows`);
    await expect.poll(() => right.innerText()).toContain('local terminal: context tape, namespace "shop"');
    // exit closes it, as an exec's does
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
    await expect.poll(async () => Object.keys((await inspect(page)).panes).length).toBe(2);
  });

  test("local terminal: refused on a read-only context, confirmed where the rule asks", async ({ page }) => {
    await openStatic(page, "tape-prod");
    await page.keyboard.press("Control+T");
    await expect(page.getByLabel("message")).toContainText("read-only context");
    expect(Object.keys((await inspect(page)).panes)).toHaveLength(1);
    await page.keyboard.press("ControlOrMeta+O");
    await page.getByRole("combobox", { name: "context" }).selectOption("tape-dev");
    await page.getByRole("combobox", { name: "resource" }).fill("e2e-static");
    await page.keyboard.press("Enter");
    await expect(page.locator("section[data-pane] header").first()).toContainText("DEV");
    await expect.poll(async () => (await focused(page)).status?.synced).toBe(true);
    await page.keyboard.press("Control+Shift+T");
    const confirm = page.getByRole("alertdialog", { name: "confirm terminal" });
    await expect(confirm).toContainText("local terminal on tape-dev");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await inspect(page)).focus).toBe("terminal");
    expect((await inspect(page)).tabs[0]!.layout).toMatchObject({ type: "split", dir: "row" });
  });

  test.describe("label, annotate, scale", () => {
    // e2e-meta: api (labels app, tier; annotation owner) is labeled and annotated, web (3 replicas) is scaled
    async function openMeta(page: Page, context = "") {
      await ready(page);
      await page.keyboard.press("ControlOrMeta+O");
      if (context) await page.getByRole("combobox", { name: "context" }).selectOption(context);
      await page.getByRole("combobox", { name: "resource" }).fill("e2e-meta");
      await page.keyboard.press("Enter");
      await expect.poll(async () => {
        const p = await focused(page);
        return p.spec.resource === "e2e-meta" && p.status?.synced && p.rows.length === 2;
      }).toBe(true);
    }
    const yamlOf = async (page: Page, key: string) => {
      await select(page, key);
      await page.keyboard.press("y");
      const text = await page.getByRole("region", { name: "object detail" }).locator(".view-lines").innerText();
      await page.keyboard.press("Escape");
      return text.replace(/\u00a0/g, " ");
    };

    test("⇧L lists the labels and previews the typed changes; ⏎ applies them, a bad value stays in the dialog", async ({ page }) => {
      await openMeta(page);
      await select(page, "m-api");
      await page.keyboard.press("Shift+L");
      const dialog = page.getByRole("dialog", { name: "label" });
      const list = dialog.getByRole("list", { name: "labels" });
      await expect(list).toContainText("app=api");
      await expect(list).toContainText("tier=back");
      const input = dialog.getByRole("combobox", { name: "changes" });
      await expect(input).toBeFocused();
      // a label value can't have spaces: Go refuses it, the text stays
      await input.fill(`env="two words"`);
      await input.press("Enter");
      await expect(dialog.getByRole("alert")).toContainText(`label value "two words"`);
      await expect(input).toHaveValue(`env="two words"`);
      await input.fill("env=prod tier=front app- ");
      await expect(list.locator("[data-op=add]")).toHaveText(/env=prod/);
      await expect(list.locator("[data-op=change]")).toHaveText(/tier=back front/);
      await expect(list.locator("[data-op=remove]")).toHaveText(/app=api/);
      await input.press("Enter");
      await expect(dialog).toHaveCount(0);
      await expect(page.getByLabel("message")).toHaveText("labeled e2e-meta/api");
      expect((await inspect(page)).focus).toBe("table");
      await expect.poll(async () => {
        const y = await yamlOf(page, "m-api");
        return y.includes("env: prod") && y.includes("tier: front") && !y.includes("app: api");
      }).toBe(true);
    });

    test("⇧A annotates; a click on a key takes it into the field; esc cancels", async ({ page }) => {
      await openMeta(page);
      await select(page, "m-api");
      await page.keyboard.press("Shift+A");
      const dialog = page.getByRole("dialog", { name: "annotate" });
      await dialog.getByRole("list", { name: "annotations" }).getByText("owner").click();
      const input = dialog.getByRole("combobox", { name: "changes" });
      await expect(input).toHaveValue("owner=team-a");
      await input.fill(`owner=team-b note="drained, back at 14:00"`);
      await input.press("Enter");
      await expect(page.getByLabel("message")).toHaveText("annotated e2e-meta/api");
      await expect.poll(async () => {
        const y = await yamlOf(page, "m-api");
        return y.includes("owner: team-b") && y.includes("note: drained, back at 14:00");
      }).toBe(true);
      await page.keyboard.press("Shift+A");
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      expect((await inspect(page)).focus).toBe("table");
    });

    test("↓ in the label dialog lists the labels set lately; ⏎ takes one for the word at the caret, ✕ forgets one", async ({ page }) => {
      // the first test set env=prod and tier=front on api; web takes them from the history
      await openMeta(page);
      await select(page, "m-web");
      await page.keyboard.press("Shift+L");
      const dialog = page.getByRole("dialog", { name: "label" });
      const input = dialog.getByRole("combobox", { name: "changes" });
      const recent = dialog.getByRole("listbox", { name: "recent labels" });
      await expect(recent).toHaveCount(0); // not on focus
      await input.press("ArrowDown");
      await expect(recent.getByRole("option")).toHaveText([/^env=prod/, /^tier=front/]);
      // typing ranks them; the real match is preselected and ⏎ takes it (the dialog stays)
      await page.keyboard.type("ti");
      await expect(recent.getByRole("option", { selected: true })).toHaveText(/^tier=front/);
      await input.press("Enter");
      await expect(input).toHaveValue("tier=front ");
      await expect(recent).toHaveCount(0);
      // a key already in the text isn't offered again
      await input.press("ArrowDown");
      await expect(recent.getByRole("option")).toHaveText([/^env=prod/]);
      await input.press("Enter");
      await expect(input).toHaveValue("tier=front env=prod ");
      await input.press("Enter");
      await expect(page.getByLabel("message")).toHaveText("labeled e2e-meta/web");
      await expect.poll(async () => {
        const y = await yamlOf(page, "m-web");
        return y.includes("env: prod") && y.includes("tier: front");
      }).toBe(true);

      // again: what web has now is said; ✕ forgets one, Esc closes the list before the dialog
      await page.keyboard.press("Shift+L");
      await input.press("ArrowDown");
      await expect(recent.getByRole("option", { name: /^env=prod/ })).toContainText("already set");
      await recent.getByRole("button", { name: "remove tier=front" }).click();
      await expect(recent.getByRole("option")).toHaveText([/^env=prod/]);
      await expect(input).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(recent).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    });

    test("s scales from the row menu's count; the dev context confirms with from and to", async ({ page }) => {
      await openMeta(page, "tape-dev");
      await select(page, "m-web");
      await page.keyboard.press("ControlOrMeta+Enter");
      await page.getByRole("menuitem", { name: /scale… \(3\)/ }).click();
      const dialog = page.getByRole("dialog", { name: "scale" });
      const input = dialog.getByRole("textbox", { name: "replicas" });
      await expect(input).toHaveValue("3");
      await page.keyboard.type("x"); // the prefilled count is selected: typing replaces it
      await input.press("Enter");
      await expect(dialog.getByRole("alert")).toHaveText(`"x" isn't a number of replicas (0 or more)`);
      await input.fill("0");
      await input.press("Enter");
      const confirm = page.getByRole("alertdialog", { name: "confirm scale" });
      await expect(confirm).toContainText("scale e2e-meta/web -n meta on tape-dev to 0 (from 3)");
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("message")).toHaveText("scaled e2e-meta/web to 0");
      await expect.poll(async () => (await yamlOf(page, "m-web")).includes("replicas: 0")).toBe(true);
    });

    test("r restarts after a confirmation (always, as delete); a config-less context too", async ({ page }) => {
      // restart only patches the pod template: api's labels and annotations (the tests above) are untouched
      await openMeta(page);
      await select(page, "m-api");
      await page.keyboard.press("r");
      const confirm = page.getByRole("alertdialog", { name: "confirm restart" });
      await expect(confirm).toContainText("restart e2e-meta/api -n meta on tape");
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("message")).toHaveText("restarted e2e-meta/api");
      await expect.poll(async () => (await yamlOf(page, "m-api")).includes("kubectl.kubernetes.io/restartedAt:")).toBe(true);
      // esc on the confirmation restarts nothing
      await page.keyboard.press("r");
      await expect(confirm).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(confirm).toHaveCount(0);
      expect((await inspect(page)).focus).toBe("table");
    });

    test("read-only context refuses all three without a dialog; the row menu says why", async ({ page }) => {
      await openMeta(page, "tape-prod");
      await select(page, "m-web");
      for (const key of ["Shift+L", "Shift+A", "s", "r"]) {
        await page.keyboard.press(key);
        await expect(page.getByLabel("message")).toContainText("read-only context");
        expect((await inspect(page)).overlays).toEqual([]);
      }
      await page.keyboard.press("ControlOrMeta+Enter");
      await expect(page.getByRole("menuitem", { name: /^label…/ })).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByRole("menuitem", { name: /^scale…/ })).toContainText("read-only context");
      await expect(page.getByRole("menuitem", { name: /^rollout restart…/ })).toContainText("read-only context");
    });
  });

  test("read-only context: exec refused; describe still works", async ({ page }) => {
    await openStatic(page, "tape-prod");
    await select(page, "s-web-1");
    await page.keyboard.press("x");
    await expect(page.getByLabel("message")).toContainText("read-only context");
    expect(Object.values((await inspect(page)).panes).some((p) => (p as { term?: unknown }).term)).toBe(false);
    await page.keyboard.press("d");
    await expect(page.getByRole("region", { name: "object detail" }).locator(".view-lines")).toContainText("Name:         web-1");
  });
  test.describe("edit", () => {
    const dialog = (page: Page) => page.getByRole("region", { name: "edit object" });
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
      // in the pane, over its table: no dialog, the pane marked as having unsaved changes
      expect((await inspect(page)).overlays).toEqual([]);
      expect(Object.values((await inspect(page)).objects)).toEqual([expect.objectContaining({ editing: true, split: false })]);
      await expect(page.getByLabel("unsaved changes")).toBeVisible();
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
      await expect(page.getByRole("region", { name: "object detail" }).locator(".view-lines")).toContainText("mode: green");
      // e from the YAML view edits the version just written
      await page.keyboard.press("e");
      await expect(dialog(page).locator("[data-editor=yaml] .view-lines")).toContainText("mode: green");
      await expect(dialog(page).locator("[data-editor=yaml] .view-lines")).toContainText('resourceVersion: "8"');
      // nothing changed: esc closes at once, back to the YAML it was opened from
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
      expect(await viewing(page)).toBe(true);
      await page.keyboard.press("Escape");
      expect((await inspect(page)).objects).toEqual({});
    });

    test("e from the YAML keeps the cursor's line, at the same height; back from the preview, the editor is where it was", async ({ page }) => {
      await openStatic(page);
      await select(page, "s-settings");
      await page.keyboard.press("Enter");
      const yaml = page.getByRole("region", { name: "object detail" });
      await yaml.locator(".view-line", { hasText: "stage:" }).click();
      const line = (await inspect(page)).cursor;
      expect(line).toBeGreaterThan(0);
      const shown = yaml.locator(".view-line", { hasText: "stage:" });
      await expect(shown).toBeVisible();
      const y = (await shown.boundingBox())!.y;
      await page.keyboard.press("e");
      const editor = dialog(page).locator("[data-editor=yaml]");
      await expect(editor.locator(".view-lines")).toContainText("stage:");
      await expect.poll(async () => (await inspect(page)).editCursor).toBe(line);
      // polled: Monaco re-renders its lines while revealing the cursor's, a line between two renders has no box (null)
      const stage = editor.locator(".view-line", { hasText: "stage:" });
      await expect.poll(async () => Math.abs(((await stage.boundingBox())?.y ?? Infinity) - y)).toBeLessThan(4);
      // typed on another line, previewed (not written: replicas is never sent, see below), back: the cursor is on that line still
      await retype(page, 'replicas: "3"', 'replicas: "5"');
      const typed = (await inspect(page)).editCursor;
      expect(typed).not.toBe(line);
      await page.keyboard.press("ControlOrMeta+S");
      await expect(dialog(page)).toContainText("preview (server dry run");
      await page.keyboard.press("Escape");
      await expect(editor.locator(".view-lines")).toContainText('replicas: "5"');
      await expect.poll(async () => (await inspect(page)).editCursor).toBe(typed);
    });

    test("⇧E edits in a split to the right; the table stays; esc closes it", async ({ page }) => {
      await openStatic(page);
      await select(page, "s-settings");
      const table = (await inspect(page)).focusedPane;
      await page.keyboard.press("Shift+E");
      await expect(dialog(page)).toContainText("ConfigMap settings");
      const s = await inspect(page);
      expect(s.focusedPane).not.toBe(table);
      expect(s.focus).toBe("edit");
      expect(s.objects[s.focusedPane]).toMatchObject({ split: true, editing: true, from: table });
      expect(s.objects[table]).toBeUndefined();
      // nothing changed: esc closes the split at once (as e's editor goes back to the table), not to its YAML
      await page.keyboard.press("Escape");
      await expect.poll(async () => (await inspect(page)).focusedPane).toBe(table);
      expect((await inspect(page)).objects).toEqual({});
    });

    test("an unsaved edit asks before its pane or tab closes", async ({ page }) => {
      await openStatic(page);
      await select(page, "s-settings");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.press("e");
      // replicas: no other test writes it (one backend serves the whole run), and it's never sent
      await retype(page, 'replicas: "3"', 'replicas: "4"');
      const split = (await inspect(page)).focusedPane;
      // left behind (the table focused, ⌘⌥←: the editor is modal, ⌘W there is nothing), the pane says it holds changes
      await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
      await expect.poll(async () => (await inspect(page)).focus).toBe("table");
      await expect(page.locator(`section[data-pane="${split}"]`).getByLabel("unsaved changes")).toBeVisible();
      // ⌘W on the tab asks, for the edit in a pane not in use
      await page.keyboard.press("ControlOrMeta+W");
      const tab = page.getByRole("alertdialog", { name: "confirm close tab" });
      await expect(tab).toContainText("An edit not applied yet would be lost.");
      await page.keyboard.press("Escape");
      await expect(tab).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+Alt+ArrowRight");
      await expect.poll(async () => (await inspect(page)).focus).toBe("edit");
      // closing just the pane (the native menu's Close Pane: the editor keeps ⌃D as text) asks
      await page.evaluate(() => (window as unknown as { __kw: { dispatch(c: string): void } }).__kw.dispatch("pane.close"));
      const pane = page.getByRole("alertdialog", { name: "confirm close pane" });
      await expect(pane).toContainText("Its edit isn't applied yet");
      await page.keyboard.press("Escape");
      expect((await inspect(page)).objects[split]).toMatchObject({ editing: true });
      await page.evaluate(() => (window as unknown as { __kw: { dispatch(c: string): void } }).__kw.dispatch("pane.close"));
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await inspect(page)).objects[split]).toBeUndefined();
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
      // the context's label in the pane's header, its color around the pane
      await expect(page.locator(`section[data-pane="${(await inspect(page)).focusedPane}"] header:visible`).getByLabel("context label")).toHaveText("DEV");
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
      await expect(page.getByRole("menu").getByRole("menuitem", { name: /edit YAML/ })).toContainText("read-only context");
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

test.describe("blame (b)", () => {
  async function openBlame(page: Page) {
    await openTape(page, "e2e-blame", 2);
  }
  async function select(page: Page, key: string) {
    const rows = (await focused(page)).rows;
    await page.keyboard.press("g");
    for (let i = 0; i < rows.findIndex((r) => r.key === key); i++) await page.keyboard.press("j");
  }
  /** The gutter's label of the line with text (the line numbers' column, in the same order as the lines). */
  async function labelOf(page: Page, scope: string, text: string) {
    return page.locator(scope).evaluate((el, t) => {
      const lines = [...el.querySelectorAll(".view-line")] as HTMLElement[];
      const nums = [...el.querySelectorAll(".margin-view-overlays .line-numbers")] as HTMLElement[];
      const top = (e: HTMLElement) => parseFloat(e.parentElement!.style.top || e.style.top || "0");
      const line = lines.find((l) => l.textContent?.replace(/\u00a0/g, " ").trim() === t);
      if (!line) return undefined;
      return nums.find((n) => top(n) === top(line))?.textContent ?? "";
    }, text);
  }

  test("b names each line's field manager beside the YAML, for the session; ⌘B in the editor follows the text as typed", async ({ page }) => {
    await openBlame(page);
    await select(page, "b-web");
    await page.keyboard.press("Enter");
    const yaml = '[data-viewer="single"]';
    await expect(page.locator(yaml).locator(".view-lines")).toContainText("replicas: 3");
    // off: line numbers
    await expect.poll(() => labelOf(page, yaml, "replicas: 3")).toMatch(/^\d+$/);
    await page.keyboard.press("b");
    await expect(page.getByRole("status", { name: "blame" })).toHaveText("blame");
    await expect.poll(() => labelOf(page, yaml, "replicas: 3")).toMatch(/^autoscaler \d+d$/);
    expect(await labelOf(page, yaml, "name: proxy")).toMatch(/^sidecar-injector /);
    expect(await labelOf(page, yaml, "readyReplicas: 3")).toMatch(/^kube-controller-manager /);
    // a line nobody owns as a whole: blank
    expect(await labelOf(page, yaml, "spec:")).toBe("");
    // the gutter is read-only: dimmed, not text
    await expect(page.locator(yaml).locator(".monaco-editor.kw-blame")).toHaveCount(1);

    // the session's: on for the next object too, which has no managedFields
    await page.keyboard.press("Escape");
    await select(page, "b-bare");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status", { name: "blame" })).toHaveText("blame: no managedFields on this object");
    await page.keyboard.press("Escape");

    // the editor: ⌘B (b is text); an edited value keeps its owner until applied, a new line has none
    await select(page, "b-web");
    await page.keyboard.press("e");
    const ed = "[data-editor=yaml]";
    await expect(page.getByRole("region", { name: "edit object" }).getByRole("status", { name: "blame" })).toBeVisible();
    await expect.poll(() => labelOf(page, ed, "replicas: 3")).toMatch(/^autoscaler /);
    await page.keyboard.press("ControlOrMeta+B");
    await expect.poll(() => labelOf(page, ed, "replicas: 3")).toMatch(/^\d+$/);
    await page.keyboard.press("ControlOrMeta+B");
    await expect.poll(() => labelOf(page, ed, "replicas: 3")).toMatch(/^autoscaler /);
    // typing a line moves the owners below it with their lines: a new line after spec.replicas
    // (the first: hasText is case-blind, status.readyReplicas matches too)
    await page.locator(ed).locator(".view-line", { hasText: "replicas: 3" }).first().click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("paused: true");
    await expect(page.locator(ed).locator(".view-lines")).toContainText("paused: true");
    await expect.poll(() => labelOf(page, ed, "paused: true")).toBe("");
    await expect.poll(() => labelOf(page, ed, "replicas: 3")).toMatch(/^autoscaler /);
    // YAML that doesn't parse (mid-typing): no owners rather than ones on the wrong lines, and why
    const note = page.getByRole("region", { name: "edit object" }).getByRole("status", { name: "blame" });
    await page.keyboard.type(": x");
    await expect(note).toContainText("blame: yaml:");
    await expect.poll(() => labelOf(page, ed, "replicas: 3")).toBe("");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(note).toHaveText("blame");
    await expect.poll(() => labelOf(page, ed, "replicas: 3")).toMatch(/^autoscaler /);
    // applied: the field is kubewing's
    await page.keyboard.press("ControlOrMeta+S");
    await expect(page.getByRole("region", { name: "edit object" })).toContainText("preview (server dry run");
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("message")).toHaveText("edited e2e-blame/web");
    await page.keyboard.press("Enter");
    await expect(page.locator(yaml).locator(".view-lines")).toContainText("paused: true");
    await expect.poll(() => labelOf(page, yaml, "paused: true")).toMatch(/^kubewing \d+s$/);
    // off again for what follows
    await page.keyboard.press("b");
    await expect(page.getByRole("status", { name: "blame" })).toHaveCount(0);
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
        - menuitem "view YAML ⏎ · ⇧⏎ split"
        - menuitem "edit YAML e · ⇧E split"
        - menuitem "describe d · ⇧D split"
        - menuitem "diff last change · no change seen yet" [disabled]
        - menuitem "copy name"
        - menuitem "copy cell(s)… ⌘⇧C"
        - menuitem "jump to… ⌘J"
        - separator
        - menuitem "exec shell x"
        - menuitem "debug container… b"
        - menuitem "node shell… n"
        - menuitem "port-forward… f"
        - menuitem /^logs…/
        - separator
        - menuitem "label… ⇧L"
        - menuitem "annotate… ⇧A"
        - menuitem /^scale…/
        - menuitem /^rollout restart…/
        - separator
        - menuitem "delete… ⌘⌫"
    `);
    expect((await inspect(page)).focus).toBe("menu");
    // j/k skip the disabled diff entry: edit YAML → describe → copy name → describe
    await page.keyboard.press("j");
    await expect(menu(page).locator("[data-active]")).toContainText("edit YAML");
    await page.keyboard.press("j");
    await expect(menu(page).locator("[data-active]")).toContainText("describe");
    await page.keyboard.press("j");
    await expect(menu(page).locator("[data-active]")).toContainText("copy name");
    await page.keyboard.press("k");
    await expect(menu(page).locator("[data-active]")).toContainText("describe");
    // the highlight wraps around: ↑ from the first entry to the last, ↓ from there to the first
    for (let i = 0; i < 2; i++) await page.keyboard.press("k");
    await expect(menu(page).locator("[data-active]")).toContainText("view YAML");
    await page.keyboard.press("ArrowUp");
    await expect(menu(page).locator("[data-active]")).toContainText("delete…");
    await page.keyboard.press("ArrowDown");
    await expect(menu(page).locator("[data-active]")).toContainText("view YAML");
    for (let i = 0; i < 2; i++) await page.keyboard.press("j");
    await expect(menu(page).locator("[data-active]")).toContainText("describe");
    await page.keyboard.press("Enter");
    await expect(menu(page)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "object detail" }).locator(".view-lines")).toContainText("Name:         web-1");
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
    // find where "edit YAML" (2nd entry) appears, then park the pointer there
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
    await expect.poll(active).toContain("edit YAML");
  });

  test("⌘⏎ flips the menu above the row when there's no room below", async ({ page }) => {
    await openSettled(page);
    // stack a split below so the table's last row sits low in the window, with room above it (for the whole menu)
    await page.setViewportSize({ width: 1400, height: 700 });
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
    // the rows fit the host's content box: none is clipped at the bottom (the prompt line)
    const overflow = await page.locator("[data-terminal]").evaluate((host) => {
      const screen = host.querySelector(".xterm-screen")!.getBoundingClientRect();
      return screen.bottom - (host.getBoundingClientRect().bottom - parseFloat(getComputedStyle(host).paddingBottom));
    });
    expect(overflow).toBeLessThanOrEqual(0.5);
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
    await expect(page.getByRole("region", { name: "object detail" }).locator(".view-lines")).toContainText("name: web-1");
  });

  test("⌘⇧C copies a cell of the row; right-click highlights the cell clicked; the whole row (first) is tab-separated; j/k wrap around", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    await openStatic(page);
    await select(page, "s-web-1");
    const { columns: cols, rows } = await focused(page);
    const idx = rows.findIndex((r) => r.key === "s-web-1");
    const name = cols.indexOf("NAME");
    await page.keyboard.press("ControlOrMeta+Shift+C");
    const picker = page.getByRole("menu", { name: "copy cells" });
    await expect(picker).toContainText("copy cell(s)");
    await expect(picker.getByRole("menuitem")).toHaveText([/^whole row\s*tab-separated/, ...cols.map((c) => new RegExp(`^${c}`))]);
    expect((await inspect(page)).focus).toBe("menu");
    // nothing copied last: the whole row
    await expect(picker.locator("[data-active]")).toContainText("whole row");
    for (let i = 0; i <= name; i++) await page.keyboard.press("j");
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

    // right-click on the first cell (NAMESPACE): "copy cell(s)…" in the menu highlights it, at the menu's place
    const box = (await page.locator("section[data-pane] canvas").first().boundingBox())!;
    await page.mouse.click(box.x + 30, box.y + 24 + idx * 22 + 11, { button: "right" });
    await menu(page).getByRole("menuitem", { name: /copy cell/ }).click();
    await expect(page.getByRole("menu")).toHaveCount(1); // the picker replaced the menu
    await expect(picker.locator("[data-active]")).toContainText(cols[0]!);
    const pb = (await picker.boundingBox())!;
    expect(Math.abs(pb.x - (box.x + 30))).toBeLessThan(4);

    // up from the top entry wraps to the last column, down from there back to the top
    await page.keyboard.press("k");
    await expect(picker.locator("[data-active]")).toContainText("whole row");
    await page.keyboard.press("k");
    await expect(picker.locator("[data-active]")).toContainText(cols[cols.length - 1]!);
    await page.keyboard.press("j");
    await expect(picker.locator("[data-active]")).toContainText("whole row");

    // the whole row: every cell, tab-separated
    await page.keyboard.press("Enter");
    await expect.poll(clipboard).toBe(rows[idx]!.cells.join("\t"));
    await expect(page.getByRole("status", { name: "pane status" })).toContainText("copied the whole row");
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
        - menuitem "everything in shop"
        - separator "owners"
        - menuitem "replicaset web-7d9f controller"
        - menuitem "↑ deployment web controller"
        - separator "owned"
        - menuitem "scan for owned… in shop"
        - separator "references"
        - menuitem "node node-2"
        - separator "events"
        - menuitem "events 2"
    `);
    // each entry's resource type stands out from its name (like the resource in a pane's header)
    await expect(jump(page).locator('[data-part="type"]')).toHaveText(["rel-pods", "namespace", "everything", "replicaset", "deployment", "node", "events"]);
    await expect(jump(page).locator('[data-part="type"]').first()).toHaveClass(/text-accent/);
    expect((await inspect(page)).focus).toBe("menu");
    // the highlight starts on the direct owner; j steps up the chain
    await expect(jump(page).locator("[data-active]")).toContainText("replicaset web-7d9f");
    await page.keyboard.press("j");
    await expect(jump(page).locator("[data-active]")).toContainText("deployment web");
    // it wraps around: past the last entry to the first, and back up
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
    await expect(jump(page).locator("[data-active]")).toContainText("events");
    await page.keyboard.press("ArrowDown");
    await expect(jump(page).locator("[data-active]")).toContainText("rel-pods in shop");
    await page.keyboard.press("ArrowUp");
    await expect(jump(page).locator("[data-active]")).toContainText("events");
    for (let i = 0; i < 3; i++) await page.keyboard.press("k");
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
    // events start by Last Seen, the latest first: the pane's own sort
    expect((await focused(page)).spec.sort).toBe("LAST SEEN");
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

    // from the object view, and the jump menu's events entry: the same jump
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "object detail" })).toBeVisible();
    await page.keyboard.press("v");
    await expect(page.getByRole("region", { name: "object detail" })).toHaveCount(0);
    await expect.poll(shown).toBe("rel-events shop re-1,re-2");
    // as in a browser: ⌘← goes back to the object the jump started from, Esc there to the table (⌘← is the line's start in the YAML)
    await leads(page, "back", "rel-pods");
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect(page.getByRole("region", { name: "object detail" })).toBeVisible();
    await expect(page.getByRole("region", { name: "object detail" }).locator(".view-lines")).toContainText("name: web-7d9f-b");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "object detail" })).toHaveCount(0);
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
    await page.keyboard.press("Enter");
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
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");
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
    await expect(jump(page).getByRole("menuitem", { name: /scan done/ })).toContainText("scanned 14 types");
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
        - menuitem "everything in shop"
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
    // in volume order (the ephemeral volume's claim too), each claim followed by its volume; then what the field
    // rules find (in the YAML's order: env, node, service account, volumes), each object once, a missing one disabled
    await expect(jump(page)).toMatchAriaSnapshot(`
      - menu "jump from gizmo-0":
        - text: jump from pod gizmo-0 · shop ⏎ here · ⇧⏎ split
        - separator "namespace"
        - menuitem "rel-pods in shop"
        - menuitem "namespace object shop"
        - menuitem "everything in shop"
        - separator "owners"
        - menuitem "widget gizmo controller"
        - separator "owned"
        - menuitem "scan for owned… in shop"
        - separator "references"
        - menuitem "persistentvolumeclaim data-0"
        - menuitem "persistentvolume pv-data-0"
        - menuitem "persistentvolumeclaim gizmo-0-scratch"
        - menuitem "persistentvolume pv-scratch"
        - menuitem "persistentvolumeclaim cache · missing" [disabled]
        - menuitem "rel-volumeattachments 3"
        - menuitem "secret db 2×"
        - menuitem "secret gizmo-token · missing" [disabled]
        - menuitem "node node-2"
        - menuitem "serviceaccount gizmo"
        - menuitem "configmap gizmo-config"
        - menuitem "secret gizmo-tls"
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

  test("from a pod's YAML: ⌘J lists the references at the cursor first; ⌘-click jumps; the editor jumps into a split", async ({ page }) => {
    // Monaco renders the lines on screen only: tall enough for the whole pod
    await page.setViewportSize({ width: 1400, height: 1400 });
    await openRel(page, "rel-pods", 6);
    await select(page, "rp-gizmo-0");
    await page.keyboard.press("Enter");
    const yaml = page.getByRole("region", { name: "object detail" });
    await expect(yaml.locator(".view-lines")).toContainText("secretName: gizmo-tls");
    // the reference values are marked
    await expect(yaml.locator(".kw-ref", { hasText: "gizmo-tls" })).toBeVisible();
    await expect(yaml.locator(".kw-ref", { hasText: "gizmo-config" })).toBeVisible();

    // on the value: that secret, highlighted, above the rest of the menu
    await yaml.locator(".view-line", { hasText: "secretName: gizmo-tls" }).click();
    await page.keyboard.press("ControlOrMeta+J");
    await expect(jump(page).getByRole("separator").first()).toHaveAccessibleName("at the cursor");
    // anchored at the cursor: just below its line, or (no room below) just above it
    const atCursor = async (line: { y: number; height: number }) => {
      const m = (await jump(page).boundingBox())!;
      return Math.min(Math.abs(m.y - (line.y + line.height)), Math.abs(m.y + m.height - (line.y + line.height))) < 4;
    };
    expect(await atCursor((await yaml.locator(".view-line", { hasText: "secretName: gizmo-tls" }).boundingBox())!)).toBe(true);
    await expect(jump(page).locator("[data-active]")).toContainText("secret gizmo-tls");
    await page.keyboard.press("Escape");

    // on the container: its env's secrets (db once, for two fields; the missing one disabled)
    await yaml.locator(".view-line", { hasText: "- env:" }).click();
    await page.keyboard.press("ControlOrMeta+J");
    // (the menu's references section has them too, further down: the field section is first)
    await expect(jump(page).getByRole("menuitem", { name: "secret db 2×" }).first()).toHaveAttribute("data-active", "true");
    await expect(jump(page).getByRole("menuitem", { name: /^secret gizmo-token/ }).first()).toBeDisabled();
    await expect(jump(page).locator("[data-active]")).toContainText("secret db");
    // ⏎: the secret in place; ⌘← back to the pod's YAML
    await page.keyboard.press("Enter");
    const shown = async () => {
      const p = await focused(page);
      return p.status?.synced ? `${p.spec.resource} ${(p.spec as { namespace?: string }).namespace ?? ""} ${p.rows.map((r) => r.key).sort()}` : "";
    };
    await expect.poll(shown).toBe("rel-secrets shop rs-db");
    await expect(page.getByLabel("cel")).toHaveValue('o.metadata.name == "db"');
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect(yaml.locator(".view-lines")).toContainText("secretName: gizmo-tls");

    // ⌘-click on a marked value goes straight there; ⇧⌘-click into a split
    await yaml.locator(".view-line", { hasText: "serviceAccountName: gizmo" }).locator(".kw-ref").click({ modifiers: ["ControlOrMeta"] });
    await expect.poll(shown).toBe("rel-serviceaccounts shop rsa-gizmo");
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect(yaml.locator(".kw-ref", { hasText: "node-2" })).toBeVisible();
    const panes = page.locator("section[data-pane]");
    await expect(panes).toHaveCount(1);
    await yaml.locator(".kw-ref", { hasText: "node-2" }).click({ modifiers: ["ControlOrMeta", "Shift"] });
    await expect.poll(shown).toBe("rel-nodes  rnd-2");
    await expect(panes).toHaveCount(2);
    await page.keyboard.press("Control+D"); // closes the split (⌘W would ask: the tab has two panes)
    await expect(panes).toHaveCount(1);

    // in the editor, on the text as typed: ⌘J's entries open in a split (the edit stays)
    await expect(yaml.locator(".view-lines")).toContainText("secretName: gizmo-tls");
    await page.keyboard.press("e");
    const editor = page.getByRole("region", { name: "edit object" });
    await expect(editor.locator(".view-lines")).toContainText("secretName: gizmo-tls");
    await editor.locator(".view-line", { hasText: "configMap:" }).click();
    await page.keyboard.press("ControlOrMeta+J");
    // in the editor too
    expect(await atCursor((await editor.locator(".view-line", { hasText: "configMap:" }).boundingBox())!)).toBe(true);
    await expect(jump(page).locator("[data-active]")).toContainText("configmap gizmo-config");
    await page.keyboard.press("Enter");
    await expect.poll(shown).toBe("rel-configmaps shop rc-gizmo-config");
    // the editor is still there, the split to its right
    await expect(panes).toHaveCount(2);
    await expect(editor).toBeVisible();
    const [left, right] = [(await panes.nth(0).boundingBox())!, (await panes.nth(1).boundingBox())!];
    expect(right.x).toBeGreaterThan(left.x);
    expect(Math.abs(right.y - left.y)).toBeLessThan(2);
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
        - menuitem "everything in shop"
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

  test("everything in a namespace: ⌘O all (needs a namespace), rows of every type with their own actions, ⌘R lists again", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    const dialog = page.getByRole("dialog", { name: "open source" });
    await page.getByRole("combobox", { name: "resource" }).fill("all");
    await expect(page.getByRole("listbox", { name: "resource suggestions" }).getByRole("option").first()).toContainText("every namespaced type");
    await page.getByRole("combobox", { name: "namespace" }).fill("");
    await page.getByRole("combobox", { name: "resource" }).focus();
    await page.keyboard.press("Enter");
    // all namespaces would be every type cluster-wide: refused, the dialog stays
    await expect(dialog).toContainText("namespace (required");
    await page.getByRole("combobox", { name: "namespace" }).fill("shop");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    // the relation tapes in shop, events left out
    await expect.poll(async () => {
      const p = await focused(page);
      return p.spec.resource === "all" && p.status?.synced ? p.total : -1;
    }).toBe(32);
    const p = await focused(page);
    expect(p.columns).toEqual(["KIND", "NAME", "OWNER", "AGE", "DELETING", "FINALIZERS"]);
    expect(p.spec.sort).toBe("KIND");
    const gizmo = p.rows.find((r) => r.cells[0] === "Pod" && r.cells[1] === "gizmo-0")!;
    expect(gizmo.cells[2]).toBe("Widget/gizmo");
    expect(p.rows.filter((r) => r.cells[0] === "Event")).toEqual([]);
    const status = page.getByRole("status", { name: "pane status" });
    await expect(status.getByRole("button", { name: "refresh listing" })).toContainText(/listed \d+s ago/);
    await expect(status.getByRole("button", { name: "auto refresh" })).toHaveText("auto refresh off");

    // a pod row is a pod: its jump menu has its references (from its spec, read in full)
    await select(page, gizmo.key);
    await page.keyboard.press("ControlOrMeta+J");
    await expect(jump(page).getByRole("menuitem", { name: "secret db 2×" })).toBeVisible();
    await expect(jump(page).getByRole("menuitem", { name: "everything in shop" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // its YAML is the whole object, not the listed metadata
    await page.keyboard.press("Enter");
    await expect(page.locator(".monaco-editor").first()).toContainText("secretKeyRef");
    await page.keyboard.press("Escape");

    // ⌘R lists again
    await page.keyboard.press("ControlOrMeta+R");
    await expect(status.getByRole("button", { name: "refresh listing" })).toContainText(/listed [0-2]s ago/);
    expect((await focused(page)).total).toBe(32);
    // a live pane says it needs none
    await openRel(page, "rel-pods", 6);
    await page.keyboard.press("ControlOrMeta+R");
    await expect(status.getByLabel("message")).toContainText("this pane is live");
  });

  test("a namespace, and any row in one, jump to everything in it", async ({ page }) => {
    await openRel(page, "rel-namespaces", 2);
    await select(page, "rn-shop");
    await page.keyboard.press("ControlOrMeta+J");
    await jump(page).getByRole("menuitem", { name: "everything in shop" }).click();
    await expect.poll(async () => {
      const p = await focused(page);
      return p.status?.synced ? `${p.spec.resource} ${(p.spec as { namespace?: string }).namespace} ${p.total}` : "";
    }).toBe("all shop 32");
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect.poll(async () => (await focused(page)).spec.resource).toBe("rel-namespaces");
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

// Multi-pod log tail (l): the e2e-pod-logs tape has pods api-0, api-1, worker-0
// (worker excluded by app=api), a later api-2 and a deleted api-1. Each pod's
// lines carry its name; a selector pane filters pods, the live filter filters
// lines.
test.describe("port-forward to a service", () => {
  async function select(page: Page, key: string) {
    const rows = (await focused(page)).rows;
    await page.keyboard.press("g");
    for (let i = 0; i < rows.findIndex((r) => r.key === key); i++) await page.keyboard.press("j");
    await expect.poll(async () => (await focused(page)).rows[(await focused(page)).selected]?.key).toBe(key);
  }

  test("f on a service offers its ports with their targets, forwards to its ready pod; refused without a selector", async ({ page }) => {
    await openTape(page, "rel-services", 4);
    await select(page, "rs-web");
    await page.keyboard.press("f");
    const dialog = page.getByRole("dialog", { name: "port-forward" });
    await expect(dialog).toContainText("port-forward svc/web");
    await expect(dialog).toContainText("service ports");
    const declared = dialog.getByRole("listbox", { name: "declared ports" });
    // service ports; 80 goes to the pods' named port http
    await expect(declared.getByRole("option")).toHaveText(["80http · TCP · → http", "9090metrics · TCP"]);
    await page.keyboard.press("Enter"); // 80, a local port above 8000
    await expect(dialog.getByRole("combobox", { name: "ports" })).toHaveValue("8080:80 ");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    // the ready pod of the selector (web-7d9f-a, not web-7d9f-b), on its container port
    await expect(page.getByLabel("message")).toContainText("127.0.0.1:8080 → svc 80 → 8080");
    await page.keyboard.press("ControlOrMeta+Alt+P");
    const list = page.getByRole("listbox", { name: "active port-forwards" });
    await expect(list.getByRole("option")).toHaveCount(1);
    await expect(list.getByRole("option").first()).toContainText("shop/svc/web → web-7d9f-a");
    await page.keyboard.press("Escape");

    // f again: the running forward is the service's, 80 isn't offered any more
    await page.keyboard.press("f");
    const running = dialog.getByRole("listbox", { name: "running port-forwards" });
    await expect(running.getByRole("option")).toHaveText([/^127\.0\.0\.1:8080 → svc 80 → 8080pod web-7d9f-a✕$/]);
    await expect(dialog.getByRole("combobox", { name: "ports" })).toHaveValue("9090:9090"); // the one left: prefilled
    await page.keyboard.press("Escape");

    // no selector: no pods to forward to, said in the dialog
    await select(page, "rs-external");
    await page.keyboard.press("f");
    await expect(dialog.getByRole("combobox", { name: "ports" })).toHaveValue("8443:443");
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText("service external has no selector");
    await page.keyboard.press("Escape");

    await page.keyboard.press("ControlOrMeta+Alt+P");
    await page.keyboard.press("x");
    await expect(page.getByLabel("active port-forwards")).toHaveCount(0);
  });
});

/** Drags over the first rendered row of an xterm (a terminal's or a log pane's), left edge to right. */
async function dragFirstRow(page: Page, host: string) {
  const b = (await page.locator(`${host} .xterm-rows > div`).first().boundingBox())!;
  await page.mouse.move(b.x + 1, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
}

/** Sets config.yaml terminal.copyOnSelect in the loaded config, as a settings reload would. */
const setCopyOnSelect = (page: Page, on: boolean) =>
  page.evaluate((on) => {
    const c = (window as unknown as { __kw: { config: { setState(f: (s: { config?: { config: { terminal?: object } } }) => object): void } } }).__kw.config;
    c.setState((s) => ({ config: { ...s.config!, config: { ...s.config!.config, terminal: { ...s.config!.config.terminal, copyOnSelect: on } } } }));
  }, on);

test.describe("logs", () => {
  async function openLogs(page: Page, labelSelector = "") {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    await page.getByRole("combobox", { name: "resource" }).fill("e2e-pod-logs");
    await page.keyboard.press("Enter");
    await expect.poll(async () => {
      const p = await focused(page);
      return p.spec.resource === "e2e-pod-logs" && !!p.serverId && !!p.status?.synced;
    }).toBe(true);
    if (labelSelector) {
      await page.keyboard.press("/");
      await page.keyboard.press("Tab");
      await page.keyboard.type(labelSelector);
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await focused(page)).spec.labelSelector).toBe(labelSelector);
      // ⏎ went back to the table, so table keys (⌥L) resolve
      await expect.poll(async () => (await inspect(page)).focus).toBe("table");
    }
  }
  async function select(page: Page, key: string) {
    const rows = (await focused(page)).rows;
    await page.keyboard.press("g");
    for (let i = 0; i < rows.findIndex((r) => r.key === key); i++) await page.keyboard.press("j");
  }
  // l / ⌥L open the log dialog; ⏎ starts with its defaults once it has listed the pods
  async function tail(page: Page, key = "l") {
    await page.keyboard.press(key);
    const dialog = page.getByRole("dialog", { name: "logs" });
    await expect(dialog.getByRole("textbox", { name: "history" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
  }
  // the log pane's rendered screen, by its session id
  async function screen(page: Page) {
    const s = await inspect(page);
    const pane = Object.values(s.panes).find((p) => p.logs);
    const session = pane?.logs?.session;
    return session ? (s.logs?.[session]?.screen ?? "") : "";
  }

  test("l on a pod row tails just that pod", async ({ page }) => {
    await openLogs(page);
    await select(page, "lg-api-0");
    await tail(page);
    await expect.poll(() => inspect(page).then((s) => s.focus)).toBe("logs");
    const pane = async () => Object.values((await inspect(page)).panes).find((p) => p.logs);
    await expect.poll(async () => (await pane())?.logs?.title).toBe("api-0");
    await expect.poll(() => screen(page)).toContain("api-0 app serving request /healthz");
    // only api-0's lines, not api-1's
    expect(await screen(page)).not.toContain("api-1");
    // one pod, one container: no pod/container prefix, the lines start with their text
    expect((await screen(page)).split("\n")[0]).toBe("api-0 app starting");
  });

  test("terminal.copyOnSelect copies a mouse selection in a log pane too", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openLogs(page);
    await select(page, "lg-api-0");
    await tail(page);
    await expect.poll(() => screen(page)).toContain("api-0 app starting");
    await setCopyOnSelect(page, true);
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await dragFirstRow(page, "[data-logview]");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("api-0 app starting");
    // the pane keeps its keys
    expect((await inspect(page)).focus).toBe("logs");
    await setCopyOnSelect(page, false);
  });

  test("⌥L tails every pod the pane shows; a label selector narrows it", async ({ page }) => {
    await openLogs(page, "app=api");
    await tail(page, "Alt+l");
    await expect.poll(() => inspect(page).then((s) => s.focus)).toBe("logs");
    // api pods are followed, worker is not (filtered out by app=api)
    await expect.poll(() => screen(page)).toContain("api-0 app ready");
    await expect.poll(() => screen(page)).toContain("api-2 app ready");
    expect(await screen(page)).not.toContain("worker-0");
  });

  test("l with rows marked tails the marked pods together", async ({ page }) => {
    await openLogs(page);
    await select(page, "lg-api-0");
    await page.keyboard.press("Space");
    await select(page, "lg-worker-0");
    await page.keyboard.press("Space");
    await expect.poll(async () => (await focused(page)).status?.marked).toBe(2);
    // the cursor on api-1, which isn't marked: the marks win
    await select(page, "lg-api-1");
    await page.keyboard.press("l");
    await expect(page.getByRole("dialog", { name: "logs" })).toContainText("logs of api-0, worker-0");
    await page.keyboard.press("Escape");
    await tail(page);
    const pane = async () => Object.values((await inspect(page)).panes).find((p) => p.logs);
    await expect.poll(async () => (await pane())?.logs?.title).toBe("api-0, worker-0");
    await expect.poll(() => screen(page)).toContain("api-0 app ready");
    await expect.poll(() => screen(page)).toContain("worker-0 app processing job 1");
    expect(await screen(page)).not.toContain("api-1");
  });

  test("a pane per pod: below the pane, or in a new tab", async ({ page }) => {
    await openLogs(page);
    await select(page, "lg-api-0");
    await page.keyboard.press("Space");
    await select(page, "lg-worker-0");
    await page.keyboard.press("Space");
    await expect.poll(async () => (await focused(page)).status?.marked).toBe(2);
    const dialog = page.getByRole("dialog", { name: "logs" });
    const perPod = dialog.getByRole("checkbox", { name: "a pane per pod" });
    const newTab = dialog.getByRole("checkbox", { name: "in a new tab" });
    const logPanes = async () => Object.values((await inspect(page)).panes).filter((p) => p.logs).map((p) => p.logs!.title).sort();

    // below: one pane per pod, stacked under the table
    await page.keyboard.press("l");
    await expect(perPod).toBeEnabled();
    await expect(newTab).toBeDisabled(); // only with a pane per pod
    await perPod.check();
    await expect(newTab).toBeEnabled();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect.poll(logPanes).toEqual(["api-0", "worker-0"]);
    let s = await inspect(page);
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]!.layout).toMatchObject({ type: "split", dir: "column" });
    await expect.poll(() => inspect(page).then((x) => x.focus)).toBe("logs");

    // a new tab: logs ×2, the panes stacked
    // ⌥⌘↑ from the first log pane: back to the table, its marks still there
    await page.keyboard.press("Alt+ControlOrMeta+ArrowUp");
    await expect.poll(() => inspect(page).then((x) => x.focus)).toBe("table");
    await page.keyboard.press("l");
    await perPod.check();
    await newTab.check();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await inspect(page)).tabs.length).toBe(2);
    s = await inspect(page);
    expect(s.activeTab).toBe(1);
    const tab = s.tabs[1]!;
    expect(tab.layout).toMatchObject({ type: "split", dir: "column", children: [{ type: "pane" }, { type: "pane" }] });
  });

  test("the live filter hides non-matching lines and ! excludes", async ({ page }) => {
    await openLogs(page);
    await select(page, "lg-api-1");
    await tail(page);
    await expect.poll(() => screen(page)).toContain("api-1 app warning disk space low");
    // focus the grep field (the log pane's, now focused) and type a term
    await page.keyboard.press("/");
    await expect.poll(() => inspect(page).then((s) => s.focus)).toBe("logsfilter");
    const grep = page.locator("input:focus");
    await grep.fill("warning");
    await expect.poll(() => screen(page)).toContain("warning disk space low");
    await expect.poll(() => screen(page)).not.toContain("api-1 app ready");
    // exclude instead
    await grep.fill("!warning");
    await expect.poll(() => screen(page)).toContain("ready");
    await expect.poll(() => screen(page)).not.toContain("disk space low");
  });

  test("arrows, page up/down and home/end scroll the view; ⏎ jumps to the latest line", async ({ page }) => {
    await openLogs(page);
    await select(page, "lg-api-0");
    await tail(page);
    await expect.poll(() => inspect(page).then((s) => s.focus)).toBe("logs");
    await expect.poll(() => screen(page)).toContain("api-0 app serving request /healthz");
    // the tape has a handful of lines; push enough to scroll
    const session = Object.values((await inspect(page)).panes).find((p) => p.logs)!.logs!.session;
    const push = (from: number, n: number) =>
      page.evaluate(
        ([id, from, n]) => {
          const kw = (window as unknown as { __kw: { logBuffers: { get(id: string): { streams: { id: string }[] }; pushLines(id: string, lines: { stream: string; text: string }[]): void } } }).__kw;
          const stream = kw.logBuffers.get(id).streams[0]?.id ?? "";
          kw.logBuffers.pushLines(id, Array.from({ length: n }, (_, i) => ({ stream, text: `filler line ${from + i}` })));
        },
        [session, from, n] as const,
      );
    await push(0, 500);
    const view = async () => (await inspect(page)).logs![session]!;
    const atBottom = async () => {
      const v = await view();
      return v.viewportY + v.rows >= v.length;
    };
    await expect.poll(() => screen(page)).toContain("filler line 499");
    await expect.poll(atBottom).toBe(true); // follows the tail
    await page.keyboard.press("Home");
    await expect.poll(async () => (await view()).viewportY).toBe(0);
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await view()).viewportY).toBe(1);
    await page.keyboard.press("ArrowUp");
    await expect.poll(async () => (await view()).viewportY).toBe(0);
    await page.keyboard.press("PageDown");
    const rows = (await view()).rows;
    await expect.poll(async () => (await view()).viewportY).toBe(rows - 1);
    await page.keyboard.press("PageUp");
    await expect.poll(async () => (await view()).viewportY).toBe(0);
    // scrolled up, new lines don't yank the view
    await push(500, 50);
    await expect.poll(() => screen(page)).toContain("filler line 549");
    expect((await view()).viewportY).toBe(0);
    await page.keyboard.press("End");
    await expect.poll(atBottom).toBe(true);
    await page.keyboard.press("Home");
    await expect.poll(async () => (await view()).viewportY).toBe(0);
    // ⏎ is End: back to the latest line, and following again
    await page.keyboard.press("Enter");
    await expect.poll(atBottom).toBe(true);
    await push(550, 50);
    await expect.poll(() => screen(page)).toContain("filler line 599");
    await expect.poll(atBottom).toBe(true);
    expect((await inspect(page)).focus).toBe("logs");
  });

  test("l asks first: containers, history, follow and timestamps; esc cancels", async ({ page }) => {
    await openLogs(page);
    await select(page, "lg-api-0");
    await page.keyboard.press("l");
    const dialog = page.getByRole("dialog", { name: "logs" });
    await expect(dialog).toContainText("logs of api-0");
    // the defaults: every container, the configured tail, following, no timestamps
    await expect(dialog.getByRole("checkbox", { name: "app" })).toBeChecked();
    await expect(dialog.getByRole("textbox", { name: "history" })).toHaveValue("100");
    await expect(dialog.getByRole("checkbox", { name: "follow" })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "timestamps" })).not.toBeChecked();
    expect((await inspect(page)).focus).toBe("dialog");
    // esc: nothing starts, back to the table
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect.poll(() => inspect(page).then((s) => s.focus)).toBe("table");
    expect(Object.values((await inspect(page)).panes).some((p) => p.logs)).toBe(false);
    // a bad history is refused in the dialog
    await page.keyboard.press("l");
    const history = dialog.getByRole("textbox", { name: "history" });
    await expect(history).toBeFocused();
    await history.fill("ten minutes");
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText("a duration");
    // the last line only, timestamps on, not following: read once, the footer says so
    await history.fill("1");
    await dialog.getByRole("checkbox", { name: "follow" }).uncheck();
    await dialog.getByRole("checkbox", { name: "timestamps" }).check();
    await history.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect.poll(() => inspect(page).then((s) => s.focus)).toBe("logs");
    await expect.poll(() => screen(page)).toContain("api-0 app serving request /healthz");
    expect(await screen(page)).not.toContain("api-0 app ready");
    const pane = Object.values((await inspect(page)).panes).find((p) => p.logs)!;
    expect(pane.logs).toMatchObject({ timestamps: true, follow: false });
    const status = page.getByRole("status", { name: "logs status" });
    await expect(status).toContainText("not following");
    // the read is over: the session ends on its own
    await expect.poll(async () => Object.values((await inspect(page)).panes).find((p) => p.logs)?.logs?.exited).toBe("ended");
  });

  test("the status bar hints the t key for timestamps, and t toggles them", async ({ page }) => {
    await openLogs(page);
    await select(page, "lg-api-0");
    await tail(page);
    await expect.poll(() => inspect(page).then((s) => s.focus)).toBe("logs");
    const status = page.getByRole("status", { name: "logs status" });
    // off by default: the hint names the key that turns them on
    await expect(status).toContainText("timestamps off (t)");
    const pane = async () => Object.values((await inspect(page)).panes).find((p) => p.logs)!;
    expect((await pane()).logs!.timestamps).toBe(false);
    // t turns them on
    await page.keyboard.press("t");
    await expect(status).toContainText("timestamps on (t)");
    expect((await pane()).logs!.timestamps).toBe(true);
    // and off again
    await page.keyboard.press("t");
    await expect(status).toContainText("timestamps off (t)");
    expect((await pane()).logs!.timestamps).toBe(false);
  });

  test("⌘P in the dialog reads the previous instance's logs, read once", async ({ page }) => {
    await openLogs(page);
    await select(page, "lg-api-0");
    await page.keyboard.press("l");
    const dialog = page.getByRole("dialog", { name: "logs" });
    const history = dialog.getByRole("textbox", { name: "history" });
    await expect(history).toBeFocused();
    const previous = dialog.getByRole("checkbox", { name: "previous" });
    const follow = dialog.getByRole("checkbox", { name: "follow" });
    // off by default; ⌘P toggles it from the history field (nothing typed there), and follow goes off
    await expect(previous).not.toBeChecked();
    await page.keyboard.press("Meta+p");
    await expect(previous).toBeChecked();
    await expect(follow).not.toBeChecked();
    await expect(follow).toBeDisabled();
    await expect(history).toHaveValue("100");
    await page.keyboard.press("Meta+p");
    await expect(previous).not.toBeChecked();
    await expect(follow).toBeChecked();
    await page.keyboard.press("Meta+p");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect.poll(() => screen(page)).toContain("api-0 app out of memory");
    expect(await screen(page)).not.toContain("serving request");
    const pane = Object.values((await inspect(page)).panes).find((p) => p.logs)!;
    expect(pane.logs).toMatchObject({ follow: false, previous: true });
    await expect(page.getByRole("status", { name: "logs status" })).toContainText("previous instance");
    await expect.poll(async () => Object.values((await inspect(page)).panes).find((p) => p.logs)?.logs?.exited).toBe("ended");
    // ended: the hint names the key that closes the log pane (⌃D), not ⌘W (that closes the tab)
    await expect(page.getByText("ended · ⌃D closes")).toBeVisible();
  });

  test("a followed tail shows following in its footer", async ({ page }) => {
    await openLogs(page);
    await select(page, "lg-api-0");
    await tail(page);
    await expect.poll(() => screen(page)).toContain("api-0 app ready");
    const status = page.getByRole("status", { name: "logs status" });
    await expect(status).toContainText("following");
    await expect(status).not.toContainText("not following");
    // the footer counts the followed stream (it once kept the count from before the stream set arrived)
    await expect(status).toContainText("1 container in 1 pod");
  });

  test("closing the pane ends the session", async ({ page }) => {
    await openLogs(page);
    await select(page, "lg-api-0");
    await tail(page);
    await expect.poll(() => inspect(page).then((s) => s.focus)).toBe("logs");
    const sessionId = async () => Object.values((await inspect(page)).panes).find((p) => p.logs)?.logs?.session;
    const id = await sessionId();
    expect(id).toBeTruthy();
    // ⌃⇧D closes the focused (log) pane; its session is dropped
    await page.keyboard.press("Control+Shift+D");
    await expect.poll(async () => {
      const s = await inspect(page);
      return !Object.values(s.panes).some((p) => p.logs?.session === id);
    }).toBe(true);
  });
});

test.describe("⌘⇧O: open a cluster", () => {
  const dialog = (page: Page) => page.getByRole("dialog", { name: "open cluster" });
  const options = (page: Page) => dialog(page).getByRole("option");
  // e2e-static's object count depends on the delete tests before: synced is enough
  async function openStatic(page: Page) {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    await page.getByRole("combobox", { name: "resource" }).fill("e2e-static");
    await page.keyboard.press("Enter");
    await expect.poll(async () => {
      const p = await focused(page);
      return p.spec.resource === "e2e-static" && p.status?.synced && p.rows.length > 0;
    }).toBe(true);
  }

  test("lists gardenctl's session targets and gardens; a dashboard URL resolves to its shoot, opened in the pane and remembered", async ({ page }) => {
    await openStatic(page);
    await page.keyboard.press("ControlOrMeta+Shift+O");
    await expect(dialog(page)).toBeVisible();
    expect((await inspect(page)).overlays).toEqual(["clusters"]);
    await expect(page.getByRole("combobox", { name: "cluster" })).toBeFocused();
    // empty: the clusters panes opened on (this one: kubewing's own kubeconfig) first, then the
    // gardenctl session's target (its predicted name gets the rule's badge), then the gardens
    await expect(options(page).first()).toContainText("tape");
    await expect(options(page).first()).toContainText("just now");
    const old = options(page).filter({ hasText: /^old/ });
    await expect(old).toContainText("gardenctl");
    await expect(old).toContainText("GARDEN");
    await expect(options(page).filter({ hasText: "tape-missing" })).toHaveAttribute("aria-disabled", "true");

    await page.getByRole("combobox", { name: "cluster" }).fill("https://dashboard.tape.example/namespace/garden-foo/shoots/bar");
    // a shoot is one line: ⇥ toggles it to its control plane and back
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).nth(0)).toHaveText(/^bar.*foo · tape-garden/);
    await page.keyboard.press("Tab");
    await expect(options(page).nth(0)).toContainText("bar · control plane");
    await expect(dialog(page).getByRole("radio", { name: "control plane" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Tab");
    await expect(options(page).nth(0)).toHaveAttribute("aria-selected", "true");
    // where it opens, by key as in the ⌘J menu: ⏎ here, ⇧⏎ a split, ⌘⏎ a new tab (no toggle)
    await expect(dialog(page).getByRole("radiogroup", { name: "open in" })).toHaveCount(0);
    await expect(dialog(page).getByLabel("keys")).toHaveText("⏎ here · ⇧⏎ split · ⌘⏎ tab · esc close");
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toHaveCount(0);
    // the pane on the shoot's cluster (named <garden>/<technical id>) lists nothing yet: ⌘O is open over it
    await expect.poll(async () => (await focused(page)).spec).toMatchObject({ resource: "", context: expect.stringMatching(/^@\d+\/tape-garden\/shoot--foo--bar$/) });
    expect((await inspect(page)).overlays).toEqual(["open"]);
    const pane = page.locator(`section[data-pane="${(await inspect(page)).focusedPane}"]`);
    await expect(pane).toHaveAttribute("data-context", "tape-garden/shoot--foo--bar");
    await expect(pane.getByLabel("context label")).toHaveText("GARDEN");
    // Esc leaves it empty; its button opens ⌘O again, which lists what's picked
    await page.keyboard.press("Escape");
    expect((await inspect(page)).focus).toBe("table");
    // nothing is watched: the status line says so, no syncing
    await expect(pane.getByRole("status", { name: "pane status" })).toHaveText("nothing listed");
    await pane.getByRole("button", { name: "pick what to list" }).click();
    await page.getByRole("combobox", { name: "resource" }).fill("e2e-static");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await focused(page)).spec).toMatchObject({ resource: "e2e-static", context: expect.stringMatching(/tape-garden\/shoot--foo--bar$/) });
    // ⌥⌘O: its control plane, whose seed isn't in the test garden: the error shows in the pane, which stays
    await page.keyboard.press("ControlOrMeta+Alt+O");
    await expect(pane.getByRole("status", { name: "pane status" }).getByLabel("message")).toContainText("soil");
    await expect(pane).toHaveAttribute("data-context", "tape-garden/shoot--foo--bar");
    // ⌃T: the local terminal targets the shoot for gardenctl too (its own session)
    await page.keyboard.press("Control+T");
    await expect.poll(async () => (await inspect(page)).focus).toBe("terminal");
    await expect.poll(() => page.locator("[data-terminal] .xterm-rows").innerText()).toContain("gardenctl target: garden: tape-garden project: foo shoot: bar");
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await inspect(page)).focus).toBe("table");

    // remembered: first in the list next time, with a ✕ to forget it
    await page.keyboard.press("ControlOrMeta+Shift+O");
    await expect(options(page).first()).toContainText("bar");
    await expect(options(page).first()).toContainText("just now");
    await options(page).first().getByRole("button", { name: "forget bar" }).dispatchEvent("mousedown");
    await expect(options(page).filter({ hasText: /^bar/ })).toHaveCount(0);
    // typing ranks: a session target by its shoot's technical id
    await page.getByRole("combobox", { name: "cluster" }).fill("shoot--foo--old");
    await expect(options(page).first()).toContainText("old");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    expect((await inspect(page)).focus).toBe("table");
  });

  test("⌘⏎ a new tab, ⇧⏎ a split; errors stay in the dialog; ⌥⌘O only on what ⌘⇧O opened", async ({ page }) => {
    await openStatic(page);
    await page.keyboard.press("ControlOrMeta+Shift+O");
    const field = page.getByRole("combobox", { name: "cluster" });
    // the control plane's seed isn't in the test garden: the error shows, the dialog stays
    await field.fill("tg/shoot--foo--bar");
    await expect(options(page)).toHaveCount(1);
    await dialog(page).getByRole("radio", { name: "control plane" }).dispatchEvent("mousedown");
    await page.keyboard.press("Enter");
    await expect(dialog(page).getByRole("status", { name: "cluster status" })).toContainText("soil");
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Tab");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(dialog(page)).toHaveCount(0);
    let s = await inspect(page);
    expect(s.tabs).toHaveLength(2);
    expect(s.activeTab).toBe(1);
    expect(s.overlays).toEqual(["open"]);
    await expect.poll(async () => (await focused(page)).spec).toMatchObject({ resource: "", context: expect.stringMatching(/tape-garden\/shoot--foo--bar$/) });
    await page.keyboard.press("Escape");

    // back in the first tab: ⌥⌘O on a cluster ⌘⇧O didn't open says so
    await page.keyboard.press("ControlOrMeta+1");
    const from = (await inspect(page)).focusedPane;
    await page.keyboard.press("ControlOrMeta+Alt+O");
    await expect(page.locator(`section[data-pane="${from}"]`).getByLabel("message")).toContainText("⌘⇧O");
    // ⇧⏎: a split below the focused pane
    await page.keyboard.press("ControlOrMeta+Shift+O");
    await field.fill("tg/shoot--foo--bar");
    await expect(options(page)).toHaveCount(1);
    await page.keyboard.press("Shift+Enter");
    await expect(dialog(page)).toHaveCount(0);
    s = await inspect(page);
    expect(s.tabs).toHaveLength(2);
    expect(s.focusedPane).not.toBe(from);
    expect(s.overlays).toEqual(["open"]);
    await expect.poll(async () => (await focused(page)).spec).toMatchObject({ resource: "", context: expect.stringMatching(/tape-garden\/shoot--foo--bar$/) });
    await page.keyboard.press("Escape");
  });

  test("⌘J on a garden's shoot and seed rows: its clusters, opened here, in a split or (⌘⏎) a new tab; errors stay in the menu", async ({ page }) => {
    const jump = page.getByRole("menu", { name: /^jump from/ });
    const list = async (resource: string, n: number) => {
      await page.keyboard.press("ControlOrMeta+O");
      await page.getByRole("combobox", { name: "resource" }).fill(resource);
      await page.keyboard.press("Enter");
      await expect.poll(async () => { const p = await focused(page); return p.spec.resource === resource && p.status?.synced ? p.total : -1; }).toBe(n);
    };
    const select = async (key: string) => {
      const rows = (await focused(page)).rows;
      await page.keyboard.press("g");
      for (let i = 0; i < rows.findIndex((r) => r.key === key); i++) await page.keyboard.press("j");
    };
    await ready(page);
    // the test garden, here (a click)
    await page.keyboard.press("ControlOrMeta+Shift+O");
    await page.getByRole("combobox", { name: "cluster" }).fill("tape-garden");
    // the garden's own line (its shoots, remembered by earlier tests, match the text too)
    await options(page).filter({ hasText: /^tape-garden/ }).first().click();
    await expect(page.getByRole("combobox", { name: "resource" })).toBeVisible();
    await page.keyboard.press("Escape");
    const garden = ((await focused(page)).spec as { context?: string }).context;
    expect(garden).toMatch(/^@\d+\/tape-garden$/);
    await list("shoots", 3);

    // a shoot row: its shoot and control plane first, highlighted, with their context names
    await select("shoot-baz");
    await page.keyboard.press("ControlOrMeta+J");
    await expect(jump.getByRole("separator").first()).toHaveAccessibleName("clusters");
    await expect(jump).toContainText("⌘⏎ tab");
    await expect(jump.getByRole("menuitem").nth(0)).toHaveText(/^shoot baz.*tape-garden\/shoot--foo--baz$/);
    await expect(jump.getByRole("menuitem").nth(1)).toHaveText(/^control plane of baz/);
    await expect(jump.locator("[data-active]")).toContainText("shoot baz");
    // ⏎: the shoot here, listing nothing yet (⌘O over it); ⌘← goes back to the shoots
    await page.keyboard.press("Enter");
    await expect(jump).toHaveCount(0);
    await expect.poll(async () => (await focused(page)).spec).toMatchObject({ resource: "", context: expect.stringMatching(/^@\d+\/tape-garden\/shoot--foo--baz$/) });
    expect((await inspect(page)).overlays).toEqual(["open"]);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect.poll(async () => (await focused(page)).spec).toMatchObject({ resource: "shoots", context: garden });

    // ⇧⏎: its control plane in a split below, on the managed seed loam, in the shoot's namespace there
    await expect.poll(async () => (await focused(page)).status?.synced).toBe(true);
    await select("shoot-baz");
    const from = (await inspect(page)).focusedPane;
    await page.keyboard.press("ControlOrMeta+J");
    await expect(jump.locator("[data-active]")).toContainText("shoot baz");
    await page.keyboard.press("j");
    await expect(jump.locator("[data-active]")).toContainText("control plane of baz");
    await page.keyboard.press("Shift+Enter");
    await expect(jump).toHaveCount(0);
    let s = await inspect(page);
    expect(s.focusedPane).not.toBe(from);
    await expect.poll(async () => (await focused(page)).spec).toMatchObject({ resource: "", context: expect.stringMatching(/\/tape-garden\/seed--loam$/), namespace: "shoot--foo--baz" });
    // ⌥⌘O right away, ⌘O still open over it: the shoot, ⌘O open over that
    expect((await inspect(page)).overlays).toEqual(["open"]);
    await page.keyboard.press("ControlOrMeta+Alt+O");
    await expect.poll(async () => (await focused(page)).spec).toMatchObject({ resource: "", context: expect.stringMatching(/\/tape-garden\/shoot--foo--baz$/) });
    await expect.poll(async () => (await inspect(page)).overlays).toEqual(["open"]);
    // ⌘O is the shoot's now (not the control plane's it was opened over): what it picks lists there
    await page.getByRole("combobox", { name: "resource" }).fill("e2e-static");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await focused(page)).spec).toMatchObject({ resource: "e2e-static", namespace: "", context: expect.stringMatching(/\/tape-garden\/shoot--foo--baz$/) });
    // and back from the table
    await page.keyboard.press("ControlOrMeta+Alt+O");
    await expect.poll(async () => (await focused(page)).spec).toMatchObject({ resource: "e2e-static", context: expect.stringMatching(/\/tape-garden\/seed--loam$/), namespace: "shoot--foo--baz" });
    await page.keyboard.press("Control+D");
    await expect.poll(async () => (await inspect(page)).focusedPane).toBe(from);

    // a seed row: the seed; one that can't be resolved says why on its entry, the menu stays
    await list("seeds", 2);
    await select("seed-soil");
    await page.keyboard.press("ControlOrMeta+J");
    await expect(jump.getByRole("menuitem").nth(0)).toHaveText(/^seed soil.*tape-garden\/seed--soil$/);
    await page.keyboard.press("Enter");
    await expect(jump.getByRole("menuitem").nth(0)).toContainText("no login secret");
    await page.keyboard.press("Escape");
    // ⌘⏎: loam (a managed seed) in a new tab, all namespaces
    await select("seed-loam");
    const tabs = (await inspect(page)).tabs.length;
    await page.keyboard.press("ControlOrMeta+J");
    await expect(jump.getByRole("menuitem").nth(0)).toHaveText(/^seed loam/);
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(jump).toHaveCount(0);
    s = await inspect(page);
    expect(s.tabs).toHaveLength(tabs + 1);
    await expect.poll(async () => (await focused(page)).spec).toMatchObject({ resource: "", namespace: "", context: expect.stringMatching(/\/tape-garden\/seed--loam$/) });
    await page.keyboard.press("Escape");
    // remembered: ⌘⇧O lists the seed
    await page.keyboard.press("ControlOrMeta+Shift+O");
    await page.getByRole("combobox", { name: "cluster" }).fill("seed--loam");
    await expect(options(page).first()).toHaveText(/^seed loam.*tape-garden/);
    await page.keyboard.press("Escape");
  });
});

// e2e-batch, by name: b-del-0, b-del-1, b-pod-0, b-pod-1, b-scale-0, b-scale-1. Deletes and
// patches persist for the backend's lifetime: each test acts on its own rows.
test("without a current context, kubewing starts with ⌘⇧O open over a pane listing nothing", async ({ page }) => {
  // the backend's kubeconfig as a Dock launch without one sees it: no current context
  const opened: string[] = [];
  await page.routeWebSocket(/\/kw-ws$/, (ws) => {
    const server = ws.connectToServer();
    const contexts = new Set<number>();
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (msg.method === "Contexts") contexts.add(msg.id);
      if (msg.method === "Open") opened.push(msg.args[0]);
      server.send(m);
    });
    server.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (contexts.delete(msg.id) && msg.result) msg.result.current = "";
      ws.send(JSON.stringify(msg));
    });
  });
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "open cluster" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("combobox", { name: "cluster" })).toBeFocused();
  const s = await inspect(page);
  expect(s.overlays).toEqual(["clusters"]);
  expect(s.panes[s.focusedPane]!.spec.resource).toBe("");
  // Esc: the pane says there's no cluster, its button opens ⌘⇧O again; nothing was ever opened (no localhost:8080)
  await page.keyboard.press("Escape");
  const pane = page.locator(`section[data-pane="${s.focusedPane}"]`);
  await expect(pane.getByRole("button", { name: "pick a cluster" })).toHaveText(/no cluster yet/);
  await pane.getByRole("button", { name: "pick a cluster" }).click();
  await expect(dialog).toBeVisible();
  // a new tab starts empty too
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+T");
  await expect.poll(async () => (await inspect(page)).tabs.length).toBe(2);
  const t = await inspect(page);
  expect(t.panes[t.focusedPane]!.spec.resource).toBe("");
  expect(opened).toEqual([]);
});

test("a local cluster refusing the connection: the error hints at it, its button picks another cluster here", async ({ page }) => {
  // the first open fails as a stopped kind cluster's does (Go's dial error, as the bridge passes it on)
  let failed = false;
  await page.routeWebSocket(/\/kw-ws$/, (ws) => {
    const server = ws.connectToServer();
    let first: number | undefined;
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (msg.method === "Open" && !failed) {
        failed = true;
        first = msg.id;
      }
      server.send(m);
    });
    server.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (msg.id !== undefined && msg.id === first) {
        // the server pane it opened is never used: close it, answer with the error
        if (msg.result?.pane) server.send(JSON.stringify({ id: -1, method: "Close", args: [msg.result.pane] }));
        ws.send(JSON.stringify({ id: msg.id, error: `resolve "pods": Get "https://127.0.0.1:61894/api?timeout=32s": dial tcp 127.0.0.1:61894: connect: connection refused` }));
        return;
      }
      ws.send(JSON.stringify(msg));
    });
  });
  await page.goto("/");
  const pane = page.locator("section[data-pane]").first();
  const alert = pane.getByRole("alert");
  await expect(alert).toContainText("connection refused");
  await expect(alert.getByLabel("hint")).toContainText("Nothing listens on 127.0.0.1:61894");
  await alert.getByRole("button", { name: /open another cluster/ }).click();
  const dialog = page.getByRole("dialog", { name: "open cluster" });
  await expect(dialog).toBeVisible();
  // the test garden (the tape backend's own contexts aren't in a kubeconfig ⌘⇧O can open)
  await page.getByRole("combobox", { name: "cluster" }).fill("tape-garden");
  await dialog.getByRole("option").filter({ hasText: /^tape-garden/ }).first().click();
  // the pane is on it, listing nothing yet (⌘O open over it), the error gone; one tab still
  await expect(page.getByRole("combobox", { name: "resource" })).toBeVisible();
  const s = await inspect(page);
  expect(s.tabs.length).toBe(1);
  expect(s.overlays).toEqual(["open"]);
  expect(((await focused(page)).spec as { context?: string }).context).toMatch(/^@\d+\/tape-garden$/);
  await expect(alert).toHaveCount(0);
});

test.describe("marked rows", () => {
  const marked = async (page: Page) => (await focused(page)).rows.filter((r) => r.marked).map((r) => r.key);
  const status = (page: Page) => page.locator("section[data-pane]").first().getByLabel("marked rows");
  const termText = (page: Page) => page.locator("[data-terminal] .xterm-rows").allInnerTexts();
  /** e2e-batch, synced: its rows less those other tests deleted (b-del-*: the backend is shared). */
  async function openBatch(page: Page) {
    await ready(page);
    await page.keyboard.press("ControlOrMeta+O");
    await page.getByRole("combobox", { name: "resource" }).fill("e2e-batch");
    await page.keyboard.press("Enter");
    await expect.poll(async () => {
      const p = await focused(page);
      return p.spec.resource === "e2e-batch" && !!p.status?.synced && p.rows.some((r) => r.key === "b-scale-1");
    }).toBe(true);
  }
  async function goTo(page: Page, key: string) {
    const rows = (await focused(page)).rows;
    await page.keyboard.press("g");
    for (let i = 0; i < rows.findIndex((r) => r.key === key); i++) await page.keyboard.press("j");
  }

  test("⇧↓ marks from the anchor, back unmarks; space and ⌘A; esc clears; actions on one row stay on the cursor's", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openBatch(page);
    await goTo(page, "b-pod-0");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+J");
    await expect.poll(() => marked(page)).toEqual(["b-pod-0", "b-pod-1", "b-scale-0"]);
    await expect(status(page)).toHaveText("3 marked");
    const at = async (key: string) => (await focused(page)).rows.findIndex((r) => r.key === key);
    expect((await focused(page)).selected).toBe(await at("b-scale-0"));
    // towards the anchor again: unmarked
    await page.keyboard.press("Shift+K");
    await expect.poll(() => marked(page)).toEqual(["b-pod-0", "b-pod-1"]);
    // space toggles the cursor row (it becomes the anchor)
    await page.keyboard.press("Space");
    await expect.poll(() => marked(page)).toEqual(["b-pod-0"]);
    // copy name: the marked names, a line each
    await page.keyboard.press("j");
    await page.keyboard.press("Space");
    await page.keyboard.press("ControlOrMeta+Enter");
    const menu = page.getByRole("menu");
    await expect(menu).toContainText("2 marked · cursor on b-scale-0");
    await expect(menu.getByRole("menuitem", { name: /^copy 2 names/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^delete 2…/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^debug containers in 1 pods…/ })).toBeVisible();
    // describe stays on the cursor row
    await expect(menu.getByRole("menuitem", { name: /^describe.*b-scale-0/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^copy cells of 2…/ })).toBeVisible();
    await menu.getByRole("menuitem", { name: /^copy 2 names/ }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("b-pod-0\nb-scale-0");
    // ⌘C without a text selection: the marked names too, not the cursor row's
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.keyboard.press("ControlOrMeta+C");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("b-pod-0\nb-scale-0");
    // copy cells: a column of every marked row, a line each; the whole row, a tab-separated line each
    await page.keyboard.press("ControlOrMeta+Shift+C");
    const cells = page.getByRole("menu", { name: "copy cells" });
    await expect(cells).toContainText("copy cells of 2 rows");
    await expect(cells.getByRole("menuitem").first()).toContainText("2 rows, tab-separated");
    const { columns: bcols, rows: brows } = await focused(page);
    const bname = bcols.indexOf("NAME");
    const line = (key: string) => brows.find((r) => r.key === key)!.cells;
    for (let i = 0; i <= bname; i++) await page.keyboard.press("j");
    await expect(cells.locator("[data-active]")).toContainText("… +1");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe([line("b-pod-0")[bname], line("b-scale-0")[bname]].join("\n"));
    await expect(page.getByRole("status", { name: "pane status" })).toContainText("copied NAME of 2 rows");
    await expect(status(page)).toHaveText("2 marked"); // the marks stay
    // ⌘A: every row shown; esc clears
    await page.keyboard.press("ControlOrMeta+A");
    const shown = (await focused(page)).rows.length; // b-del-* may be gone (the delete test)
    await expect.poll(async () => (await marked(page)).length).toBe(shown);
    await page.keyboard.press("Escape");
    await expect.poll(() => marked(page)).toEqual([]);
    await expect(status(page)).toHaveCount(0);
    // ⌘-click toggles, ⇧-click a range from it
    const cell = (row: number) => page.locator("section[data-pane] canvas").first().boundingBox().then((b) => ({ x: b!.x + 80, y: b!.y + 24 + 22 * row + 11 }));
    const c1 = await cell(await at("b-pod-0"));
    await page.keyboard.down("Meta");
    await page.mouse.click(c1.x, c1.y);
    await page.keyboard.up("Meta");
    await expect.poll(() => marked(page)).toEqual(["b-pod-0"]);
    const c3 = await cell(await at("b-scale-0"));
    await page.keyboard.down("Shift");
    await page.mouse.click(c3.x, c3.y);
    await page.keyboard.up("Shift");
    await expect.poll(() => marked(page)).toEqual(["b-pod-0", "b-pod-1", "b-scale-0"]);
    expect((await focused(page)).selected).toBe(await at("b-scale-0"));
    // a grep hiding marked rows drops their marks
    await page.keyboard.press("/");
    await page.keyboard.type("pod-1");
    await page.keyboard.press("Enter");
    await expect.poll(() => marked(page)).toEqual(["b-pod-1"]);
  });

  test("delete of marked rows: one confirmation listing them, then both deleted", async ({ page }) => {
    await openBatch(page);
    await goTo(page, "b-del-0");
    await page.keyboard.press("Shift+ArrowDown");
    await expect.poll(() => marked(page)).toEqual(["b-del-0", "b-del-1"]);
    await page.keyboard.press("ControlOrMeta+Backspace");
    const dialog = page.getByRole("alertdialog", { name: "confirm delete" });
    // a tape's resource is named after it (on a cluster: "delete 2 configmaps …")
    await expect(dialog.getByRole("paragraph")).toHaveText("delete 2 e2e-batch -n batch on tape");
    await expect(dialog.getByRole("list", { name: "objects" })).toHaveText(/b-del-0.*b-del-1/s);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await focused(page)).rows.filter((r) => r.mark === "deleted").map((r) => r.key)).toEqual(["b-del-0", "b-del-1"]);
    await expect(page.locator("section[data-pane]").first().getByLabel("message")).toHaveText("deleted 2 e2e-batch");
    await expect.poll(() => marked(page)).toEqual([]);
  });

  test("label and scale marked rows: one dialog for all; scale skips rows without replicas", async ({ page }) => {
    await openBatch(page);
    await goTo(page, "b-pod-1");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await expect.poll(() => marked(page)).toEqual(["b-pod-1", "b-scale-0", "b-scale-1"]);
    await page.keyboard.press("Shift+L");
    const dialog = page.getByRole("dialog", { name: "label 3" });
    // app=b on one of three rows
    await expect(dialog.getByRole("list", { name: "labels" })).toContainText("app=b1/3");
    await dialog.getByRole("combobox", { name: "changes" }).fill("team=x");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("section[data-pane]").first().getByLabel("message")).toHaveText("labeled 3 e2e-batch");

    await page.keyboard.press("s");
    const scale = page.getByRole("dialog", { name: "scale 2" });
    await expect(scale).toContainText("skipped (doesn't apply): b-pod-1");
    await expect(scale.getByRole("list", { name: "replicas now" })).toHaveText(/b-scale-0\s*2.*b-scale-1\s*3/s);
    await scale.getByRole("textbox", { name: "replicas" }).fill("0");
    await page.keyboard.press("Enter");
    await expect(scale).toHaveCount(0);
    await expect(page.locator("section[data-pane]").first().getByLabel("message")).toHaveText("scaled 2 e2e-batch to 0");
  });

  test("rollout restart of marked rows: one confirmation naming the workloads, pods skipped", async ({ page }) => {
    await openBatch(page);
    await goTo(page, "b-pod-1");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await expect.poll(() => marked(page)).toEqual(["b-pod-1", "b-scale-0", "b-scale-1"]);
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.getByRole("menuitem", { name: /^rollout restart 2…/ }).click();
    const confirm = page.getByRole("alertdialog", { name: "confirm restart" });
    await expect(confirm).toContainText("restart 2 e2e-batch -n batch on tape");
    await expect(confirm.getByRole("list", { name: "objects" })).toHaveText(/b-scale-0.*b-scale-1/s);
    await expect(confirm).toContainText("skipped: b-pod-1");
    await page.keyboard.press("Enter");
    await expect(confirm).toHaveCount(0);
    await expect(page.locator("section[data-pane]").first().getByLabel("message")).toHaveText("restarted 2 e2e-batch");
    // the marks stay (only a delete clears them)
    expect(await marked(page)).toEqual(["b-pod-1", "b-scale-0", "b-scale-1"]);
  });

  test("debug containers in marked pods: one dialog, a pane each in a new tab", async ({ page }) => {
    await openBatch(page);
    await goTo(page, "b-pod-0");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("b");
    const dialog = page.getByRole("dialog", { name: "debug containers" });
    await expect(dialog).toContainText("debug containers in 2 pods");
    const target = dialog.getByRole("combobox", { name: "target" });
    // b-pod-0 has a sidecar, b-pod-1 doesn't
    await target.fill("sidecar");
    await target.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText('not every pod has a container "sidecar"');
    await target.fill("");
    // an image no history entry completes to (⏎ on a suggestion would only take it)
    const image = dialog.getByRole("combobox", { name: "image" });
    await image.fill("batch-debug:1");
    await expect(dialog.getByRole("listbox", { name: "image suggestions" })).toHaveCount(0);
    await image.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("tab", { selected: true })).toContainText("debug ×2");
    await expect.poll(async () => (await termText(page)).length).toBe(2);
    await expect.poll(async () => (await termText(page)).join("\n")).toMatch(/b-pod-0[\s\S]*b-pod-1|b-pod-1[\s\S]*b-pod-0/);
    // each pod's own default container as target
    await expect.poll(async () => (await termText(page)).join("\n")).toContain('target "app"');
  });
});

test.describe("updates", () => {
  const dispatch = (page: Page, c: string) => page.evaluate((c) => (window as unknown as { __kw: { dispatch(c: string): void } }).__kw.dispatch(c), c);
  // one backend for the run: the skipped version is remembered across tests
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => (window as unknown as { __kw: { bridge(): { skipUpdate(v: string): Promise<unknown> } } }).__kw.bridge().skipUpdate(""));
  });

  test("check for updates: release notes of every version since the running one, as Markdown; skip hides the hint", async ({ page }) => {
    await ready(page);
    // no automatic check in the test backend: no hint before one
    await expect(page.getByRole("button", { name: "update available" })).toHaveCount(0);
    // the app menu's "Check for Updates…"
    await dispatch(page, "update.check");
    const dialog = page.getByRole("dialog", { name: "update" });
    await expect(dialog).toContainText("kubewing 0.3.0 is available, you have 0.1.0");
    expect((await inspect(page)).overlays).toEqual(["update"]);
    // finals only (no candidate), newest first, down to the running version (exclusive)
    const notes = dialog.getByRole("region", { name: /^kubewing / });
    await expect(notes).toHaveCount(2);
    await expect(notes.nth(0)).toHaveAccessibleName("kubewing 0.3.0");
    await expect(notes.nth(1)).toHaveAccessibleName("kubewing 0.2.0");
    // Markdown: headings, lists, emphasis, code, links into the repository at the version
    const latest = notes.nth(0);
    await expect(latest.getByRole("heading", { name: "Added" })).toBeVisible();
    await expect(latest.getByRole("heading", { name: "Fixed" })).toBeVisible();
    await expect(latest.getByRole("listitem")).toHaveCount(3);
    await expect(latest.locator("strong")).toHaveText("Updates:");
    await expect(latest.locator("code")).toHaveText("code");
    await expect(latest.getByRole("link", { name: "manual" })).toHaveAttribute("href", "https://github.com/dguendisch/kubewing/blob/v0.3.0/Manual.md#updates");
    // raw HTML stays text, a javascript: link isn't one
    await expect(latest).toContainText("<b>raw html</b>");
    await expect(latest.locator("b")).toHaveCount(0);
    await expect(latest.getByRole("link", { name: "elsewhere" })).toHaveCount(0);
    await expect(latest).toContainText("a fix elsewhere");
    // this backend can't replace itself: the button opens the release page instead
    await expect(dialog.getByRole("button", { name: "download…" })).toBeFocused();
    await expect(dialog).toContainText("checks daily (update.checkDays)");

    // esc closes; the hint stays for the offered version
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect((await inspect(page)).focus).toBe("table");
    const hint = page.getByRole("button", { name: "update available" });
    await expect(hint).toHaveText("⬆ 0.3.0");

    // the hint reopens the notes; skipping hides it, remembered across a reload
    await hint.click();
    await dialog.getByRole("button", { name: "skip this version" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(hint).toHaveCount(0);
    await page.reload();
    await ready(page);
    await dispatch(page, "update.check");
    await expect(dialog).toContainText("kubewing 0.3.0 is available");
    await expect(dialog.getByRole("button", { name: "skip this version" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "update available" })).toHaveCount(0);
  });
});
