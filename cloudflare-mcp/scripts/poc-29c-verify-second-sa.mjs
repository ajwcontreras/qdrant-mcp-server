#!/usr/bin/env node
/**
 * POC 29C: Verify second GCP service account can call Vertex gemini-embedding-001
 *
 * Proves: /Users/awilliamspcsevents/Downloads/underwriter-agent-479920-af2b45745dac.json
 * SA can JWT-exchange for an access token AND get a 1536-dim embedding back.
 * Required prerequisite for 29D round-robin.
 *
 * Pass criteria:
 *   - HTTP 200 from oauth2.googleapis.com/token
 *   - HTTP 200 from Vertex :predict
 *   - response.predictions[0].embeddings.values.length === 1536
 *   - all values are finite floats
 *
 * Run: node cloudflare-mcp/scripts/poc-29c-verify-second-sa.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";

const SA_PATH = "/Users/awilliamspcsevents/Downloads/underwriter-agent-479920-af2b45745dac.json";
const REGION = "us-central1";
const MODEL = "gemini-embedding-001";
const TEST_TEXT = "function hello(name) { return `Hello, ${name}`; }";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: sa.private_key_id };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const headerB64 = b64url(JSON.stringify(header));
  const claimB64 = b64url(JSON.stringify(claim));
  const signingInput = `${headerB64}.${claimB64}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  const sig = b64url(signer.sign(sa.private_key));
  const jwt = `${signingInput}.${sig}`;

  const r = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`token exchange failed: ${r.status} ${JSON.stringify(body)}`);
  return body.access_token;
}

async function main() {
  console.log("POC 29C: verify second SA Vertex access\n");
  const checks = {
    saLoaded: false,
    tokenExchange: false,
    vertexCall: false,
    embedding1536d: false,
    finiteValues: false,
  };
  const evidence = {
    sa_path: SA_PATH,
    project_id: null,
    client_email: null,
    embedding_length: null,
    sample_values: null,
  };

  try {
    const sa = JSON.parse(fs.readFileSync(SA_PATH, "utf8"));
    evidence.project_id = sa.project_id;
    evidence.client_email = sa.client_email;
    checks.saLoaded = !!sa.private_key && !!sa.client_email;
    console.log(`SA: ${sa.client_email}`);
    console.log(`Project: ${sa.project_id}`);

    const token = await getAccessToken(sa);
    checks.tokenExchange = !!token && token.length > 100;
    console.log(`Token: ${token.slice(0, 20)}... (length ${token.length})`);

    const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${sa.project_id}/locations/${REGION}/publishers/google/models/${MODEL}:predict`;
    const body = {
      instances: [{ content: TEST_TEXT, task_type: "RETRIEVAL_DOCUMENT" }],
      parameters: { autoTruncate: true, outputDimensionality: 1536 },
    };
    console.log(`POST ${url}`);
    const r = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await r.json();
    checks.vertexCall = r.ok;
    console.log(`status: ${r.status}`);
    if (!r.ok) {
      console.log(`error body: ${JSON.stringify(out).slice(0, 500)}`);
    } else {
      const values = out?.predictions?.[0]?.embeddings?.values;
      evidence.embedding_length = values?.length ?? null;
      evidence.sample_values = values?.slice(0, 3) ?? null;
      checks.embedding1536d = values?.length === 1536;
      checks.finiteValues = Array.isArray(values) && values.every(v => Number.isFinite(v));
      console.log(`embedding length: ${values?.length}`);
      console.log(`sample: ${JSON.stringify(values?.slice(0, 3))}`);
    }
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
  }

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  console.log(`\nevidence: ${JSON.stringify(evidence, null, 2)}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "PASS POC 29C" : "FAIL POC 29C — STOP, escalate to user before 29D"}`);

  // Save bench evidence file
  fs.writeFileSync(
    new URL("../poc/29a-baseline-bench/../29c-verify-second-sa/bench-29c.json", import.meta.url).pathname,
    JSON.stringify({ poc: "29c", checks, evidence, finished_at: new Date().toISOString() }, null, 2),
    "utf8",
  );
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
