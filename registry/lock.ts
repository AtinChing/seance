import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

export interface LockOptions {
  /** Give up acquiring after this long. */
  timeoutMs?: number;
  /** A lock older than this is assumed abandoned (its holder crashed) and is taken over. */
  staleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 10000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cross-process mutex built on `mkdir` (atomic on every local filesystem).
 * The lock dir holds an `owner` file with a random token so a holder only ever removes its own lock.
 */
export async function withLock<T>(lockDir: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const token = await acquire(lockDir, opts);
  try {
    return await fn();
  } finally {
    await release(lockDir, token);
  }
}

async function acquire(lockDir: string, opts: LockOptions): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const token = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const deadline = Date.now() + timeoutMs;
  let delay = 5;

  for (;;) {
    try {
      await fs.mkdir(lockDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      await takeOverIfStale(lockDir, staleMs);
      if (Date.now() >= deadline) {
        throw new Error(`Séance registry: could not acquire lock ${lockDir} within ${timeoutMs} ms (another process holds it)`);
      }
      await sleep(delay + Math.random() * delay);
      delay = Math.min(delay * 2, 100);
      continue;
    }
    try {
      await fs.writeFile(`${lockDir}/owner`, token);
    } catch (err) {
      await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    return token;
  }
}

async function takeOverIfStale(lockDir: string, staleMs: number): Promise<void> {
  let st;
  try {
    st = await fs.stat(lockDir);
  } catch {
    return; // released meanwhile
  }
  if (Date.now() - st.mtimeMs < staleMs) return;

  // Rename aside atomically: if several processes race, only one rename succeeds.
  const aside = `${lockDir}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await fs.rename(lockDir, aside);
  } catch {
    return;
  }
  // Guard against the race where another process took over and re-locked between our stat and rename:
  // if what we moved is actually fresh, try to put it back.
  try {
    const moved = await fs.stat(aside);
    if (Date.now() - moved.mtimeMs < staleMs) {
      try {
        await fs.rename(aside, lockDir);
        return;
      } catch {
        /* lockDir re-created by someone else; fall through and discard */
      }
    }
  } catch {
    return;
  }
  console.warn(`[seance registry] took over stale lock ${lockDir} (older than ${staleMs} ms)`);
  await fs.rm(aside, { recursive: true, force: true }).catch(() => {});
}

async function release(lockDir: string, token: string): Promise<void> {
  try {
    const owner = await fs.readFile(`${lockDir}/owner`, "utf8");
    if (owner !== token) return; // our lock was taken over as stale; don't remove the new holder's
  } catch {
    return;
  }
  await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
}
