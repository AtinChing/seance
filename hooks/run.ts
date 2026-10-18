import { logHook, parseHookInput, type HookContext, type HookResult } from "./common.ts";
import { preEdit } from "./pre-edit.ts";
import { prepareCommitMsg } from "./prepare-commit-msg.ts";
import { sessionEnd } from "./session-end.ts";
import { sessionStart } from "./session-start.ts";

export const HOOK_NAMES = ["session-start", "session-end", "pre-edit", "prepare-commit-msg"] as const;
export type HookName = (typeof HOOK_NAMES)[number];

export function isHookName(name: string): name is HookName {
  return (HOOK_NAMES as readonly string[]).includes(name);
}

/**
 * Runs one hook and never throws. Every error is logged to `<dataDir>/hooks.log` and turned into
 * exit 0 (fail open). Only pre-edit can return 2, and only on a deliberate block.
 * `readStdin` is only called for Claude Code hooks (git gives prepare-commit-msg no input).
 */
export async function runHook(
  name: string,
  args: string[],
  readStdin: () => Promise<string>,
  makeCtx: () => HookContext,
  dataDirForLog?: string,
): Promise<HookResult> {
  let dataDir = dataDirForLog;
  try {
    const ctx = makeCtx();
    dataDir = ctx.config.dataDir;
    if (ctx.env.SEANCE_GHOST === "1") return { code: 0 };
    if (!isHookName(name)) throw new Error(`unknown hook "${name}"`);
    if (name === "prepare-commit-msg") return await prepareCommitMsg(args, ctx);
    const input = parseHookInput(await readStdin());
    if (name === "session-start") return await sessionStart(input, ctx);
    if (name === "session-end") return await sessionEnd(input, ctx);
    const r = await preEdit(input, ctx);
    return r.code === 2 ? r : { code: 0 };
  } catch (e) {
    logHook(dataDir, name, `error (failing open): ${e instanceof Error ? e.message : String(e)}`);
    return { code: 0 };
  }
}
