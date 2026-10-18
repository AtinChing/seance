import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { askedMarkerPath, writeAskedMarker } from "./common.ts";
import { preEdit, rangesForOldString, touchedRanges } from "./pre-edit.ts";
import { DOMAIN, FakeRegistry, hookCtx, SESSION_A, SESSION_B, TempRepo, testConfig, tmpDir } from "./test-helpers.ts";

// Session "bbbbbbbb" wrote line 3 (the delay). A human wrote lines 1-2 and 4.
const HUMAN = "export function retry() {\n  const attempts = 3;\n";
let repo: TempRepo;
let ctx: ReturnType<typeof hookCtx>;

beforeEach(() => {
  repo = new TempRepo();
  repo.write("src/retry.ts", HUMAN + "  return attempts;\n}\n");
  repo.commit("human scaffold");
  repo.write("src/retry.ts", HUMAN + "  const RETRY_BASE_DELAY = 0.37;\n}\n");
  repo.commit("add retry backoff", "bbbbbbbb");
  ctx = hookCtx(repo.dir, new FakeRegistry(), testConfig(tmpDir("seance-data-")));
});

const file = () => path.join(repo.dir, "src/retry.ts");
const edit = (old_string: string, session = SESSION_A, extra: Record<string, unknown> = {}) =>
  preEdit({ session_id: session, cwd: repo.dir, tool_name: "Edit", tool_input: { file_path: file(), old_string, new_string: "x", ...extra } }, ctx);

describe("line ranges", () => {
  it("maps old_string to lines", () => {
    const c = "a\nb\nc\nb\n";
    expect(rangesForOldString(c, "b", false)).toEqual([[2, 2]]);
    expect(rangesForOldString(c, "b", true)).toEqual([[2, 2], [4, 4]]);
    expect(rangesForOldString(c, "b\nc\n", false)).toEqual([[2, 3]]);
    expect(rangesForOldString(c, "zzz", false)).toEqual([]);
    expect(touchedRanges("Write", {}, c)).toEqual([[1, 4]]);
    expect(touchedRanges("MultiEdit", { edits: [{ old_string: "a" }, { old_string: "c" }] }, c)).toEqual([[1, 1], [3, 3]]);
  });
});

describe("pre-edit", () => {
  it("blocks an edit to a line another session wrote, with the spec message", async () => {
    const r = await edit("0.37");
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      `Séance: lines 3-3 of src/retry.ts were written by session s-bbbbbbbb (s-bbbbbbbb@${DOMAIN}).\n` +
        "That session may know why this code is the way it is. Before changing it, run:\n" +
        '  seance ask src/retry.ts:3 "<your question about why it is this way>"\n' +
        "Then retry your edit.\n",
    );
  });

  it("allows the session's own lines", async () => {
    expect((await edit("0.37", SESSION_B)).code).toBe(0);
  });

  it("allows human-written lines", async () => {
    expect((await edit("const attempts = 3;")).code).toBe(0);
  });

  it("allows when old_string is not found", async () => {
    expect((await edit("not in the file")).code).toBe(0);
  });

  it("allows new files and untracked files", async () => {
    const r1 = await preEdit({ session_id: SESSION_A, tool_name: "Write", tool_input: { file_path: path.join(repo.dir, "src/new.ts"), content: "x" } }, ctx);
    expect(r1.code).toBe(0);
    repo.write("src/untracked.ts", "x\n");
    const r2 = await preEdit({ session_id: SESSION_A, tool_name: "Write", tool_input: { file_path: path.join(repo.dir, "src/untracked.ts"), content: "y" } }, ctx);
    expect(r2.code).toBe(0);
  });

  it("allows files outside a git repo", async () => {
    const f = path.join(tmpDir("seance-nogit-"), "a.ts");
    fs.writeFileSync(f, "a\n");
    expect((await preEdit({ session_id: SESSION_A, tool_name: "Edit", tool_input: { file_path: f, old_string: "a" } }, ctx)).code).toBe(0);
  });

  it("allows after a fresh asked-marker, blocks again once it is stale", async () => {
    const p = writeAskedMarker(repo.dir, "bbbbbbbb", "src/retry.ts");
    expect(p).toBe(askedMarkerPath(repo.dir, "bbbbbbbb", "src/retry.ts"));
    expect((await edit("0.37")).code).toBe(0);
    const old = new Date(Date.now() - 31 * 60 * 1000);
    fs.utimesSync(p, old, old);
    expect((await edit("0.37")).code).toBe(2);
  });

  it("blocks MultiEdit when any edit touches another session's line", async () => {
    const r = await preEdit({ session_id: SESSION_A, tool_name: "MultiEdit", tool_input: { file_path: file(), edits: [{ old_string: "attempts = 3", new_string: "attempts = 4" }, { old_string: "0.37", new_string: "0.25" }] } }, ctx);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("lines 3-3 of src/retry.ts");
    const ok = await preEdit({ session_id: SESSION_A, tool_name: "MultiEdit", tool_input: { file_path: file(), edits: [{ old_string: "attempts = 3", new_string: "attempts = 4" }] } }, ctx);
    expect(ok.code).toBe(0);
  });

  it("treats Write over a tracked file as touching every line", async () => {
    const r = await preEdit({ session_id: SESSION_A, tool_name: "Write", tool_input: { file_path: file(), content: "new" } }, ctx);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("lines 3-3 of src/retry.ts");
  });

  it("ignores uncommitted lines and other tools", async () => {
    repo.write("src/retry.ts", HUMAN + "  const RETRY_BASE_DELAY = 0.5;\n}\n");
    expect((await edit("0.5")).code).toBe(0);
    expect((await preEdit({ session_id: SESSION_A, tool_name: "Read", tool_input: { file_path: file() } }, ctx)).code).toBe(0);
  });

  it("reports one range per session spanning its lines", async () => {
    repo.write("src/retry.ts", HUMAN + "  const RETRY_BASE_DELAY = 0.37;\n  const MAX = 9;\n}\n");
    repo.commit("more", "cccccccc");
    const r = await preEdit({ session_id: SESSION_A, tool_name: "Write", tool_input: { file_path: file(), content: "" } }, ctx);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("lines 3-3 of src/retry.ts were written by session s-bbbbbbbb");
    expect(r.stderr).toContain("lines 4-4 of src/retry.ts were written by session s-cccccccc");
  });
});
