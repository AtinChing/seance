import { EventEmitter } from "node:events";
import type { SeanceEvent } from "../shared/types.ts";

/** In-process pub/sub for SeanceEvent. /events streams it; index.ts logs it. */
export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(event: SeanceEvent): void {
    this.emitter.emit("event", event);
  }

  /** Subscribe; returns an unsubscribe function. */
  on(listener: (event: SeanceEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  listenerCount(): number {
    return this.emitter.listenerCount("event");
  }
}

/** One-line, secret-free description of an event for the server log. */
export function describeEvent(e: SeanceEvent): string {
  switch (e.type) {
    case "email_in": return `email_in q=${e.questionId} from=${e.from} to=${e.to}`;
    case "ghost_waking": return `ghost_waking q=${e.questionId} runner=${e.runner}`;
    case "quotes_verified": return `quotes_verified q=${e.questionId} ${e.verified}/${e.total}`;
    case "reply_sent": return `reply_sent q=${e.questionId}`;
    case "reply_blocked": return `reply_blocked q=${e.questionId} reason=${e.reason}`;
    case "error": return `error${e.questionId ? ` q=${e.questionId}` : ""} ${e.message}`;
  }
}
