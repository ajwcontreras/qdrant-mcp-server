// POC 31I: Measure actual CF rate limits empirically.
// Tests: 1) Per-isolate per-origin fetch concurrency cap
//        2) Vertex RPM per SA  
// No assumptions — just measure.

import { DurableObject } from "cloudflare:workers";

type Env = {
  TEST_DO: DurableObjectNamespace;
  GEMINI_SERVICE_ACCOUNT_B64?: string;
  DEEPSEEK_API_KEY?: string;
  GOOGLE_PROJECT_ID?: string; GOOGLE_LOCATION?: string;
};

type GoogleSA = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

function json(v: unknown, s = 200) { return Response.json(v, { status: s, headers: { "content-type": "application/json" } }); }

async function signJwt(sa: GoogleSA, claims: Record<string, string | number>): Promise<string> {
  const b64u = (v: string | ArrayBuffer) => { const bytes = typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v); let b = ""; for (const x of bytes) b += String.fromCharCode(x); return btoa(b).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); };
  const input = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(JSON.stringify(claims))}`;
  const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const bin = atob(pem); const kb = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) kb[i] = bin.charCodeAt(i);
  const key = await crypto.subtle.importKey("pkcs8", kb.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return `${input}.${b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)))}`;
}

async function saToken(sa: GoogleSA): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const jwt = await signJwt(sa, { iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: sa.token_uri || "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 });
  const r = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  const d = JSON.parse(await r.text()) as { access_token?: string };
  if (!d.access_token) throw new Error("no token");
  return d.access_token;
}

// ── Test 1: Measure per-isolate fetch concurrency ──
// Fire N parallel fetch() to a test endpoint (httpbin.org/delay/1) and see
// how many complete in parallel vs queue. The CF cap is ~6.
export class TestDO extends DurableObject<Env> {
  async fetchConcurrency(req: Request): Promise<Response> {
    const t0 = Date.now();
    const n = ((await req.json() as { n?: number }).n) ?? 12;
    
    const results = await Promise.allSettled(
      Array.from({ length: n }, async (_, i) => {
        const s = Date.now();
        try {
          const r = await fetch("https://www.google.com/generate_204", { method: "GET" });
          await r.text();
        } catch (e: any) {
          return { i, error: e?.message, ms: Date.now() - s };
        }
        return { i, ms: Date.now() - s };
      })
    );

    const timings = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return { i, error: "rejected" };
    });

    // Batch detection: group by completion time within 200ms
    const completes: any[] = timings.filter((t: any) => typeof t.ms === "number").sort((a: any, b: any) => a.ms - b.ms);
    const batches: number[][] = [];
    for (const t of completes) {
      const last = batches[batches.length - 1];
      if (!last || t.ms - last[0] > 500) batches.push([t.ms]);
      else last.push(t.ms);
    }

    const wall = Date.now() - t0;
    return json({ ok: true, n, wall_ms: wall, batch_sizes: batches.map(b => b.length) });
  }

  async vertexRpm(req: Request): Promise<Response> {
    const t0 = Date.now();
    const input = await req.json() as { n?: number };
    const n = input.n ?? 20;

    const b64 = this.env.GEMINI_SERVICE_ACCOUNT_B64;
    if (!b64) throw new Error("SA not configured");
    const sa = JSON.parse(atob(b64)) as Partial<GoogleSA>;
    if (!sa.client_email || !sa.private_key) throw new Error("invalid SA");

    const token = await saToken(sa as GoogleSA);
    const project = this.env.GOOGLE_PROJECT_ID || sa.project_id;
    const loc = this.env.GOOGLE_LOCATION || "us-central1";
    const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project!)}/locations/${encodeURIComponent(loc)}/publishers/google/models/gemini-embedding-001:predict`;
    const body = JSON.stringify({ instances: [{ content: "test", task_type: "RETRIEVAL_DOCUMENT" }], parameters: { autoTruncate: true, outputDimensionality: 1 } });

    const results = await Promise.allSettled(
      Array.from({ length: n }, async (_, i) => {
        const t1 = Date.now();
        const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body });
        const status = r.status;
        await r.text();
        return { i, status, ms: Date.now() - t1 };
      })
    );

    const codes: Record<number, number> = {};
    let firstErr = 0, ok = 0;
    for (const r of results) {
      if (r.status === "fulfilled") {
        codes[r.value.status] = (codes[r.value.status] || 0) + 1;
        if (r.value.status === 429) { if (!firstErr) firstErr = r.value.i; }
        else if (r.value.status === 200) ok++;
      }
    }

    return json({ 
      n, wall_ms: Date.now() - t0, 
      ok, first_429_at: firstErr > 0 ? firstErr : null,
      status_counts: codes,
    });
  }

  async deepseekRpm(req: Request): Promise<Response> {
    const t0 = Date.now();
    const n = ((await req.json() as { n?: number }).n) ?? 6;
    if (!this.env.DEEPSEEK_API_KEY) throw new Error("DS key missing");

    // Fire N parallel DeepSeek calls, measure per-call timing
    const results = await Promise.allSettled(
      Array.from({ length: n }, async (_, i) => {
        const s = Date.now();
        try {
          const r = await fetch("https://api.deepseek.com/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${this.env.DEEPSEEK_API_KEY}` },
            body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "Say 'hi' in exactly one word." }], max_tokens: 4 }),
          });
          await r.text();
          return { i, status: r.status, ms: Date.now() - s };
        } catch (e: any) { return { i, error: e?.message?.slice(0, 100), ms: Date.now() - s }; }
      })
    );

    const timings = results
      .filter((r: any) => r.status === "fulfilled")
      .map((r: any) => r.value)
      .filter((v: any) => typeof v.ms === "number")
      .sort((a: any, b: any) => a.ms - b.ms);

    // Batch detection: gap > 300ms = new batch
    const batches: number[][] = [];
    for (const t of timings) {
      const last = batches[batches.length - 1];
      if (!last || t.ms - last[0] > 300) batches.push([t.ms]);
      else last.push(t.ms);
    }

    const errors = results.filter((r: any) => r.status === "rejected" || (r.value?.error));

    return json({
      n, wall_ms: Date.now() - t0,
      batch_sizes: batches.map(b => b.length),
      batch_windows: batches.map(b => ({ first: b[0], last: b[b.length - 1], spread: b[b.length - 1] - b[0] })),
      error_count: errors.length,
      min_ms: timings[0]?.ms, max_ms: timings[timings.length - 1]?.ms,
    });
  }

  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/concurrency" && req.method === "POST") return this.fetchConcurrency(req);
    if (u.pathname === "/vertex-rpm" && req.method === "POST") return this.vertexRpm(req);
    if (u.pathname === "/deepseek-rpm" && req.method === "POST") return this.deepseekRpm(req);
    return json({ error: "not_found" }, 404);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const u = new URL(request.url);
    if (u.pathname === "/health") return json({ ok: true });
    if (u.pathname === "/concurrency" && request.method === "POST") {
      const stub = env.TEST_DO.get(env.TEST_DO.idFromName("c"));
      return stub.fetch(new URL("/concurrency", request.url), { method: "POST", headers: { "content-type": "application/json" }, body: request.body! });
    }
    if (u.pathname === "/vertex-rpm" && request.method === "POST") {
      const stub = env.TEST_DO.get(env.TEST_DO.idFromName("v"));
      return stub.fetch(new URL("/vertex-rpm", request.url), { method: "POST", headers: { "content-type": "application/json" }, body: request.body! });
    }
    if (u.pathname === "/deepseek-rpm" && request.method === "POST") {
      const stub = env.TEST_DO.get(env.TEST_DO.idFromName("d"));
      return stub.fetch(new URL("/deepseek-rpm", request.url), { method: "POST", headers: { "content-type": "application/json" }, body: request.body! });
    }
    return json({ error: "not_found" }, 404);
  },
};
