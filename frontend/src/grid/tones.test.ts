import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "../transport/types";
import { tone } from "./tones";

const at = (columns: string[], cells: string[], name: string) => {
  const cols: ColumnInfo[] = columns.map((n) => ({ name: n }));
  return tone(cells, columns.indexOf(name), cols);
};
const pod = (ready: string, status: string) => at(["NAME", "READY", "STATUS"], ["web", ready, status], "STATUS");
const ready = (ready: string, status = "Running") => at(["NAME", "READY", "STATUS"], ["web", ready, status], "READY");

describe("tone", () => {
  it("a pod's status", () => {
    expect(pod("1/1", "Running")).toBe("ok");
    expect(pod("0/1", "Completed")).toBe("ok");
    expect(pod("0/1", "Pending")).toBe("warn");
    expect(pod("0/1", "ContainerCreating")).toBe("warn");
    expect(pod("0/1", "Init:0/2")).toBe("warn");
    expect(pod("0/1", "Init:CrashLoopBackOff")).toBe("bad");
    expect(pod("0/1", "CrashLoopBackOff")).toBe("bad");
    expect(pod("0/1", "ImagePullBackOff")).toBe("bad");
    expect(pod("0/1", "CreateContainerConfigError")).toBe("bad");
    expect(pod("0/1", "OOMKilled")).toBe("bad");
    expect(pod("0/1", "ExitCode:137")).toBe("bad");
    expect(pod("1/1", "Terminating")).toBe("warn");
    expect(pod("1/1", "SomethingNew")).toBeUndefined();
  });
  it("a comma list takes its worst state", () => {
    expect(at(["NAME", "STATUS"], ["n1", "Ready"], "STATUS")).toBe("ok");
    expect(at(["NAME", "STATUS"], ["n1", "Ready,SchedulingDisabled"], "STATUS")).toBe("warn");
    expect(at(["NAME", "STATUS"], ["n1", "NotReady,SchedulingDisabled"], "STATUS")).toBe("warn");
    expect(at(["NAME", "CONDITION"], ["csr", "Approved,Issued"], "CONDITION")).toBe("ok");
    expect(at(["NAME", "CONDITION"], ["csr", "Denied"], "CONDITION")).toBe("bad");
  });
  it("READY: all, some or none of n ready; a condition's True/False", () => {
    expect(ready("2/2")).toBe("ok");
    expect(ready("1/2")).toBe("warn");
    expect(ready("0/2")).toBe("warn");
    expect(ready("0/0")).toBeUndefined();
    expect(ready("0/1", "Completed")).toBeUndefined(); // a finished pod's containers aren't meant to be ready
    expect(at(["NAME", "READY"], ["cert", "True"], "READY")).toBe("ok");
    expect(at(["NAME", "READY"], ["cert", "False"], "READY")).toBe("bad");
    expect(at(["NAME", "READY"], ["cert", "Unknown"], "READY")).toBe("warn");
  });
  it("condition columns, Gardener's included; PROGRESSING the other way round", () => {
    const mr = ["NAME", "CLASS", "APPLIED", "AVAILABLE", "PROGRESSING"];
    expect(at(mr, ["mr", "", "True", "True", "False"], "APPLIED")).toBe("ok");
    expect(at(mr, ["mr", "", "False", "True", "False"], "APPLIED")).toBe("bad");
    expect(at(mr, ["mr", "", "True", "Unknown", "False"], "AVAILABLE")).toBe("warn");
    expect(at(mr, ["mr", "", "True", "True", "False"], "PROGRESSING")).toBe("ok");
    expect(at(mr, ["mr", "", "True", "True", "True"], "PROGRESSING")).toBe("warn");
    const shoot = ["NAME", "APISERVER", "CONTROL", "NODES", "SYSTEM", "LAST OPERATION", "STATUS"];
    const s = ["bar", "True", "Progressing", "False", "True", "Reconcile Processing (40%)", "unhealthy"];
    expect(at(shoot, s, "CONTROL")).toBe("warn");
    expect(at(shoot, s, "NODES")).toBe("bad");
    expect(at(shoot, s, "LAST OPERATION")).toBe("warn");
    expect(at(shoot, s, "STATUS")).toBe("bad");
    expect(at(shoot, ["bar", "", "", "", "", "Reconcile Succeeded (100%)", "healthy"], "LAST OPERATION")).toBe("ok");
    expect(at(shoot, ["bar", "", "", "", "", "Reconcile Error (60%)", "healthy"], "LAST OPERATION")).toBe("bad");
  });
  it("an event's type", () => {
    expect(at(["LAST SEEN", "TYPE", "REASON"], ["", "Warning", "BackOff"], "TYPE")).toBe("warn");
    expect(at(["LAST SEEN", "TYPE", "REASON"], ["", "Normal", "Pulled"], "TYPE")).toBe("ok");
  });
  it("only where the column means a state: other columns, typed columns and empty cells have none", () => {
    expect(at(["NAME", "SUSPEND"], ["cron", "False"], "SUSPEND")).toBeUndefined();
    expect(at(["NAME", "NODE"], ["Running", "Failed"], "NAME")).toBeUndefined();
    expect(at(["NAME", "STATUS"], ["web", ""], "STATUS")).toBeUndefined();
    expect(tone(["web", "1/2"], 1, [{ name: "NAME" }, { name: "READY", type: "number" }])).toBeUndefined();
    expect(tone(["web"], 3, [{ name: "NAME" }])).toBeUndefined();
  });
  it("a metric's percentage: warn from 70%, bad from 90%, over 100% too", () => {
    const pct = (name: string, v: string) => tone(["web", v], 1, [{ name: "NAME" }, { name, type: "number" }]);
    expect(pct("%CPU", "69%")).toBeUndefined();
    expect(pct("%CPU", "70%")).toBe("warn");
    expect(pct("%MEM", "89%")).toBe("warn");
    expect(pct("%MEM", "90%")).toBe("bad");
    expect(pct("%CPU/R", "250%")).toBe("bad");
    expect(pct("%MEM/L", "95%")).toBe("bad");
    expect(pct("%CPU REQ", "75%")).toBe("warn");
    expect(pct("%PODS", "100%")).toBe("bad");
    expect(pct("%nvidia.com/gpu REQ", "50%")).toBeUndefined();
    expect(pct("%CPU", "")).toBeUndefined(); // no metrics yet
    // only numeric % columns: not a counter, nor a string column that happens to start with %
    expect(pct("PODS", "95")).toBeUndefined();
    expect(tone(["web", "95%"], 1, [{ name: "NAME" }, { name: "%DONE" }])).toBeUndefined();
  });
});
