import { describe, expect, it } from "vitest";
import { loadConfig, normalizeEnv, requireConfig, secretValues, describeConfig } from "./index.ts";

describe("config", () => {
  it("normalizes alias spellings to canonical names", () => {
    const e = normalizeEnv({ PRIMITIVEAPIKEY: "p1", GHOSTSAPIKEY: "g1", INSFORGEAPIKEY: "i1" });
    expect(e.PRIMITIVE_API_KEY).toBe("p1");
    expect(e.GHOSTS_API_KEY).toBe("g1");
    expect(e.INSFORGE_API_KEY).toBe("i1");
  });
  it("prefers the canonical spelling when both exist", () => {
    expect(normalizeEnv({ PRIMITIVE_API_KEY: "a", PRIMITIVEAPIKEY: "b" }).PRIMITIVE_API_KEY).toBe("a");
  });
  it("applies defaults and parses lists", () => {
    const c = loadConfig({ envFile: null, env: { PRIMITIVE_DOMAIN: "x.test", ALLOWED_SENDERS: " A@B.com , c@d.com" } });
    expect(c.ghostRunner).toBe("local");
    expect(c.registry).toBe("json");
    expect(c.port).toBe(8787);
    expect(c.serverUrl).toBe("http://localhost:8787");
    expect(c.allowedSenders).toEqual(["a@b.com", "c@d.com"]);
  });
  it("never exposes ANTHROPIC_API_KEY", () => {
    const c = loadConfig({ envFile: null, env: { ANTHROPIC_API_KEY: "sk-ant-should-not-be-read" } });
    expect(c.raw.ANTHROPIC_API_KEY).toBeUndefined();
  });
  it("rejects bad runner values", () => {
    expect(() => loadConfig({ envFile: null, env: { GHOST_RUNNER: "nope" } })).toThrow(/GHOST_RUNNER/);
  });
  it("collects secret values but not plain settings", () => {
    const c = loadConfig({ envFile: null, env: { GHOSTS_API_KEY: "sk-ant-abcdefgh", PRIMITIVE_DOMAIN: "safe-maple.primitive.email" } });
    expect(secretValues(c)).toContain("sk-ant-abcdefgh");
    expect(secretValues(c)).not.toContain("safe-maple.primitive.email");
  });
  it("requireConfig names missing keys without values", () => {
    const c = loadConfig({ envFile: null, env: {} });
    expect(() => requireConfig(c, "seanceSecret", "primitiveApiKey")).toThrow(/seanceSecret, primitiveApiKey/);
  });
  it("describeConfig never includes secret values", () => {
    const c = loadConfig({ envFile: null, env: { GHOSTS_API_KEY: "sk-ant-secretvalue" } });
    expect(JSON.stringify(describeConfig(c))).not.toContain("sk-ant-secretvalue");
  });
});
