/** Sliding-window rate limits: 5/min per sender, 30/hour global (spec 6.3). */

export interface RateLimitOptions {
  perSender?: number;
  perSenderWindowMs?: number;
  global?: number;
  globalWindowMs?: number;
}

export type RateDecision =
  | { ok: true }
  | { ok: false; scope: "sender" | "global"; notify: boolean };

export class RateLimiter {
  private perSender: number;
  private perSenderWindowMs: number;
  private global: number;
  private globalWindowMs: number;
  private senderHits = new Map<string, number[]>();
  private globalHits: number[] = [];
  /** key -> time we last told them they were over the limit. */
  private notified = new Map<string, number>();

  constructor(o: RateLimitOptions = {}) {
    this.perSender = o.perSender ?? 5;
    this.perSenderWindowMs = o.perSenderWindowMs ?? 60_000;
    this.global = o.global ?? 30;
    this.globalWindowMs = o.globalWindowMs ?? 3_600_000;
  }

  /** Records the hit when allowed. Over limit: notify is true once per window per key. */
  check(sender: string, now: number): RateDecision {
    const key = sender.toLowerCase();
    const mine = (this.senderHits.get(key) ?? []).filter((t) => t > now - this.perSenderWindowMs);
    this.globalHits = this.globalHits.filter((t) => t > now - this.globalWindowMs);
    this.senderHits.set(key, mine);

    if (mine.length >= this.perSender) return { ok: false, scope: "sender", notify: this.shouldNotify(`s:${key}`, now, this.perSenderWindowMs) };
    if (this.globalHits.length >= this.global) return { ok: false, scope: "global", notify: this.shouldNotify(`g:${key}`, now, this.globalWindowMs) };

    mine.push(now);
    this.globalHits.push(now);
    return { ok: true };
  }

  private shouldNotify(key: string, now: number, windowMs: number): boolean {
    const last = this.notified.get(key);
    if (last !== undefined && last > now - windowMs) return false;
    this.notified.set(key, now);
    return true;
  }
}

/** Remembers keys for a window; `first(key)` is true only once per window. Used for once-only notices. */
export class OnceWithin {
  private seen = new Map<string, number>();
  constructor(private windowMs: number) {}
  first(key: string, now: number): boolean {
    const last = this.seen.get(key);
    if (last !== undefined && last > now - this.windowMs) return false;
    this.seen.set(key, now);
    return true;
  }
}

/** Bounded set for dedupe (drops oldest past `max`). */
export class BoundedSet {
  private set = new Set<string>();
  constructor(private max = 5000) {}
  has(k: string): boolean { return this.set.has(k); }
  add(k: string): void {
    this.set.add(k);
    if (this.set.size > this.max) {
      const oldest = this.set.values().next().value;
      if (oldest !== undefined) this.set.delete(oldest);
    }
  }
}
