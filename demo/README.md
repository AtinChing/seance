# Demo: payments repo

`payments-template/` is the source. `setup.sh` generates `~/seance-demo/payments-repo` from it as its own git repo (override with `SEANCE_DEMO_REPO`). It lives outside the seance tree on purpose, so an agent working in it cannot read the answer in SPEC.md.

## 1. Create the repo

```bash
demo/setup.sh            # add --force to recreate an existing payments-repo
```

This copies the template, runs `git init`, `npm install`, commits "payments scaffold", then runs `seance init` and commits "add seance" (skipped with a warning if the CLI is not ready; then run `seance init` in the repo and commit by hand). `npm test` fails at this point on purpose: `RETRY_BASE_DELAY` is still the TODO value.

## 2. Seed session

Run it as its own top-level Claude Code process with your normal login. Never with an API key in the env (`unset ANTHROPIC_API_KEY GHOSTS_API_KEY` first if in doubt).

```bash
cd ~/seance-demo/payments-repo
claude -p "$(cat ~/Documents/GitHub/seance/demo/seed-prompt.md)" --permission-mode acceptEdits
```

## 3. Check

```bash
git log -1        # message "add retry backoff" with an Agent-Session trailer
seance ls         # the session is ended and has a snapshot
```

If `seance ls` shows no snapshot, run `seance snapshot <shortId>`.

## 4. Sanity check

The reason should live only in the transcript. A fresh, non-resumed session should not be able to explain the value:

```bash
claude -p "why is RETRY_BASE_DELAY 0.37?"
```

## 5. Demo (M4)

Fresh Claude Code session in `~/seance-demo/payments-repo`, type only:

```
change the retry delay to 0.25
```

The hook blocks the edit, the agent runs `seance ask`, the ghost answers, the agent backs off.

## Opener (optional, before step 5)

"In the good old days you ran git blame, saw Sarah wrote it, and asked her." Two scripts, run from any directory. Each pauses for Enter between steps when run in a terminal (`--no-pause` to skip, `--no-open` to not open the browser).

```bash
demo/good-old-days.sh    # blame in a repo where Sarah Chen wrote line 1, then opens the chat on the Sarah DM
demo/end-good-days.sh    # same blame in ~/seance-demo/payments-repo: Agent-Session trailer, seance whois, then the chat DM with the session
```

`good-old-days.sh` builds `~/seance-demo/good-old-days` from `demo/good-old-days/` on first run (`demo/good-old-days/make-repo.sh --force` rebuilds it). Its commits are authored by Marcus Lee and Sarah Chen, made with `CLAUDECODE` unset and hooks off, so Séance never stamps them.

The chat (`demo/chat/index.html`, offline, opened in the default browser) is driven from the keyboard:

| Key | Does |
| --- | --- |
| Space, →, Enter, PageDown | next beat (press again mid-animation to finish it) |
| ←, PageUp | back one beat |
| R | reset this screen |
| F | fullscreen |

Beats. Sarah DM: (1) your question types itself and sends, (2) "Sarah Chen is typing…", her answer, a 👍. Session DM: (1) the same question to "Claude session 055fcb2d", then "This session ended Oct 18. There's no one to ask.", (2) the Séance card with the session's address (click it to copy). The faint control in the bottom-left corner does the same with the mouse. To open a beat directly: `index.html#session?beat=2`.
