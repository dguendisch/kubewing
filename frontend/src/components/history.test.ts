import { describe, expect, it } from "vitest";
import { initialSpec } from "../store/state";
import { describeView } from "./history";

describe("describeView", () => {
  it("resource and namespace; the context only when it differs from the pane's", () => {
    expect(describeView(initialSpec("kind", "shop"), "kind")).toEqual({ label: "pods -n shop", detail: "" });
    expect(describeView({ ...initialSpec("prod"), resource: "nodes" }, "kind")).toEqual({ label: "prod · nodes -A", detail: "" });
  });

  it("filters apart, in the filter bar's order", () => {
    const spec = { ...initialSpec("kind"), labelSelector: "app=web", fieldSelector: "spec.nodeName=n1", grep: "oom", filter: 'o.metadata.name == "web"', hideHealthy: true };
    expect(describeView(spec, "kind").detail).toBe('-l app=web · spec.nodeName=n1 · /oom · o.metadata.name == "web" · unhealthy');
  });
});
