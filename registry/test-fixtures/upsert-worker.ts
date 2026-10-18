// Child process used by the concurrency test: upserts `count` distinct sessions into the registry at argv[2].
import { JsonRegistry } from "../json.ts";

const [dataDir, worker, count] = process.argv.slice(2);
const reg = new JsonRegistry(dataDir);
const n = Number(count);
const writes = [];
for (let i = 0; i < n; i++) {
  const sessionId = `w${worker}-s${i}-0000-0000-000000000000`;
  writes.push(reg.upsertSession({
    sessionId,
    shortId: `w${worker}s${i}`.slice(0, 8),
    address: `s-${sessionId.slice(0, 8)}@test.local`,
    repoPath: "/tmp/repo",
    transcriptPath: `/tmp/${sessionId}.jsonl`,
    startedAt: new Date().toISOString(),
  }));
}
await Promise.all(writes);
