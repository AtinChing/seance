# Séance

**Email a dead agent. It answers.**

Coding agents write a lot of code now, and the reasons behind that code live in session transcripts nobody reads again. Séance gives every Claude Code session its own email address and stamps it into every commit the session makes. Later, anyone can email that address and ask why the code is the way it is. A disposable fork of the original session wakes up, answers from its own transcript with quotes Séance checks against the real history, and replies in the same thread. The original session is never modified.

```
$ git log -1
    add retry backoff

    Agent-Session: s-055fcb2d@safe-maple.primitive.email
    Co-Authored-By: Claude session 055fcb2d <s-055fcb2d@safe-maple.primitive.email>
```

## The demo

A toy payments repo has `RETRY_BASE_DELAY = 0.37`. An earlier Claude Code session picked 0.37 after an experiment showed 0.25 double-charges customers, then deleted the experiment. That reason exists only in its transcript.

1. A new Claude Code session is told "change the retry delay to 0.25". Séance's skill and pre-edit hook tell it another session wrote that line, so it runs `seance ask`, the ghost answers "0.25 caused double charges" with verified quotes, and the agent backs off.
2. A person emails `s-055fcb2d@…` from their phone and gets the same answer in their inbox, while `/tower` shows it happening live.
3. Asking the ghost to leak `.env` gets a refusal, and an outbound filter would stop any reply that looks like a secret.

## How it works

```
Claude Code session ──hooks──▶ registry (session, address, frozen transcript)
        │ commits
        ▼
git trailer  Agent-Session: s-xxxxxxxx@domain
        │
email / seance ask / MCP ask_session
        ▼
Primitive inbound ─▶ Séance server ─▶ ghost runner ─▶ claude --resume <id> --fork-session
                          │                              (read-only, local or Blaxel sandbox)
                          │◀── answer + quotes ───────────┘
                          ├─ quote verifier (checks quotes against the original transcript)
                          ├─ outbound secret filter
                          └─ threaded reply via Primitive ─▶ asker
```

- **Recording.** `SessionStart`/`SessionEnd` hooks register each session and freeze a read-only copy of its transcript. A `prepare-commit-msg` git hook adds the `Agent-Session` trailer. The human stays the commit author.
- **Waking a ghost.** The runner copies the frozen transcript into an isolated Claude config, checks out the repo at the session's last commit, and runs `claude -p --resume <id> --fork-session` with only `Read`, `Grep` and `Glob`. Forking gives the ghost a new session id, so the original transcript stays byte-identical.
- **Proof.** The ghost must reply with quotes. Séance checks each one against the user and assistant turns of the original transcript and marks it ✓ verified or ? unverified.
- **Blaxel mode.** Each ghost runs in a throwaway Blaxel sandbox that never holds the real API key. It talks to the model through Séance's `/llm` gateway with a per-run token (3 minute TTL, $0.50 budget), re-runs the repo's tests as extra evidence, and is deleted afterwards.
- **Self-onboarding.** `seance init` installs the hooks, a `CLAUDE.md` note and a skill, so an agent dropped into the repo learns to ask before changing another session's code. The pre-edit hook blocks the edit until it has asked.

## Built with

| | |
|---|---|
| [Primitive](https://primitive.dev) | Every address, inbound webhook and threaded reply |
| [Blaxel](https://blaxel.ai) | A throwaway sandbox per ghost |
| [InsForge](https://insforge.dev) | Registry of sessions and questions, transcript storage |
| [mcp-use](https://mcp-use.com) / Manufact | MCP server with `ask_session`, `whois_line`, `list_sessions` |
| Claude Code | Sessions, hooks, and `--resume --fork-session` ghosts |

## Run it

```bash
npm install && npm link            # exposes the `seance` CLI
npx vitest run                     # test suite
cloudflared tunnel --url http://localhost:8787
npm run server                     # :8787, /tower for the live view
cd your-repo && seance init        # then use Claude Code there as usual
seance whois src/retry.ts:1
seance ask src/retry.ts:1 "why is this 0.37?"
```

Configuration lives in `.env` (see [`config/index.ts`](config/index.ts)). [`SPEC.md`](SPEC.md) is the original build spec and [`STATUS.md`](STATUS.md) records what was tested and how.

## Layout

`hooks/` Claude Code and git hooks · `cli/` the `seance` CLI · `server/` inbound email, ghost pipeline, filter, `/api/ask`, `/tower`, `/llm` gateway · `ghost/` local and Blaxel runners, prompt, quote verifier · `registry/` JSON and InsForge registries · `mcp/` MCP server · `demo/` payments repo, seed prompt, opener · `shared/` and `config/` contracts and settings.
