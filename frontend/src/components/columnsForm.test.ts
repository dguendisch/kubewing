import { describe, expect, test } from "vitest";
import { rank } from "../complete/complete";
import { addColumn, emptyColumn, moveShown, moveTo, pathCandidates, pathContext, resetColumns, initialColumns, move, remove, toConfig, toggle, toggleMetrics, toggleWide, metricsOn, wideOn, type ColumnRow } from "./columnsForm";

// kubectl get pods: IP and NODE only with -o wide
const rows = (): ColumnRow[] =>
  initialColumns([
    { name: "NAME", shown: true },
    { name: "STATUS", shown: true },
    { name: "AGE", type: "age", shown: true },
    { name: "IP", priority: 1, shown: false },
    { name: "NODE", priority: 1, shown: false },
  ]);
const defaults = ["NAME", "STATUS", "AGE"];
const shown = (r: ColumnRow[]) => r.filter((x) => x.shown).map((x) => x.name);

describe("column dialog", () => {
  test("wide switch shows all wide columns, then hides them; partly shown counts as off", () => {
    let r = rows();
    expect(wideOn(r)).toBe(false);
    r = toggleWide(r);
    expect(shown(r)).toEqual(["NAME", "STATUS", "AGE", "IP", "NODE"]);
    expect(wideOn(r)).toBe(true);
    r = toggle(r, 4); // NODE off
    expect(wideOn(r)).toBe(false);
    expect(shown(toggleWide(r))).toEqual(["NAME", "STATUS", "AGE", "IP", "NODE"]);
    expect(shown(toggleWide(toggleWide(r)))).toEqual(["NAME", "STATUS", "AGE"]);
  });

  test("metrics switch: on right after NAME, in their order; off returns where they were, on again goes back there", () => {
    const base = () =>
      initialColumns([
        { name: "NAME", shown: true },
        { name: "STATUS", shown: true },
        { name: "IP", priority: 1, shown: true },
        { name: "CPU", type: "number", shown: false, metric: "usage" },
        { name: "MEM", type: "bytes", shown: false, metric: "usage" },
      ]);
    let r = base();
    expect(metricsOn(r, "usage")).toBe(false);
    r = toggleMetrics(r, "usage").rows;
    expect(shown(r)).toEqual(["NAME", "CPU", "MEM", "STATUS", "IP"]);
    expect(metricsOn(r, "usage")).toBe(true);
    expect(toConfig(r, ["NAME", "STATUS"])).toEqual([{ name: "NAME" }, { name: "CPU" }, { name: "MEM" }, { name: "STATUS" }, { name: "IP" }]);

    // moved after STATUS (and MEM before CPU): off says so, on puts them back there, in that order
    r = moveTo(moveTo(r, 1, 3), 1, 2);
    expect(shown(r)).toEqual(["NAME", "STATUS", "MEM", "CPU", "IP"]);
    const off = toggleMetrics(r, "usage");
    expect(off.place).toEqual({ after: "STATUS", order: ["MEM", "CPU"] });
    expect(shown(off.rows)).toEqual(["NAME", "STATUS", "IP"]);
    // as Go lists hidden columns again: in their built-in order
    const again = [...off.rows.filter((x) => !x.metric), ...base().filter((x) => x.metric)];
    expect(shown(toggleMetrics(again, "usage", off.place).rows)).toEqual(["NAME", "STATUS", "MEM", "CPU", "IP"]);
    // first: "" (not NAME)
    const first = toggleMetrics(moveTo(moveTo(toggleMetrics(base(), "usage").rows, 1, 0), 2, 1), "usage");
    expect(first.place?.after).toBe("");
    expect(shown(toggleMetrics(first.rows, "usage", first.place).rows)).toEqual(["CPU", "MEM", "NAME", "STATUS", "IP"]);
    // the column they followed is hidden meanwhile: after NAME (in their own order still)
    expect(shown(toggleMetrics(toggle(again, 1), "usage", off.place).rows)).toEqual(["NAME", "MEM", "CPU", "IP"]);
    // turned on, the place is used up: nothing to save
    expect(toggleMetrics(again, "usage", off.place).place).toBeUndefined();

    // partly shown counts as off: all of them on
    expect(shown(toggleMetrics(toggle(base(), 3), "usage").rows)).toEqual(["NAME", "CPU", "MEM", "STATUS", "IP"]);
    // NAME hidden: after the last shown column
    expect(shown(toggleMetrics(initialColumns([{ name: "NAME", shown: false }, { name: "STATUS", shown: true }, { name: "CPU", shown: false, metric: "usage" }]), "usage").rows)).toEqual(["STATUS", "CPU"]);
  });

  test("requests/limits switch is its own group: after the usage columns by default, each keeps its place", () => {
    let r = initialColumns([
      { name: "NAME", shown: true },
      { name: "STATUS", shown: true },
      { name: "CPU", shown: false, metric: "usage" },
      { name: "%CPU REQ", shown: false, metric: "alloc" },
    ]);
    r = toggleMetrics(r, "alloc").rows;
    // no usage shown: right after NAME
    expect(shown(r)).toEqual(["NAME", "%CPU REQ", "STATUS"]);
    expect(metricsOn(r, "alloc")).toBe(true);
    expect(metricsOn(r, "usage")).toBe(false);
    const off = toggleMetrics(r, "alloc");
    r = toggleMetrics(off.rows, "usage").rows;
    expect(shown(r)).toEqual(["NAME", "CPU", "STATUS"]);
    // its saved place wins: after NAME again, not after CPU
    expect(shown(toggleMetrics(r, "alloc", off.place).rows)).toEqual(["NAME", "%CPU REQ", "CPU", "STATUS"]);
    // without one: after the usage columns
    expect(shown(toggleMetrics(r, "alloc").rows)).toEqual(["NAME", "CPU", "%CPU REQ", "STATUS"]);
    // m doesn't touch them
    expect(shown(toggleMetrics(toggleMetrics(r, "alloc").rows, "usage").rows)).toEqual(["NAME", "%CPU REQ", "STATUS"]);
  });

  test("the server's defaults save as null (follow the server); anything else as the shown columns in order", () => {
    expect(toConfig(rows(), defaults)).toBeNull();
    expect(toConfig(toggle(rows(), 3), defaults)).toEqual([{ name: "NAME" }, { name: "STATUS" }, { name: "AGE" }, { name: "IP" }]);
    expect(toConfig(move(rows(), 2, -1), defaults)).toEqual([{ name: "NAME" }, { name: "AGE" }, { name: "STATUS" }]);
    expect(toConfig(toggle(rows(), 1), defaults)).toEqual([{ name: "NAME" }, { name: "AGE" }]);
  });

  test("move stays at the ends", () => {
    expect(move(rows(), 0, -1)).toEqual(rows());
    expect(move(rows(), 4, 1)).toEqual(rows());
  });

  test("a custom column: named after its path, shown after the last shown column, saved with path and type", () => {
    const r = addColumn(rows(), { ...emptyColumn, value: "spec.containers[0].image" });
    if ("error" in r) throw new Error(r.error);
    expect(r.rows.map((x) => x.name)).toEqual(["NAME", "STATUS", "AGE", "IMAGE", "IP", "NODE"]);
    const n = addColumn(r.rows, { name: "restarts", mode: "expr", value: "o.status.containerStatuses[0].restartCount", type: "number" });
    if ("error" in n) throw new Error(n.error);
    expect(toConfig(n.rows, defaults)).toEqual([
      { name: "NAME" },
      { name: "STATUS" },
      { name: "AGE" },
      { name: "IMAGE", path: "spec.containers[0].image" },
      { name: "RESTARTS", expr: "o.status.containerStatuses[0].restartCount", type: "number" },
    ]);
    // a custom column can be removed, a server one not
    expect(shown(remove(n.rows, 3))).toEqual(["NAME", "STATUS", "AGE", "RESTARTS"]);
    expect(remove(n.rows, 0)).toBe(n.rows);
  });

  test("refused: no value, a duplicate name, a path with spaces", () => {
    expect(addColumn(rows(), emptyColumn)).toHaveProperty("error");
    expect(addColumn(rows(), { ...emptyColumn, name: "name", value: "metadata.uid" })).toEqual({ error: "there is a column NAME already" });
    expect(addColumn(rows(), { ...emptyColumn, value: "metadata.labels[app x]" })).toHaveProperty("error");
  });

  test("a missing server column stays saved while shown", () => {
    const r = initialColumns([{ name: "NAME", shown: true }, { name: "GONE", shown: true, missing: true }, { name: "AGE", shown: false }]);
    expect(toConfig(r, ["NAME", "AGE"])).toEqual([{ name: "NAME" }, { name: "GONE" }]);
  });

  test("path completion: one segment at a time, list indices skipped; keys with dots are left to CEL", () => {
    expect(pathContext("")).toEqual({ parent: [], prefix: "", head: "" });
    expect(pathContext("spec.containers[0].im")).toEqual({ parent: ["spec", "containers"], prefix: "im", head: "spec.containers[0]." });
    const keys = { objects: 2, keys: [{ key: "nodeName", type: "string", count: 2 }, { key: "containers", type: "list", count: 2 }, { key: "app.kubernetes.io/name", type: "string", count: 1 }] };
    expect(pathCandidates("spec.no", keys).map((c) => c.value)).toEqual(["spec.nodeName", "spec.containers[0]."]);
    // Combobox ranks the whole typed value: the path matches, the key alone wouldn't
    expect(rank("spec.nod", pathCandidates("spec.nod", keys)).map((m) => m.candidate.label)[0]).toBe("nodeName");
  });

  test("reset: the server's defaults in order, the other server columns hidden, custom and missing ones gone", () => {
    const r = addColumn(move(toggleWide(rows()), 0, 1), { ...emptyColumn, value: "spec.nodeName" });
    if ("error" in r) throw new Error(r.error);
    const reset = resetColumns([...r.rows, { name: "GONE", shown: true, missing: true }], defaults);
    expect(reset.map((x) => [x.name, x.shown])).toEqual([["NAME", true], ["STATUS", true], ["AGE", true], ["IP", false], ["NODE", false]]);
    expect(toConfig(reset, defaults)).toBeNull();
  });

  test("drag & drop in the list: the row lands where the target was", () => {
    expect(moveTo(rows(), 0, 2).map((r) => r.name)).toEqual(["STATUS", "AGE", "NAME", "IP", "NODE"]);
    expect(moveTo(rows(), 4, 1).map((r) => r.name)).toEqual(["NAME", "NODE", "STATUS", "AGE", "IP"]);
    expect(moveTo(rows(), 1, 1)).toEqual(rows());
    expect(moveTo(rows(), 1, 9)).toEqual(rows());
  });

  test("a header dragged in the table saves the shown columns in the new order; custom ones keep their spec", () => {
    expect(moveShown(defaults, undefined, defaults, 2, 0)).toEqual([{ name: "AGE" }, { name: "NAME" }, { name: "STATUS" }]);
    // dragging back to the server's order: no settings
    expect(moveShown(["AGE", "NAME", "STATUS"], [{ name: "AGE" }, { name: "NAME" }, { name: "STATUS" }], defaults, 0, 2)).toBeNull();
    const saved = [{ name: "NAME" }, { name: "HOST", path: "spec.nodeName" }, { name: "IP" }];
    expect(moveShown(["NAME", "HOST", "IP"], saved, defaults, 1, 0)).toEqual([{ name: "HOST", path: "spec.nodeName" }, { name: "NAME" }, { name: "IP" }]);
    expect(moveShown(defaults, undefined, defaults, 1, 1)).toBeUndefined();
  });
});
