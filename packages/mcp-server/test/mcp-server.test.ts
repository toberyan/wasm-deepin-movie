import { describe, expect, it } from "vitest";
import { buildMcpTools } from "../src/index";

describe("MCP tool schemas", () => {
  const tools = buildMcpTools();

  it("publishes one tool per action with draft-7-compatible tuples", () => {
    expect(tools.length).toBeGreaterThan(40);
    const state = tools.find((tool) => tool.name === "state_get");
    expect(state).toBeDefined();
    const serialized = JSON.stringify(state?.outputSchema);
    expect(serialized).not.toContain('"prefixItems"');
    expect(serialized).toContain('"additionalItems":false');
    expect(serialized).toContain('"timeBase":{"type":"array","items":[');
  });

  it("keeps unique tool names", () => {
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
