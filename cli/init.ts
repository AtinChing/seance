import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { SEANCE_ROOT } from "../config/index.ts";
import { repoRoot } from "../shared/git.ts";
import { CLI_COMMAND } from "../hooks/common.ts";

const run = promisify(execFile);

/** Marker line that identifies a git hook file written by Séance. */
export const GIT_HOOK_MARKER = "# seance-hook";

type HookGroup = { matcher?: string; hooks?: Array<{ type?: string; command?: string; [k: string]: unknown }>; [k: string]: unknown };

const WANTED: Array<{ event: string; name: string; matcher?: string }> = [
  { event: "SessionStart", name: "session-start" },
  { event: "SessionEnd", name: "session-end" },
  { event: "PreToolUse", name: "pre-edit", matcher: "Edit|MultiEdit|Write" },
];

/** Is this a hook command Séance installed for hook `name` (any install path)? */
export function isOurCommand(cmd: unknown, name: string): boolean {
  if (typeof cmd !== "string") return false;
  const re = new RegExp(`(seance|cli/bin\\.js"?)\\s+hook\\s+${name}(\\s|$)`);
  return re.test(cmd);
}

/** Merges Séance hooks into a parsed settings object in place. Returns human-readable changes. */
export function mergeSettings(settings: Record<string, unknown>, cmd: string = CLI_COMMAND): string[] {
  const changes: string[] = [];
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) settings.hooks = {};
  const hooks = settings.hooks as Record<string, HookGroup[]>;
  for (const w of WANTED) {
    const command = `${cmd} hook ${w.name}`;
    if (!Array.isArray(hooks[w.event])) hooks[w.event] = [];
    const groups = hooks[w.event];
    let found = false;
    for (const g of groups) {
      for (const h of g?.hooks ?? []) {
        if (!isOurCommand(h?.command, w.name)) continue;
        found = true;
        if (h.command !== command) {
          h.command = command;
          changes.push(`updated ${w.event} hook command`);
        }
        if (w.matcher && g.matcher !== w.matcher) {
          g.matcher = w.matcher;
          changes.push(`updated ${w.event} matcher to ${w.matcher}`);
        }
      }
    }
    if (!found) {
      const entry = [{ type: "command", command }];
      groups.push(w.matcher ? { matcher: w.matcher, hooks: entry } : { hooks: entry });
      changes.push(`added ${w.event} hook (seance hook ${w.name})`);
    }
  }
  return changes;
}

function writeIfChanged(file: string, content: string): "created" | "updated" | "unchanged" {
  const exists = fs.existsSync(file);
  if (exists && fs.readFileSync(file, "utf8") === content) return "unchanged";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return exists ? "updated" : "created";
}

function installSettings(repo: string, changes: string[]): void {
  const file = path.join(repo, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    if (text.trim()) {
      try {
        settings = JSON.parse(text);
      } catch (e) {
        throw new Error(`${file} is not valid JSON; fix it and re-run seance init (${(e as Error).message})`);
      }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`${file} is not a JSON object`);
    }
  }
  const c = mergeSettings(settings);
  if (c.length || !fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    changes.push(...c.map((x) => `.claude/settings.json: ${x}`));
  }
}

export function gitHookScript(root: string = SEANCE_ROOT): string {
  const bin = path.join(root, "cli", "bin.js").replace(/(["\\$`])/g, "\\$1");
  return [
    "#!/bin/sh",
    `${GIT_HOOK_MARKER}: installed by \`seance init\`. Stamps commits made by Claude Code sessions.`,
    "# A pre-existing hook is kept as prepare-commit-msg.local and runs first.",
    'LOCAL_HOOK="$(dirname "$0")/prepare-commit-msg.local"',
    'if [ -x "$LOCAL_HOOK" ]; then',
    '  "$LOCAL_HOOK" "$@" || exit $?',
    "fi",
    `node "${bin}" hook prepare-commit-msg "$@" || true`,
    "exit 0",
    "",
  ].join("\n");
}

async function hooksDir(repo: string): Promise<string> {
  try {
    const custom = (await run("git", ["-C", repo, "config", "--get", "core.hooksPath"])).stdout.trim();
    if (custom) return path.resolve(repo, custom);
  } catch {
    /* not set */
  }
  const p = (await run("git", ["-C", repo, "rev-parse", "--git-path", "hooks"])).stdout.trim();
  return path.resolve(repo, p);
}

async function installGitHook(repo: string, changes: string[]): Promise<void> {
  const dir = await hooksDir(repo);
  const file = path.join(dir, "prepare-commit-msg");
  const local = path.join(dir, "prepare-commit-msg.local");
  if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes(GIT_HOOK_MARKER)) {
    if (fs.existsSync(local)) {
      throw new Error(`${file} is not Séance's and ${local} already exists; merge them by hand, then re-run seance init`);
    }
    fs.renameSync(file, local);
    changes.push(`kept your existing git hook as ${path.relative(repo, local)} (Séance's hook runs it first)`);
  }
  const r = writeIfChanged(file, gitHookScript());
  fs.chmodSync(file, 0o755);
  if (r !== "unchanged") changes.push(`${r} git hook ${path.relative(repo, file)}`);
}

function ensureGitignore(repo: string, changes: string[]): void {
  const file = path.join(repo, ".gitignore");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const has = text.split(/\r?\n/).some((l) => [".seance", ".seance/", "/.seance", "/.seance/"].includes(l.trim()));
  if (has) return;
  fs.writeFileSync(file, text + (text && !text.endsWith("\n") ? "\n" : "") + ".seance/\n");
  changes.push(".gitignore: added .seance/");
}

export const CLAUDE_MD_HEADING = "## Séance";

export function claudeMdSection(cmd: string = CLI_COMMAND): string {
  return [
    CLAUDE_MD_HEADING,
    "",
    "Commits in this repo may carry an `Agent-Session: s-xxxxxxxx@…` trailer naming the Claude Code session that wrote them. That session can still be asked why.",
    "",
    "- `seance whois <file>:<line>` shows which session wrote a line.",
    '- `seance ask <file>:<line> "<question>"` asks that session and prints its answer with verified quotes (takes 30–90 s).',
    "- Before changing code another session wrote, when the reason for it is not obvious, ask first. See `.claude/skills/seance/SKILL.md`.",
    `- If \`seance\` is not on PATH, use \`${cmd}\` instead.`,
    "",
  ].join("\n");
}

function ensureClaudeMd(repo: string, changes: string[]): void {
  const file = path.join(repo, "CLAUDE.md");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (text.split(/\r?\n/).some((l) => l.trim() === CLAUDE_MD_HEADING)) return;
  const sep = !text ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(file, text + sep + claudeMdSection());
  changes.push(text ? "CLAUDE.md: appended Séance section" : "CLAUDE.md: created with Séance section");
}

export function skillMd(cmd: string = CLI_COMMAND): string {
  return `---
name: seance
description: Use before changing existing code in this repo that another Claude Code session wrote, when a Séance pre-edit hook blocks an edit, or when you need to know why a line is the way it is. Lets you ask the session that wrote a line, by email, and get its answer with verified quotes.
---

# Séance: ask the session that wrote the code

Commits in this repo may carry an \`Agent-Session: s-xxxxxxxx@…\` trailer. It names the Claude Code session that wrote those lines. That session is gone, but a disposable fork of it can still answer questions from its own transcript.

## Commands

- \`seance whois <file>:<line>\` shows which session wrote a line (address, commit, date), or says a human wrote it.
- \`seance ask <file>:<line> "<question>"\` emails that session and prints its answer, then its evidence: \`✓\` quotes were verified against the real transcript, \`?\` quotes could not be verified.
- \`seance ask s-xxxxxxxx@domain "<question>"\` asks a session by address.

\`seance ask\` takes about 30–90 seconds (up to 2 minutes). Run it with a Bash timeout of at least 150000 ms. If \`seance\` is not on PATH, use \`${cmd}\` in its place.

## When to use it

- Before changing code another session wrote when the reason for it is not obvious (odd constants, unusual ordering, a workaround with no comment), ask that session why first.
- If the pre-edit hook blocks your edit with a "Séance: lines … were written by session …" message, run the exact \`seance ask\` command it prints, with a real question about why the code is that way. Read the answer.
- Then tell the user what the ghost said, including any verified quotes, before deciding whether to make the change. If the answer gives a good reason not to change it, say so and ask the user how to proceed.
- After you have asked, the hook lets your next edit to that file through for 30 minutes.
`;
}

export interface InitResult {
  repo: string;
  changes: string[];
}

/** `seance init`: idempotently wire Séance into the repo containing `cwd`. */
export async function initRepo(cwd: string): Promise<InitResult> {
  const repo = await repoRoot(cwd);
  if (!repo) throw new Error(`not inside a git repository: ${cwd}`);
  const changes: string[] = [];
  installSettings(repo, changes);
  await installGitHook(repo, changes);
  ensureGitignore(repo, changes);
  ensureClaudeMd(repo, changes);
  const r = writeIfChanged(path.join(repo, ".claude", "skills", "seance", "SKILL.md"), skillMd());
  if (r !== "unchanged") changes.push(`${r} .claude/skills/seance/SKILL.md`);
  return { repo, changes };
}
