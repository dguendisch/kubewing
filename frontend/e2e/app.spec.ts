import { expect, test, type Page } from "@playwright/test";

type Inspect = {
  focus: string;
  focusedPane: string;
  overlays: string[];
  activeTab: number;
  tabs: { id: string; focused: string; layout: unknown }[];
  panes: Record<string, { spec: { resource: string; grep: string }; serverId?: string; total: number; selected: number; columns: string[]; rows: { key: string; cells: string[]; mark?: string; changed?: number[] }[]; status?: { synced: boolean } }>;
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

async function openTape(page: Page, resource = "e2e-pods") {
  await ready(page);
  await page.keyboard.press("ControlOrMeta+O");
  await page.getByRole("combobox", { name: "resource" }).fill(resource);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => {
      const p = await focused(page);
      return p.spec.resource === resource && !!p.serverId && p.status?.synced ? p.total : -1;
    })
    .toBe(3);
}

const focused = async (page: Page) => {
  const s = await inspect(page);
  return s.panes[s.focusedPane]!;
};

test("live table shows server-side columns and rows", async ({ page }) => {
  await openTape(page);
  const p = await focused(page);
  expect(p.columns).toEqual(["NAMESPACE", "NAME", "STATUS", "RESTARTS", "AGE"]);
  expect(p.rows.map((r) => r.cells[1])).toEqual(["etcd-0", "api-0", "api-1"]);
  expect(p.status?.synced).toBe(true);
  await expect(page.getByRole("status", { name: "pane status" })).toContainText("3 shown / 3 objects");
});

test("keyed diff: restart is a changed cell, recreate is remove + add", async ({ page }) => {
  await openTape(page);
  await expect.poll(async () => (await focused(page)).rows.find((r) => r.key === "e-api-1")?.changed).toEqual([3]);
  await expect.poll(async () => (await focused(page)).rows.map((r) => [r.key, r.mark ?? ""])).toEqual([
    ["e-etcd-0", ""],
    ["e-api-0", "deleted"],
    ["e-api-0-b", "added"],
    ["e-api-1", ""],
  ]);
});

test("cmd+shift+d / cmd+d split, cmd+w closes, focus stays valid", async ({ page }) => {
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
  await page.keyboard.press("ControlOrMeta+W");
  s = await inspect(page);
  expect(s.focusedPane).toBe("v2");
  expect(Object.keys(s.panes).sort()).toEqual(["v1", "v2"]);
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

  test("labeled context: badge on pane and tab; ctrl+d confirms, esc cancels and restores focus", async ({ page }) => {
    await openStatic(page, "tape-dev");
    await expect(pane(page)).toHaveAttribute("data-context", "tape-dev");
    await expect(pane(page).getByLabel("context label")).toHaveText("DEV");
    await expect(pane(page).getByLabel("read-only")).toHaveCount(0);
    await expect(page.getByRole("tab", { selected: true })).toContainText("DEV · e2e-static");

    await select(page, "s-web-1"); // never deleted by any test
    const sel = (await focused(page)).selected;
    await page.keyboard.press("Control+D");
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
    await page.keyboard.press("Control+D");
    await page.getByRole("alertdialog", { name: "confirm delete" }).waitFor();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await marks(page))["s-web-2"]).toBe("deleted");
    await expect(pane(page).getByLabel("message")).toHaveText("deleted e2e-static/web-2");
    expect((await inspect(page)).focus).toBe("table");
  });

  test("strict context: delete needs the object name typed", async ({ page }) => {
    await openStatic(page, "tape-live");
    await select(page, "s-web-0");
    await page.keyboard.press("Control+D");
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
    await page.keyboard.press("Control+D");
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
    await expect.poll(async () => (await focused(page)).rows.map((r) => r.key)).toContain("e-api-0-b");
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

  test("⌘F opens Monaco's find (not the pane filter); esc closes find, then the view", async ({ page }) => {
    await openApi1(page);
    await page.keyboard.press("ControlOrMeta+F");
    await expect(page.locator(".find-widget.visible")).toBeVisible();
    expect((await inspect(page)).focus).toBe("detail");
    await page.keyboard.press("Escape");
    await expect(page.locator(".find-widget.visible")).toHaveCount(0);
    expect((await inspect(page)).overlays).toEqual(["detail"]);
    await page.keyboard.press("Escape");
    expect((await inspect(page)).overlays).toEqual([]);
    expect((await inspect(page)).focus).toBe("table");
  });
});

// Object actions on the static tape: web-1 (2 containers, ports 8080/9090), cfg (a ConfigMap).
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

  test("⇧D describes in Monaco; y back to yaml", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    await page.keyboard.press("Shift+D");
    const dialog = page.getByRole("dialog", { name: "object detail" });
    await expect(dialog).toContainText("describe");
    await expect(dialog.locator(".view-lines")).toContainText("Name:         web-1");
    await expect(dialog.locator(".view-lines")).toContainText("app=web");
    await page.keyboard.press("y");
    await expect(dialog.locator(".view-lines")).toContainText("apiVersion: v1");
    await page.keyboard.press("Escape");
    expect((await inspect(page)).overlays).toEqual([]);
  });

  test("s opens a terminal pane below; keys go to the shell; ⌘W closes it and the session", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    await page.keyboard.press("s");
    await expect.poll(async () => (await inspect(page)).focus).toBe("terminal");
    const s = await inspect(page);
    const termPane = s.panes[s.focusedPane] as unknown as { term?: { session: string; pod: string; container: string } };
    expect(termPane.term).toMatchObject({ pod: "web-1", container: "app" });
    await expect(page.locator("section[data-pane] header").filter({ hasText: "exec" })).toContainText("web-1/app");
    await expect.poll(() => termText(page)).toContain("web-1:app$");
    // j and / are table keys; in a terminal they are just typed
    await page.keyboard.type("echo j/k");
    await page.keyboard.press("Enter");
    await expect.poll(() => termText(page)).toContain("echo j/k\necho j/k");
    expect((await inspect(page)).overlays).toEqual([]);
    expect((await focused(page)).selected).toBe(0); // the table selection didn't move
    // ⌘ chords still reach the app
    await page.keyboard.press("ControlOrMeta+W");
    await expect.poll(async () => Object.values((await inspect(page)).panes).some((p) => (p as { term?: unknown }).term)).toBe(false);
    expect((await inspect(page)).focus).toBe("table");
  });

  test("exit in the shell marks the pane ended", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    await page.keyboard.press("s");
    await expect.poll(() => termText(page)).toContain("$");
    await page.keyboard.type("exit 2");
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("session ended")).toContainText("exited 2");
  });

  test("⇧F forwards the pod's ports; ⌘⌥P lists them, ⌃D stops", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-web-1");
    await page.keyboard.press("Shift+F");
    const dialog = page.getByRole("dialog", { name: "port-forward" });
    await expect(dialog.getByRole("textbox", { name: "ports" })).toHaveValue("8080:8080 9090:9090");
    await dialog.getByRole("textbox", { name: "ports" }).fill("18080:8080");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("message")).toContainText("127.0.0.1:18080 → 8080");
    await expect(page.getByLabel("active port-forwards")).toHaveText("⇄ 1");
    await page.keyboard.press("ControlOrMeta+Alt+P");
    const list = page.getByRole("listbox", { name: "active port-forwards" });
    await expect(list.getByRole("option")).toHaveCount(1);
    await expect(list.getByRole("option").first()).toContainText("shop/web-1");
    expect((await inspect(page)).focus).toBe("forwards");
    await page.keyboard.press("Control+D");
    await expect(list).toHaveCount(0);
    await expect(page.getByLabel("active port-forwards")).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect((await inspect(page)).focus).toBe("table");
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
    await page.keyboard.press("Shift+F");
    const dialog = page.getByRole("dialog", { name: "port-forward" });
    await dialog.getByRole("textbox", { name: "ports" }).fill("80:abc");
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText('invalid port "80:abc"');
  });

  test("not a pod: exec and port-forward are refused", async ({ page }) => {
    await openStatic(page);
    await select(page, "s-cfg");
    await page.keyboard.press("s");
    await expect(page.getByLabel("message")).toContainText("exec needs a pod, not configmap");
    expect((await inspect(page)).focus).toBe("table");
  });

  test("read-only context: exec refused; describe still works", async ({ page }) => {
    await openStatic(page, "tape-prod");
    await select(page, "s-web-1");
    await page.keyboard.press("s");
    await expect(page.getByLabel("message")).toContainText("read-only context");
    expect(Object.values((await inspect(page)).panes).some((p) => (p as { term?: unknown }).term)).toBe(false);
    await page.keyboard.press("Shift+D");
    await expect(page.getByRole("dialog", { name: "object detail" }).locator(".view-lines")).toContainText("Name:         web-1");
  });
});
