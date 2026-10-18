# Séance: status

_Last updated: 2026-10-18, M1 done (contracts and scaffold)._

## Milestones

| | Milestone | State |
|---|---|---|
| M0 | Probes | ✅ done (findings below) |
| M1 | Contracts and scaffold | ✅ done |
| M2 | Parallel build (A–E) | ⏳ in progress |
| M3 | Core end to end | not started |
| M4 | Hook self-onboarding | not started |
| M5 | Blaxel runner + gateway | not started (needs `bl` CLI, not installed) |
| M6 | InsForge registry | not started |
| M7 | MCP server | not started |
| M8 | Polish | not started |

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

## How to run (will grow as milestones land)
```bash
npm install && npm link          # exposes `seance`
npx vitest run                   # all tests
```
