export type SessionId = string;            // full Claude Code session UUID
export type ShortId = string;              // first 8 hex chars of SessionId

export interface SessionRecord {
  sessionId: SessionId;
  shortId: ShortId;
  address: string;                         // s-<shortId>@<PRIMITIVE_DOMAIN>
  repoPath: string;                        // absolute path of the repo the session worked in
  transcriptPath: string;                  // original JSONL path from the hook input
  transcriptSnapshot?: string;             // path or storage key of the frozen copy taken at session end
  startedAt: string;
  endedAt?: string;
}

export interface InboundEmail {
  messageId: string;
  threadId: string;                        // whatever Primitive gives for threading
  from: string;
  to: string;
  subject: string;
  text: string;
  receivedAt: string;
}

export interface Quote { text: string; verified: boolean; }

export interface GhostResult {
  answer: string;
  quotes: Quote[];
  confidence: "high" | "medium" | "low";
  runId: string;
  runner: "local" | "blaxel";
  durationMs: number;
  costUsd?: number;
  testOutput?: string;                     // blaxel mode: tail of the ghost's `npm test` re-run, shown as evidence
}

export interface QuestionRecord {
  id: string;
  sessionShortId: ShortId;
  from: string;
  question: string;
  file?: string;
  line?: number;
  threadId: string;
  status: "received" | "waking" | "answered" | "blocked" | "error";
  result?: GhostResult;
  blockedReason?: string;
  createdAt: string;
  answeredAt?: string;
}

export type SeanceEvent =
  | { type: "email_in"; questionId: string; from: string; to: string }
  | { type: "ghost_waking"; questionId: string; runner: string }
  | { type: "quotes_verified"; questionId: string; verified: number; total: number }
  | { type: "reply_sent"; questionId: string }
  | { type: "reply_blocked"; questionId: string; reason: string }
  | { type: "error"; questionId?: string; message: string };
