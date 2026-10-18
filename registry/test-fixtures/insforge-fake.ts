/**
 * In-memory fake of the slice of the InsForge REST API the registry uses, as a fetch function.
 * Records: PostgREST-style eq./ilike. filters, order, limit/offset, on_conflict + merge-duplicates upserts.
 * Storage: upload-strategy / download-strategy (direct or presigned), PUT/GET/DELETE objects, list by prefix.
 */
export interface FakeCall {
  method: string;
  url: URL;
  headers: Headers;
}

import { SCHEMA } from "../insforge-setup.ts";

export interface FakeInsForge {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  tables: Record<string, Record<string, unknown>[]>;
  objects: Map<string, Uint8Array>; // "<bucket>/<key>"
  calls: FakeCall[];
  /** Make every request to paths matching this hang until aborted. */
  hang?: RegExp;
  mode: "direct" | "presigned";
  buckets: { name: string; public: boolean }[];
  migrations: { version: string; name: string; sql: string }[];
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const err = (status: number, error: string, message: string, code?: string) => json(status, { error, message, statusCode: status, ...(code ? { code } : {}) });

const PK: Record<string, string> = { sessions: "session_id", questions: "id" };

function matches(row: Record<string, unknown>, params: URLSearchParams): boolean {
  for (const [k, v] of params) {
    if (["select", "order", "limit", "offset", "on_conflict"].includes(k)) continue;
    const dot = v.indexOf(".");
    const op = v.slice(0, dot);
    const val = v.slice(dot + 1);
    const cell = row[k];
    if (op === "eq" && String(cell) !== val) return false;
    if (op === "ilike" && String(cell ?? "").toLowerCase() !== val.toLowerCase()) return false;
    if (!["eq", "ilike"].includes(op)) throw new Error(`fake: unsupported filter ${k}=${v}`);
  }
  return true;
}

export function fakeInsForge(opts: { base?: string; apiKey?: string } = {}): FakeInsForge {
  const base = opts.base ?? "https://fake.insforge.test";
  const apiKey = opts.apiKey ?? "ik_test_key";
  const state: FakeInsForge = {
    tables: { sessions: [], questions: [] },
    objects: new Map(),
    calls: [],
    mode: "direct",
    buckets: [],
    migrations: [],
    fetch: async (input, init = {}) => {
      const url = new URL(input);
      const method = (init.method ?? "GET").toUpperCase();
      const headers = new Headers(init.headers);
      state.calls.push({ method, url, headers });

      if (state.hang?.test(url.pathname)) {
        return new Promise<Response>((_, reject) => {
          const sig = init.signal;
          sig?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      }

      // presigned S3 endpoints live on another host and must NOT get the bearer token
      if (url.host === "s3.fake.test") {
        if (headers.get("authorization")) return err(400, "BAD", "presigned request carried Authorization");
        if (method === "POST") {
          const form = init.body as FormData;
          const key = String(form.get("key"));
          const file = form.get("file") as Blob;
          state.objects.set(key, new Uint8Array(await file.arrayBuffer()));
          return new Response(null, { status: 204 });
        }
        const key = decodeURIComponent(url.pathname.slice(1));
        const data = state.objects.get(key);
        return data ? new Response(new Uint8Array(data), { status: 200 }) : new Response("NoSuchKey", { status: 404 });
      }

      if (url.origin !== base) return err(404, "NOT_FOUND", `unknown host ${url.origin}`);
      if (headers.get("authorization") !== `Bearer ${apiKey}`) return err(401, "UNAUTHORIZED", "bad key");

      const p = url.pathname;
      let m: RegExpMatchArray | null;

      if ((m = p.match(/^\/api\/database\/records\/([a-z_]+)$/))) {
        const table = m[1];
        const rows = state.tables[table];
        if (!rows) return err(404, "TABLE_NOT_FOUND", `Table '${table}' does not exist`);
        const params = url.searchParams;
        if (method === "GET") {
          let out = rows.filter((r) => matches(r, params));
          const order = params.get("order");
          if (order) {
            const [col, dir] = order.split(".");
            out = [...out].sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (dir === "desc" ? -1 : 1));
          }
          const offset = Number(params.get("offset") ?? 0);
          const limit = Number(params.get("limit") ?? 100);
          return json(200, out.slice(offset, offset + limit).map((r) => structuredClone(r)));
        }
        if (method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>[];
          if (!Array.isArray(body)) return err(400, "VALIDATION_ERROR", "body must be an array");
          const pk = PK[table];
          const merge = (headers.get("prefer") ?? "").includes("resolution=merge-duplicates");
          const onConflict = params.get("on_conflict");
          for (const row of body) {
            const existing = rows.find((r) => r[pk] === row[pk]);
            if (existing) {
              if (!merge || onConflict !== pk) return err(409, "23505", 'duplicate key value violates unique constraint', "23505");
              Object.assign(existing, structuredClone(row));
            } else {
              const fresh: Record<string, unknown> = {};
              // unknown columns default to null, like Postgres
              for (const r of rows.slice(0, 1)) for (const k of Object.keys(r)) fresh[k] = null;
              rows.push(Object.assign(fresh, structuredClone(row)));
            }
          }
          return new Response(null, { status: 201 });
        }
        if (method === "PATCH") {
          const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
          const hit = rows.filter((r) => matches(r, params));
          for (const r of hit) Object.assign(r, structuredClone(patch));
          return json(200, hit.map((r) => structuredClone(r)));
        }
        if (method === "DELETE") {
          state.tables[table] = rows.filter((r) => !matches(r, params));
          return new Response(null, { status: 204 });
        }
      }

      // ---- admin: tables, migrations, buckets (for ensureSchema) ----
      if (p === "/api/database/tables" && method === "GET") return json(200, Object.keys(state.tables));
      if ((m = p.match(/^\/api\/database\/tables\/([a-z_]+)\/schema$/)) && method === "GET") {
        if (!state.tables[m[1]]) return err(404, "TABLE_NOT_FOUND", "no table");
        return json(200, { tableName: m[1], columns: (SCHEMA[m[1]] ?? []).map(([c]) => ({ columnName: c })) });
      }
      if (p === "/api/database/migrations" && method === "GET") return json(200, { migrations: state.migrations });
      if (p === "/api/database/migrations" && method === "POST") {
        const body = JSON.parse(String(init.body)) as { version: string; name: string; sql: string };
        if (!/^[a-z0-9-]+$/.test(body.name)) return err(400, "INVALID_INPUT", "Use lowercase letters, numbers, and hyphens only.");
        if (state.migrations.some((x) => BigInt(x.version) >= BigInt(body.version))) return err(409, "ALREADY_EXISTS", "Migration version already exists.");
        state.migrations.push(body);
        for (const t of Object.keys(SCHEMA)) state.tables[t] ??= [];
        return json(201, { ...body, message: "Migration executed successfully" });
      }
      if (p === "/api/storage/buckets" && method === "GET") return json(200, state.buckets);
      if (p === "/api/storage/buckets" && method === "POST") {
        const { bucketName, isPublic } = JSON.parse(String(init.body)) as { bucketName: string; isPublic?: boolean };
        if (state.buckets.some((b) => b.name === bucketName)) return err(409, "BUCKET_EXISTS", "exists");
        state.buckets.push({ name: bucketName, public: isPublic ?? true });
        return json(201, { bucketName });
      }
      if ((m = p.match(/^\/api\/storage\/buckets\/([A-Za-z0-9_-]+)$/)) && method === "PATCH") {
        const b = state.buckets.find((x) => x.name === m![1]);
        if (!b) return err(404, "BUCKET_NOT_FOUND", "no bucket");
        b.public = Boolean((JSON.parse(String(init.body)) as { isPublic: boolean }).isPublic);
        return json(200, { bucket: b.name, isPublic: b.public });
      }

      if ((m = p.match(/^\/api\/storage\/buckets\/([A-Za-z0-9_-]+)\/upload-strategy$/)) && method === "POST") {
        const { filename } = JSON.parse(String(init.body)) as { filename: string };
        if (state.mode === "presigned") {
          return json(200, {
            method: "presigned",
            uploadUrl: "https://s3.fake.test/",
            fields: { key: `${m[1]}/${filename}`, Policy: "x" },
            key: filename,
            confirmRequired: true,
            confirmUrl: `/api/storage/buckets/${m[1]}/objects/${encodeURIComponent(filename)}/confirm-upload`,
          });
        }
        return json(200, { method: "direct", uploadUrl: `/api/storage/buckets/${m[1]}/objects/${encodeURIComponent(filename)}`, key: filename, confirmRequired: false });
      }
      if ((m = p.match(/^\/api\/storage\/buckets\/([A-Za-z0-9_-]+)\/objects\/(.+)\/confirm-upload$/)) && method === "POST") {
        return json(200, { bucket: m[1], key: decodeURIComponent(m[2]) });
      }
      if ((m = p.match(/^\/api\/storage\/buckets\/([A-Za-z0-9_-]+)\/download-strategy\/objects\/(.+)$/)) && method === "GET") {
        const id = `${m[1]}/${decodeURIComponent(m[2])}`;
        if (!state.objects.has(id)) return err(404, "STORAGE_NOT_FOUND", "Object not found");
        if (state.mode === "presigned") return json(200, { method: "presigned", url: `https://s3.fake.test/${encodeURIComponent(id)}` });
        return json(200, { method: "direct", url: `${base}/api/storage/buckets/${m[1]}/objects/${m[2]}` });
      }
      if ((m = p.match(/^\/api\/storage\/buckets\/([A-Za-z0-9_-]+)\/objects$/)) && method === "GET") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const data = [...state.objects.entries()]
          .filter(([k]) => k.startsWith(`${m![1]}/${prefix}`))
          .map(([k, v]) => ({ bucket: m![1], key: k.slice(m![1].length + 1), size: v.byteLength }));
        return json(200, { data, pagination: { offset: 0, limit: 100, total: data.length } });
      }
      if ((m = p.match(/^\/api\/storage\/buckets\/([A-Za-z0-9_-]+)\/objects\/(.+)$/))) {
        const id = `${m[1]}/${decodeURIComponent(m[2])}`;
        if (method === "PUT") {
          const form = init.body as FormData;
          const file = form.get("file") as Blob | null;
          if (!file) return err(400, "INVALID_FILE", "No file provided in the request");
          const data = new Uint8Array(await file.arrayBuffer());
          state.objects.set(id, data);
          return json(200, { bucket: m[1], key: decodeURIComponent(m[2]), size: data.byteLength });
        }
        if (method === "GET") {
          const data = state.objects.get(id);
          return data ? new Response(new Uint8Array(data), { status: 200 }) : err(404, "OBJECT_NOT_FOUND", "not found");
        }
        if (method === "DELETE") {
          if (!state.objects.delete(id)) return err(404, "OBJECT_NOT_FOUND", "not found");
          return json(200, { message: "Object deleted successfully" });
        }
      }
      return err(404, "NOT_FOUND", `fake: no route ${method} ${p}`);
    },
  };
  return state;
}
