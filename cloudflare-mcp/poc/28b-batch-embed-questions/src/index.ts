// POC 28B: Worker batch-embeds 12 questions via Vertex in one :predict call.
type Env = {
  GEMINI_SERVICE_ACCOUNT_B64: string;
  GOOGLE_PROJECT_ID?: string;
  GOOGLE_LOCATION?: string;
  GOOGLE_EMBEDDING_MODEL?: string;
  GOOGLE_EMBEDDING_DIMENSIONS?: string;
};
type GoogleSA = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

let tokenCache: { token: string; expiresAt: number } | undefined;

function intEnv(v: string | undefined, d: number) { const n = Number.parseInt(v || "", 10); return Number.isFinite(n) ? n : d; }

function parseSA(env: Env): GoogleSA {
  const a = JSON.parse(atob(env.GEMINI_SERVICE_ACCOUNT_B64)) as Partial<GoogleSA>;
  if (!a.client_email || !a.private_key) throw new Error("invalid SA");
  return { client_email: a.client_email, private_key: a.private_key, project_id: a.project_id, token_uri: a.token_uri };
}

function pemToAB(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function b64url(v: string | ArrayBuffer): string {
  const bytes = typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signJwt(sa: GoogleSA, claims: Record<string, string | number>): Promise<string> {
  const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey("pkcs8", pemToAB(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${b64url(sig)}`;
}

async function googleToken(env: Env): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - 60_000 > now) return tokenCache.token;
  const sa = parseSA(env);
  const iat = Math.floor(now / 1000);
  const assertion = await signJwt(sa, { iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: sa.token_uri || "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 });
  const res = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`google token ${res.status}: ${raw.slice(0, 300)}`);
  const d = JSON.parse(raw) as { access_token?: string; expires_in?: number };
  tokenCache = { token: d.access_token!, expiresAt: now + Math.max(60, d.expires_in || 3600) * 1000 };
  return d.access_token!;
}

async function embedBatch(env: Env, texts: string[]): Promise<{ values: number[]; dims: number }[]> {
  const sa = parseSA(env);
  const project = env.GOOGLE_PROJECT_ID || sa.project_id;
  const location = env.GOOGLE_LOCATION || "us-central1";
  const model = env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
  const dims = intEnv(env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
  const token = await googleToken(env);
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project!)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
  const res = await fetch(url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      instances: texts.map(t => ({ content: t, task_type: "RETRIEVAL_DOCUMENT" })),
      parameters: { autoTruncate: true, outputDimensionality: dims },
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`vertex ${res.status}: ${raw.slice(0, 500)}`);
  const d = JSON.parse(raw) as { predictions: Array<{ embeddings: { values: number[] } }> };
  return d.predictions.map(p => ({ values: p.embeddings.values, dims: p.embeddings.values.length }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "28b-batch-embed" });
    if (url.pathname === "/embed-questions" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { questions?: string[] };
      if (!Array.isArray(body.questions) || body.questions.length === 0) {
        return Response.json({ ok: false, error: "questions[] required" }, { status: 400 });
      }
      try {
        const start = Date.now();
        const out = await embedBatch(env, body.questions);
        return Response.json({
          ok: true,
          ms: Date.now() - start,
          count: out.length,
          dims: out[0]?.dims,
          sample: out.slice(0, 2).map(o => ({ first5: o.values.slice(0, 5), len: o.values.length })),
        });
      } catch (e) {
        return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    }
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  },
};
