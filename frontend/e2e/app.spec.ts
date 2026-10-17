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
  await expect(page.getByRole("alert")).toContainText("doesn't have a resource type");
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
    await expect(page.getByRole("alert")).toContainText("doesn't have a resource type");
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
