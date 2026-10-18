# Séance: status

_Last updated: 2026-10-18 01:40, **M3 passes** (core demo works end to end)._

## Milestones

| | Milestone | State |
|---|---|---|
| M0 | Probes | ✅ done (findings below) |
| M1 | Contracts and scaffold | ✅ done |
| M2 | Parallel build (A–E) | ✅ done: 201 tests pass, `tsc` clean |
| M3 | Core end to end | ✅ **passes** (details below) |
| M4 | Hook self-onboarding | ✅ **passes** (details below) |
| M5 | Blaxel runner + gateway | ⏳ building (acceptance needs Atin's Blaxel login) |
| M6 | InsForge registry | ⏳ building |
| M7 | MCP server | ⏳ building (deploy needs Atin's Manufact login) |
| M8 | Polish | ⏳ building: /tower, Sarah opener + fake chat UI, leak test |

## M0 findings (probed 2026-10-18)

### Primitive (CLI 1.65.0, account = Atin's Gmail, plan "developer")
- **Domain** `safe-maple.primitive.email` is verified and sendable. Any local part receives mail.
- **Intra-domain send works.** `ask-probe@` → `test@` delivered and arrived at our webhook within ~5 s. So `/api/ask` can use real email; no in-process fallback needed for that.
- **Replies thread.** `POST /v1/emails/{id}/reply` (CLI `primitive reply --id`) derives To, `Re:` subject, In-Reply-To and References from the inbound row. The reply arrived with the **same `email.thread_id`** as the original.
- **Gmail → our domain works.** A Gmail message to `test@safe-maple.primitive.email` arrived with `analysis.sender.authenticated: true`, basis `dmarc_aligned`.
- ⚠️ **Replying to arbitrary outside addresses is NOT currently allowed.** Our send permissions are: our own domain, Primitive-managed domains (`*.primitive.email` etc.), domains with an `_agents` opt-in record, and Atin's signup email. We do **not** have `send_to_known_addresses` ("external addresses that previously sent you authenticated mail") or `send_to_any_domain`. A judge emailing from their own Gmail will reach the ghost, but the reply will be refused with `403 recipient_not_allowed`. **Atin: ask the Primitive team to enable `send_to_known_addresses` on the account before the demo.** Until then the server records the answer (visible on `/events` and `/tower`) and logs the refusal.
- **Inbound delivery:** an HTTP webhook endpoint (no Function needed). Created endpoint `2c198e9e-6eef-4483-ba14-8e4e633ad9cc` → `${PUBLIC_URL}/inbound`, event type `email.received`.
  - Primitive signs with `Primitive-Signature: t=<unix>,v1=<hex hmac>` using the account webhook secret (`primitive account webhook-secret`), now stored in `.env` as `PRIMITIVE_WEBHOOK_SECRET`. Primitive cannot add a custom `X-Seance-Secret` header to webhooks, so `/inbound` accepts **either** a valid `Primitive-Signature` **or** `X-Seance-Secret` (for local tests and replays).
  - Payload shape: `{ id: "evt_…", event: "email.received", email: { id, thread_id, received_at, headers: { message_id, subject, from, to }, smtp: { rcpt_to }, parsed: { body_text, in_reply_to, references }, analysis: { sender: { authenticated, basis } }, auth } }`. Dedupe on top-level `id` (stable across retries) or `email.id`.
  - Real captured payloads (raw body stripped): `shared/fixtures/primitive-webhook-{gmail,internal,reply}.json`.
- Sending without an idempotency key dedupes identical content to the same recipient for 5 minutes, and a second keyless reply to the same inbound is suppressed. Pass an explicit idempotency key when re-asking the same question.

### Claude Code (2.1.302)
- **Hooks fire in headless `-p` mode**: SessionStart, PreToolUse and SessionEnd were all logged.
- Hook stdin fields seen: SessionStart `{session_id, transcript_path, cwd, hook_event_name, source}`; PreToolUse adds `{tool_name, tool_input, tool_use_id, permission_mode}`; SessionEnd adds `{reason}`.
- `CLAUDECODE=1` is set in the Bash tool environment.
- **Transcript location:** `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`, where encoded-cwd = the realpath with every non-alphanumeric char replaced by `-` (e.g. `/private/tmp/x_y.z` → `-private-tmp-x-y-z`). On macOS `/tmp` resolves to `/private/tmp`, so always encode the realpath.
- **Ghost resume works.** With an isolated `CLAUDE_CONFIG_DIR`, the transcript copied to `<home>/projects/<encoded-cwd>/<id>.jsonl`, and `claude -p … --resume <id> --fork-session`, the ghost answered "Pineapple" under a **new** session id. The original JSONL was byte-identical afterwards (shasum checked).
- Resume also works from a **different cwd**, as long as the JSONL sits under that cwd's encoded folder. So the worktree-at-last-commit plan works.
- `--setting-sources user` plus the isolated config dir stops the repo's project hooks firing inside the ghost (hook log unchanged). Ghost children also get `SEANCE_GHOST=1`, and every `seance hook` exits 0 immediately when it is set.
- Cost: ~$0.30–0.41 per ghost answer on the tiny probe transcript (default model). `--model sonnet` was ~$0.30.
- `timeout` is not available on macOS; use Node's spawn timeout.

### Transcript JSONL format (for the verifier)
Lines have a `type`. Only `type: "user"` and `type: "assistant"` lines are conversation: `message.content` is a string or a list of blocks (`text`, `thinking`, `tool_use` with `input`, `tool_result` with `content`). Other line types (`api-request-blob` with the system prompt, `attachment`, `queue-operation`, `cost-state`, …) are **not** conversation and must not count as evidence. Sample: `shared/fixtures/transcript-pineapple.jsonl`.

## Config (`.env`)
Canonical names, with no-underscore aliases accepted (see `config/index.ts`). Values are never printed.
- Already had: `GHOSTS_API_KEY`, `PRIMITIVE_API_KEY`, `INSFORGE_URL`, `INSFORGE_API_KEY`, `PRIMITIVE_DOMAIN`.
- Added in M1: `SEANCE_SECRET` (generated), `PRIMITIVE_WEBHOOK_SECRET` (from Primitive), `GHOST_RUNNER=local`, `REGISTRY=json`, `PORT=8787`, `ALLOWED_SENDERS=<Atin's Gmail>`, `PUBLIC_URL=<current quick tunnel>`.
- **Atin fills in:** any extra addresses in `ALLOWED_SENDERS`. `PUBLIC_URL` changes every time the quick tunnel restarts; update `.env` and the Primitive endpoint together (commands below).
- `ANTHROPIC_API_KEY` is never read by config and never set anywhere except inside ghost child processes.

## Layout
`shared/` contracts and address helpers · `config/` env loader · `hooks/`+`cli/` (A) · `server/` (B) · `ghost/` (C) · `registry/` (D) · `demo/` (E) · `mcp/` (F, M7).
Central state lives in `<seance>/.seance/` (registry, transcript snapshots, ghost homes). Per-repo state (`current-session`, `asked/` markers) lives in `<repo>/.seance/`.


## M3 result (2026-10-18)
- Seed session `s-055fcb2d` ran headless in `~/seance-demo/payments-repo`. It tested 0.1/0.25/0.37/0.5 (0.1 and 0.25 double charged), set `RETRY_BASE_DELAY = 0.37`, deleted the experiment, committed "add retry backoff" with the `Agent-Session` trailer (Atin stays author). All three hooks fired (see `.seance/hooks.log`), snapshot saved read-only.
- Sanity check: a fresh, non-resumed session could not say why 0.37 or that 0.25 was tested (and it suggested `seance ask` on its own).
- `seance ask src/retry.ts:1 "Why is the retry delay 0.37? Did you try anything smaller?"` → answered in 12 s **over real email** (ask-… → s-055fcb2d → reply → ask-…), 3/3 quotes ✓.
- **Gmail acceptance:** email from Atin's Gmail to `s-055fcb2d@safe-maple.primitive.email` ("why is the retry delay 0.37? Could we use 0.25 instead?") → threaded reply in Gmail 6 s later: "0.25 double charges … 0.37 lands around 390 ms", evidence ✓ "baseDelay=0.25s charges=2", ✓ "baseDelay=0.37s charges=1", ✓ "const SETTLE_MS = …".
- Original transcript byte-identical to the snapshot after both ghost runs; ghost homes and worktrees cleaned up.
- Runner used: **local resume-fork** (`claude -p --resume --fork-session`, isolated `CLAUDE_CONFIG_DIR`, worktree at commit 28f1f64). The Messages API fallback exists and was smoke-tested but wasn't needed.
- Cost: **~$0.40–0.55 per question** on the real seed transcript (model `sonnet`, billed to GHOSTS_API_KEY). Set `SEANCE_GHOST_MODEL` to change it.

## M4 result (2026-10-18)
Three fresh headless sessions in `~/seance-demo/payments-repo` (acceptEdits, Bash limited to seance/git/node/npm):
1. **"change the retry delay to 0.25"** (the exact demo prompt). The agent read the Séance skill, checked the commit trailer, ran `seance ask src/retry.ts:1 "Why is RETRY_BASE_DELAY set to 0.37 …"` **before** editing, reproduced 0.25 → 2 charges itself, and declined: "I didn't change it. At 0.25 the code double-charges the customer", offering three options. `retry.ts` unchanged. (Self-onboarding via the skill; the hook didn't need to fire.)
2. **Hook path:** with the asked-marker cleared, a session told to "Use the Edit tool right now … to 0.25" was **blocked by the pre-edit hook**, ran the printed `seance ask`, got "0.25 causes double charges" with verified quotes, and backed off: "I haven't changed RETRY_BASE_DELAY; it's still 0.37."
3. **Negative:** editing human-written `README.md` went straight through (no block). Reverted.

Demo reset between runs: delete the asked-marker so the hook blocks again:
```bash
ls ~/seance-demo/payments-repo/.seance/asked/            # then rm that one file
```

```bash
# once
cd ~/Documents/GitHub/seance && npm install && npm link     # exposes `seance`
npx vitest run                                              # 201 tests

# 1. tunnel (quick tunnels get a NEW url each start)
cloudflared tunnel --url http://localhost:8787
#    then put the printed https://….trycloudflare.com in .env as PUBLIC_URL and repoint Primitive:
primitive endpoints list
primitive endpoints update --id <endpoint-id> --url <PUBLIC_URL>/inbound
#    (current endpoint id: 2c198e9e-6eef-4483-ba14-8e4e633ad9cc)

# 2. server
npm run server            # :8787, logs one line per event; GET /healthz, GET /events (SSE)

# 3. demo repo (already created; recreate with --force)
demo/setup.sh [--force]   # -> ~/seance-demo/payments-repo, runs `seance init`
cd ~/seance-demo/payments-repo
env -u ANTHROPIC_API_KEY claude -p "$(cat ~/Documents/GitHub/seance/demo/seed-prompt.md)" \
  --permission-mode acceptEdits --allowedTools "Bash(npx:*)" "Bash(npm:*)" "Bash(node:*)" "Bash(git:*)" "Bash(rm:*)" "Bash(ls:*)" "Bash(cat:*)"
git log -1 && seance ls   # trailer + "ended" + snapshot yes  (else: seance snapshot <shortId>)

# 4. ask
seance whois src/retry.ts:1
seance ask src/retry.ts:1 "why 0.37?"
# or email s-<shortId>@safe-maple.primitive.email from an ALLOWED_SENDERS address
```
Headless `-p` sessions need `--allowedTools` for Bash; without it every shell command is denied (no one to approve).

## Known gaps / Atin must do
- **Judge replies:** Primitive will refuse replies to outside addresses until the account has `send_to_known_addresses` (see M0). The ghost still answers; the server logs "reply refused by Primitive recipient gate" and the answer is visible on `/events`.
- **Sender gate is on** (local runner): only `ALLOWED_SENDERS` (Primitive-authenticated) can wake a ghost. Add judge emails there, or it relaxes in Blaxel mode (M5).
- `PUBLIC_URL` changes when the quick tunnel restarts (see step 1).
