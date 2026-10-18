import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../cli/main.ts";
import { memoryIo } from "../cli/io.ts";
import { BIN, cleanEnv, DOMAIN, FakeRegistry, SESSION_A, TempRepo, testConfig, tmpDir } from "./test-helpers.ts";

function blockingSetup() {
  const repo = new TempRepo();
  repo.write("a.ts", "const X = 1;\n");
  repo.commit("agent", "bbbbbbbb");
  const input = JSON.stringify({ session_id: SESSION_A, cwd: repo.dir, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo.dir, "a.ts"), old_string: "X = 1", new_string: "X = 2" } });
  return { repo, input };
}

describe("seance hook (in process)", () => {
  it("blocks with exit 2 and prints the message to stderr", async () => {
    const { input } = blockingSetup();
    const io = memoryIo();
    const code = await runCli(["hook", "pre-edit"], { io, env: {}, config: testConfig(tmpDir()), readStdin: async () => input, getRegistry: async () => new FakeRegistry() });
    expect(code).toBe(2);
    expect(io.stderr.join("")).toContain(`s-bbbbbbbb@${DOMAIN}`);
  });

  it("SEANCE_GHOST=1 short-circuits every hook", async () => {
    const { input } = blockingSetup();
    let readStdin = false;
    const code = await runCli(["hook", "pre-edit"], {
      io: memoryIo(),
      env: { SEANCE_GHOST: "1" },
      readStdin: async () => ((readStdin = true), input),
      getRegistry: async () => { throw new Error("must not load"); },
    });
    expect(code).toBe(0);
    expect(readStdin).toBe(false);
  });

  it("fails open on garbage stdin, unknown hooks and registry errors, and logs", async () => {
    const dataDir = tmpDir("seance-data-");
    const config = testConfig(dataDir);
    const base = { io: memoryIo(), env: {}, config, getRegistry: async () => { throw new Error("registry down"); } };
    expect(await runCli(["hook", "pre-edit"], { ...base, readStdin: async () => "not json{" })).toBe(0);
    expect(await runCli(["hook", "nope"], { ...base, readStdin: async () => "{}" })).toBe(0);
    expect(await runCli(["hook", "session-start"], { ...base, readStdin: async () => JSON.stringify({ session_id: SESSION_A, cwd: dataDir }) })).toBe(0);
    const log = fs.readFileSync(path.join(dataDir, "hooks.log"), "utf8");
    expect(log).toMatch(/\[pre-edit\] error/);
    expect(log).toMatch(/\[nope\] error/);
    expect(log).toMatch(/\[session-start\] error.*registry down/);
  });
});

describe("seance hook (real process via cli/bin.js)", () => {
  const runBin = (args: string[], stdin: string, extra: Record<string, string>) =>
    spawnSync(process.execPath, [BIN, ...args], { input: stdin, encoding: "utf8", env: cleanEnv({ PRIMITIVE_DOMAIN: DOMAIN, ...extra }), timeout: 20000 });

  it("blocks for real, and SEANCE_GHOST=1 exits 0", () => {
    const { input } = blockingSetup();
    const dataDir = tmpDir("seance-data-");
    const blocked = runBin(["hook", "pre-edit"], input, { SEANCE_DATA_DIR: dataDir });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("seance ask a.ts:1");
    const ghost = runBin(["hook", "pre-edit"], input, { SEANCE_DATA_DIR: dataDir, SEANCE_GHOST: "1" });
    expect(ghost.status).toBe(0);
    expect(ghost.stderr).toBe("");
  });

  it("exits 0 on garbage stdin and logs to <dataDir>/hooks.log", () => {
    const dataDir = tmpDir("seance-data-");
    for (const h of ["pre-edit", "session-start", "session-end"]) {
      const r = runBin(["hook", h], "garbage", { SEANCE_DATA_DIR: dataDir });
      expect(r.status).toBe(0);
    }
    expect(fs.readFileSync(path.join(dataDir, "hooks.log"), "utf8").split("\n").filter(Boolean)).toHaveLength(3);
  });
});
