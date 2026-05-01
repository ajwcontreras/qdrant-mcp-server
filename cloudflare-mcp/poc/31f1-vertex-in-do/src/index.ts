// POC 31F.1: Prove Vertex embedding works inside a Durable Object.
// One DO, one endpoint: POST /embed with { texts: [...] } → returns embeddings.
// No R2, no Vectorize, no fan-out, no fetchWithTimeout.

import { DurableObject } from "cloudflare:workers";

type Env = {
  EMBED_DO: DurableObjectNamespace;
  GEMINI_SERVICE_ACCOUNT_B64?: string;
  GOOGLE_PROJECT_ID?: string; GOOGLE_LOCATION?: string;
  GOOGLE_EMBEDDING_MODEL?: string; GOOGLE_EMBEDDING_DIMENSIONS?: string;
};

type GoogleSA = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

function json(v: unknown, s = 200) { return Response.json(v, { status: s, headers: { "content-type": "application/json" } }); }

const tokenCache = new Map<string, { token: string; exp: number }>();

async function signJwt(sa: GoogleSA, claims: Record<string, string | number>): Promise<string> {
  const b64u = (v: string | ArrayBuffer) => { const bytes = typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v); let b = ""; for (const x of bytes) b += String.fromCharCode(x); return btoa(b).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); };
  const input = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(JSON.stringify(claims))}`;
  const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const bin = atob(pem); const kb = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) kb[i] = bin.charCodeAt(i);
  const key = await crypto.subtle.importKey("pkcs8", kb.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${b64u(sig)}`;
}

async function saToken(sa: GoogleSA): Promise<string> {
  const now = Date.now(), c = tokenCache.get(sa.client_email);
  if (c && c.exp - 60_000 > now) return c.token;
  const iat = Math.floor(now / 1000);
  const jwt = await signJwt(sa, { iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: sa.token_uri || "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 });
  console.log("token: fetching for", sa.client_email);
  const r = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const raw = await r.text();
  console.log("token: status", r.status, "body_len", raw.length);
  if (!r.ok) throw new Error(`OAuth ${r.status}: ${raw.slice(0, 200)}`);
  const d = JSON.parse(raw) as { access_token?: string; expires_in?: number };
  if (!d.access_token) throw new Error("no access_token in response: " + JSON.stringify(d).slice(0, 200));
  tokenCache.set(sa.client_email, { token: d.access_token, exp: now + Math.max(60, d.expires_in || 3600) * 1000 });
  return d.access_token;
}

export class EmbedDO extends DurableObject<Env> {
  async embed(req: Request): Promise<Response> {
    const input = await req.json() as { texts?: string[] };
    if (!input.texts?.length) return json({ error: "texts required" }, 400);

    const b64 = this.env.GEMINI_SERVICE_ACCOUNT_B64;
    if (!b64) throw new Error("SA not configured");
    const sa = JSON.parse(atob(b64)) as Partial<GoogleSA>;
    if (!sa.client_email || !sa.private_key) throw new Error("invalid SA");

    const project = this.env.GOOGLE_PROJECT_ID || sa.project_id;
    if (!project) throw new Error("project_id required");
    const loc = this.env.GOOGLE_LOCATION || "us-central1";
    const model = this.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
    const dims = parseInt(this.env.GOOGLE_EMBEDDING_DIMENSIONS || "1536", 10);

    console.log("embed: calling Vertex", { project, loc, model, texts: input.texts.length });
    const token = await saToken(sa as GoogleSA);

    const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
    console.log("embed: POST", url.slice(0, 120));

    let raw = ""; let res: Response | undefined;
    for (let a = 0; a < 3; a++) {
      res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ instances: input.texts.map(t => ({ content: t, task_type: "RETRIEVAL_DOCUMENT" })), parameters: { autoTruncate: true, outputDimensionality: dims } }),
      });
      raw = await res.text();
      console.log("embed: attempt", a, "status", res.status, "len", raw.length);
      if (res.ok) break;
      if (res.status >= 500 || res.status === 429) { await new Promise(r => setTimeout(r, 500 * (a + 1))); continue; }
      throw new Error(`Vertex ${res.status}: ${raw.slice(0, 300)}`);
    }
    if (!res || !res.ok) throw new Error(`Vertex failed: ${raw.slice(0, 300)}`);

    const d = JSON.parse(raw) as { predictions?: Array<{ embeddings?: { values?: unknown } }> };
    const results = (d.predictions || []).map((p, i) => {
      const values = p.embeddings?.values;
      if (!Array.isArray(values)) throw new Error(`pred ${i} missing values`);
      const norm = Math.sqrt(values.reduce((s: number, x: number) => s + x * x, 0));
      return { dims: values.length, norm: Math.round(norm * 1000) / 1000, sample: (values as number[]).slice(0, 5) };
    });

    console.log("embed: done", { count: results.length, dims: results[0]?.dims });
    return json({ ok: true, results });
  }

  async fetch(req: Request): Promise<Response> {
    try {
      const u = new URL(req.url);
      if (u.pathname === "/embed" && req.method === "POST") return await this.embed(req);
      return json({ error: "not_found" }, 404);
    } catch (e: any) {
      return json({ ok: false, error: e?.message || String(e), stack: e?.stack?.slice(0, 300) }, 500);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const u = new URL(request.url);
    if (u.pathname === "/health") return json({ ok: true });
    if (u.pathname === "/embed" && request.method === "POST") {
      const stub = env.EMBED_DO.get(env.EMBED_DO.idFromName("e"));
      return await stub.fetch(new URL("/embed", request.url), { method: "POST", headers: { "content-type": "application/json" }, body: request.body! });
    }
    return json({ error: "not_found" }, 404);
  },
};
