type GoogleServiceAccount = {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
};

type Env = {
  GEMINI_SERVICE_ACCOUNT_B64?: string;
  GOOGLE_PROJECT_ID?: string;
  GOOGLE_LOCATION?: string;
  GOOGLE_EMBEDDING_MODEL?: string;
  GOOGLE_EMBEDDING_DIMENSIONS?: string;
  GOOGLE_EMBEDDING_TASK_TYPE?: string;
};

let tokenCache: { token: string; expiresAt: number } | undefined;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function intEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseServiceAccount(env: Env): GoogleServiceAccount {
  if (!env.GEMINI_SERVICE_ACCOUNT_B64) {
    throw new Error("GEMINI_SERVICE_ACCOUNT_B64 secret is required");
  }
  const account = JSON.parse(atob(env.GEMINI_SERVICE_ACCOUNT_B64)) as Partial<GoogleServiceAccount>;
  if (!account.client_email || !account.private_key) {
    throw new Error("GEMINI_SERVICE_ACCOUNT_B64 did not decode to a service account");
  }
  return {
    client_email: account.client_email,
    private_key: account.private_key,
    project_id: account.project_id,
    token_uri: account.token_uri,
  };
}

async function googleAccessToken(env: Env): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - 60_000 > now) return tokenCache.token;

  const account = parseServiceAccount(env);
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + 3600;
  const assertion = await signJwt(account, {
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: account.token_uri || "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: expiresAt,
  });
  const response = await fetch(account.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Google token request failed ${response.status}: ${raw.slice(0, 300)}`);
  const data = JSON.parse(raw) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Google token response did not include access_token");
  tokenCache = {
    token: data.access_token,
    expiresAt: now + Math.max(60, data.expires_in || 3600) * 1000,
  };
  return data.access_token;
}

async function signJwt(account: GoogleServiceAccount, claims: Record<string, string | number>): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64UrlEncode(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function embed(env: Env, content: string): Promise<number[]> {
  const account = parseServiceAccount(env);
  const project = env.GOOGLE_PROJECT_ID || account.project_id;
  if (!project) throw new Error("GOOGLE_PROJECT_ID or service account project_id is required");
  const location = env.GOOGLE_LOCATION || "us-central1";
  const model = env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
  const dimensions = intEnv(env.GOOGLE_EMBEDDING_DIMENSIONS, 1536);
  const taskType = env.GOOGLE_EMBEDDING_TASK_TYPE || "CODE_RETRIEVAL_QUERY";
  const token = await googleAccessToken(env);
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      instances: [{ content, task_type: taskType }],
      parameters: { autoTruncate: true, outputDimensionality: dimensions },
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Vertex embedding request failed ${response.status}: ${raw.slice(0, 500)}`);
  const data = JSON.parse(raw) as { predictions?: Array<{ embeddings?: { values?: unknown } }> };
  const values = data.predictions?.[0]?.embeddings?.values;
  if (!Array.isArray(values) || !values.every((value) => typeof value === "number")) {
    throw new Error("Vertex response did not include numeric embedding values");
  }
  return values;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "cfcode-poc-06-google-embedding",
        model: env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001",
        dimensions: intEnv(env.GOOGLE_EMBEDDING_DIMENSIONS, 1536),
      });
    }

    if (url.pathname === "/embed") {
      const input = request.method === "POST"
        ? await request.json().catch(() => ({})) as { text?: string }
        : {};
      const text = input.text || "Find the upload handler that stores borrower files and document metadata.";
      const values = await embed(env, text);
      const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
      return json({
        ok: true,
        length: values.length,
        sample: values.slice(0, 5),
        norm,
        model: env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001",
      });
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
