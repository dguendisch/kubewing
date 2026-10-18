import { describe, expect, it } from "vitest";
import { containerPorts, parsePorts } from "./ports";

describe("ports", () => {
  it("reads container ports from pod YAML", () => {
    const y = `spec:\n  containers:\n  - name: app\n    ports:\n    - containerPort: 8080\n      protocol: TCP\n    - containerPort: 9090\n  - name: side\n    ports:\n    - containerPort: 8080\n`;
    expect(containerPorts(y)).toEqual([8080, 9090]);
    expect(containerPorts("kind: ConfigMap\n")).toEqual([]);
  });
  it("parses and validates port specs", () => {
    expect(parsePorts("8080:80 9090, :443")).toEqual(["8080:80", "9090", ":443"]);
    expect(parsePorts("  ")).toBe("no ports given");
    expect(parsePorts("80:abc")).toContain('invalid port "80:abc"');
    expect(parsePorts("70000")).toContain("invalid");
    expect(parsePorts("1:2:3")).toContain("invalid");
  });
});
