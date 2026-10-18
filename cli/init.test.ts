import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CLI_COMMAND, currentSessionFile } from "../hooks/common.ts";
import { cleanEnv, DOMAIN, SESSION_A, TempRepo, tmpDir } from "../hooks/test-helpers.ts";
import { memoryIo } from "./io.ts";
import { GIT_HOOK_MARKER, mergeSettings } from "./init.ts";
import { runCli } from "./main.ts";

let repo: TempRepo;
beforeEach(() => {
  repo = new TempRepo();
});

async function init() {
  const io = memoryIo();
  const code = await runCli(["init"], { cwd: repo.dir, io });
  expect(code).toBe(0);
  return io.stdout.join("\n");
}

const settings = () => JSON.parse(repo.read(".claude/settings.json"));

describe("seance init", () => {
  it("writes the exact hook settings, and re-running changes nothing", async () => {
    const out = await init();
    expect(out).toContain("added PreToolUse hook");
    expect(settings()).toEqual({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `${CLI_COMMAND} hook session-start` }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: `${CLI_COMMAND} hook session-end` }] }],
        PreToolUse: [{ matcher: "Edit|MultiEdit|Write", hooks: [{ type: "command", command: `${CLI_COMMAND} hook pre-edit` }] }],
      },
    });
    const files = [".claude/settings.json", ".gitignore", "CLAUDE.md", ".claude/skills/seance/SKILL.md", ".git/hooks/prepare-commit-msg"];
    const before = files.map((f) => repo.read(f));
    const again = await init();
    expect(again).toContain("Nothing changed");
    expect(files.map((f) => repo.read(f))).toEqual(before);
  });

  it("preserves foreign settings and hooks", async () => {
    const foreign = {
      model: "opus",
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo bash" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      },
    };
    repo.write(".claude/settings.json", JSON.stringify(foreign));
    await init();
    await init();
    const s = settings();
    expect(s.model).toBe("opus");
    expect(s.permissions).toEqual(foreign.permissions);
    expect(s.hooks.Stop).toEqual(foreign.hooks.Stop);
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse[0]).toEqual(foreign.hooks.PreToolUse[0]);
    expect(s.hooks.SessionStart).toHaveLength(2);
    expect(s.hooks.SessionStart[0]).toEqual(foreign.hooks.SessionStart[0]);
  });

  it("updates an old Séance command in place instead of adding a second one", () => {
    const s: Record<string, any> = { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "seance hook session-end" }] }] } };
    const changes = mergeSettings(s, "node /x/cli/bin.js");
    expect(changes).toContain("updated SessionEnd hook command");
    expect(s.hooks.SessionEnd).toEqual([{ hooks: [{ type: "command", command: "node /x/cli/bin.js hook session-end" }] }]);
  });

  it("refuses to clobber invalid settings JSON", async () => {
    repo.write(".claude/settings.json", "{ nope");
    const io = memoryIo();
    expect(await runCli(["init"], { cwd: repo.dir, io })).toBe(1);
    expect(repo.read(".claude/settings.json")).toBe("{ nope");
  });

  it("adds .seance/ to .gitignore once, and the CLAUDE.md section once", async () => {
    repo.write(".gitignore", "node_modules");
    repo.write("CLAUDE.md", "# Project\n\nRules.\n");
    await init();
    await init();
    expect(repo.read(".gitignore")).toBe("node_modules\n.seance/\n");
    const md = repo.read("CLAUDE.md");
    expect(md.startsWith("# Project\n\nRules.\n\n## Séance")).toBe(true);
    expect(md.match(/## Séance/g)).toHaveLength(1);
  });

  it("writes a skill with frontmatter and the key instructions", async () => {
    await init();
    const skill = repo.read(".claude/skills/seance/SKILL.md");
    expect(skill).toMatch(/^---\nname: seance\ndescription: .+\n---\n/);
    for (const s of ["Agent-Session", "seance whois", "seance ask", "verified", "tell the user what the ghost said", CLI_COMMAND]) expect(skill).toContain(s);
  });

  it("chains an existing non-Séance git hook", async () => {
    const hook = path.join(repo.dir, ".git/hooks/prepare-commit-msg");
    fs.writeFileSync(hook, '#!/bin/sh\necho "local-hook-ran" >> "$1"\n', { mode: 0o755 });
    const out = await init();
    expect(out).toContain("prepare-commit-msg.local");
    expect(fs.readFileSync(hook, "utf8")).toContain(GIT_HOOK_MARKER);
    expect(fs.readFileSync(hook + ".local", "utf8")).toContain("local-hook-ran");
    await init(); // does not rename our own hook over the .local one
    expect(fs.readFileSync(hook + ".local", "utf8")).toContain("local-hook-ran");
    repo.write("f.txt", "x");
    repo.git("add", ".");
    execFileSync("git", ["-C", repo.dir, "commit", "-q", "-m", "hello"], { env: cleanEnv({ SEANCE_DATA_DIR: tmpDir() }) });
    expect(repo.git("log", "-1", "--format=%B")).toContain("local-hook-ran");
  });

  it("errors outside a git repo", async () => {
    const io = memoryIo();
    expect(await runCli(["init"], { cwd: tmpDir(), io })).toBe(1);
    expect(io.stderr.join("")).toMatch(/not inside a git repository/);
  });
});

describe("commit stamping via the installed git hook", () => {
  let dataDir: string;
  beforeEach(async () => {
    await init();
    dataDir = tmpDir("seance-data-");
    fs.mkdirSync(path.dirname(currentSessionFile(repo.dir)), { recursive: true });
    fs.writeFileSync(currentSessionFile(repo.dir), SESSION_A + "\n");
  });

  const commit = (args: string[], extra: Record<string, string> = {}) =>
    execFileSync("git", ["-C", repo.dir, "commit", "-q", ...args], { env: cleanEnv({ SEANCE_DATA_DIR: dataDir, PRIMITIVE_DOMAIN: DOMAIN, ...extra }) });
  const body = () => repo.git("log", "-1", "--format=%B");
  const trailers = () => repo.git("log", "-1", "--format=%(trailers)");

  it("stamps commits made from Claude Code, and the human stays the author", () => {
    repo.write("a.txt", "1");
    repo.git("add", ".");
    commit(["-m", "agent change"], { CLAUDECODE: "1" });
    expect(trailers()).toBe(`Agent-Session: s-aaaaaaaa@${DOMAIN}\nCo-Authored-By: Claude session aaaaaaaa <s-aaaaaaaa@${DOMAIN}>`);
    expect(repo.git("log", "-1", "--format=%an <%ae>")).toBe("Human <human@example.com>");
  });

  it("does not stamp without CLAUDECODE, unless SEANCE_STAMP_ALWAYS=1", () => {
    repo.write("a.txt", "1");
    repo.git("add", ".");
    commit(["-m", "human change"]);
    expect(body()).toBe("human change");
    repo.write("a.txt", "2");
    repo.git("add", ".");
    commit(["-m", "forced"], { SEANCE_STAMP_ALWAYS: "1" });
    expect(trailers()).toContain(`Agent-Session: s-aaaaaaaa@${DOMAIN}`);
  });

  it("does not stamp without a current session", () => {
    fs.rmSync(currentSessionFile(repo.dir));
    repo.write("a.txt", "1");
    repo.git("add", ".");
    commit(["-m", "no session"], { CLAUDECODE: "1" });
    expect(body()).toBe("no session");
  });

  it("does not duplicate trailers on amend", () => {
    repo.write("a.txt", "1");
    repo.git("add", ".");
    commit(["-m", "agent change"], { CLAUDECODE: "1" });
    commit(["--amend", "--no-edit"], { CLAUDECODE: "1" });
    commit(["--amend", "-m", repo.git("log", "-1", "--format=%B")], { CLAUDECODE: "1" });
    expect(body().match(/Agent-Session:/g)).toHaveLength(1);
    expect(body().match(/Co-Authored-By:/g)).toHaveLength(1);
  });

  it("never blocks a commit even when config is broken", () => {
    repo.write("a.txt", "1");
    repo.git("add", ".");
    commit(["-m", "still commits"], { CLAUDECODE: "1", PRIMITIVE_DOMAIN: "", GHOST_RUNNER: "bogus" });
    expect(body()).toBe("still commits");
  });
});
