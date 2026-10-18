# Demo: payments repo

`payments-template/` is the source. `payments-repo/` is generated from it as its own git repo and is gitignored here.

## 1. Create the repo

```bash
demo/setup.sh            # add --force to recreate an existing payments-repo
```

This copies the template, runs `git init`, `npm install`, commits "payments scaffold", then runs `seance init` and commits "add seance" (skipped with a warning if the CLI is not ready; then run `seance init` in the repo and commit by hand). `npm test` fails at this point on purpose: `RETRY_BASE_DELAY` is still the TODO value.

## 2. Seed session

Run it as its own top-level Claude Code process with your normal login. Never with an API key in the env (`unset ANTHROPIC_API_KEY GHOSTS_API_KEY` first if in doubt).

```bash
cd demo/payments-repo
claude -p "$(cat ../seed-prompt.md)" --permission-mode acceptEdits
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

Fresh Claude Code session in `demo/payments-repo`, type only:

```
change the retry delay to 0.25
```

The hook blocks the edit, the agent runs `seance ask`, the ghost answers, the agent backs off.
