import type { GhostResult, QuestionRecord, SessionId, SessionRecord, ShortId } from "./types.ts";

export interface Registry {
  upsertSession(s: SessionRecord): Promise<void>;
  getSessionByShortId(shortId: ShortId): Promise<SessionRecord | null>;
  listSessions(): Promise<SessionRecord[]>;
  saveTranscriptSnapshot(sessionId: SessionId, localPath: string): Promise<string>; // returns key or path
  loadTranscriptSnapshot(key: string): Promise<string>;                              // returns local path
  createQuestion(q: QuestionRecord): Promise<void>;
  updateQuestion(id: string, patch: Partial<QuestionRecord>): Promise<void>;
  getQuestionByThread(threadId: string): Promise<QuestionRecord | null>;
}

export interface GhostRunner {
  run(input: {
    session: SessionRecord;
    transcriptLocalPath: string;
    question: string;
    from: string;
    file?: string;
    line?: number;
  }): Promise<GhostResult>;
}

export interface Mailer {
  send(input: { from: string; to: string; subject: string; text: string; inReplyTo?: string; threadId?: string }): Promise<{ messageId: string; threadId: string }>;
}
