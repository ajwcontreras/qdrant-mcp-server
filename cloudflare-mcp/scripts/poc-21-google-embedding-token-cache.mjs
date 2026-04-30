#!/usr/bin/env node
/**
 * POC 21: Google Embedding Token Cache For Full Indexing
 *
 * Proves:
 *   Full-repo Google embedding runs can reuse one Vertex OAuth token across
 *   many gemini-embedding-001 one-input prediction calls.
 *
 * Pass criteria:
 *   - One OAuth token request serves all embedding calls.
 *   - Three embedding calls return numeric 1536-dimensional vectors.
 *   - The script prints timing/norm evidence and exits 0.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";

const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "/Users/awilliamspcsevents/Downloads/team (1).json";
const location = process.env.GOOGLE_LOCATION || "us-central1";
const model = process.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
const dimension = Number.parseInt(process.env.GOOGLE_EMBEDDING_DIMENSIONS || "1536", 10);
const taskType = process.env.GOOGLE_EMBEDDING_TASK_TYPE || "RETRIEVAL_DOCUMENT";

let tokenCache;
let tokenRequestCount = 0;

function base64Url(value) {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function loadServiceAccount() {
  const account = JSON.parse(await fs.readFile(serviceAccountPath, "utf8"));
  if (!account.client_email || !account.private_key || !account.project_id) {
    throw new Error(`Invalid service account: ${serviceAccountPath}`);
  }
  return account;
}

async function accessToken(account) {
  const nowMs = Date.now();
  if (tokenCache && tokenCache.expiresAt - 60_000 > nowMs) return tokenCache.token;

  tokenRequestCount += 1;
  const now = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: account.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), account.private_key);
  const assertion = `${signingInput}.${base64Url(signature)}`;
  const response = await fetch(account.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Google token request failed ${response.status}: ${raw.slice(0, 300)}`);
  const data = JSON.parse(raw);
  if (!data.access_token) throw new Error("Google token response did not include access_token");
  tokenCache = {
    token: data.access_token,
    expiresAt: nowMs + Math.max(60, data.expires_in || 3600) * 1000,
  };
  return tokenCache.token;
}

async function embed(account, content) {
  const token = await accessToken(account);
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
  const start = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      instances: [{ content, task_type: taskType }],
      parameters: { autoTruncate: true, outputDimensionality: dimension },
    }),
  });
  const raw = await response.text();
  const elapsedMs = Math.round(performance.now() - start);
  if (!response.ok) throw new Error(`Vertex embedding request failed ${response.status}: ${raw.slice(0, 500)}`);
  const values = JSON.parse(raw).predictions?.[0]?.embeddings?.values;
  if (!Array.isArray(values) || values.length !== dimension || !values.every((value) => typeof value === "number")) {
    throw new Error(`Invalid embedding values for ${model}`);
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return { elapsedMs, length: values.length, norm };
}

async function main() {
  console.log("POC 21: Google Embedding Token Cache For Full Indexing\n");
  const account = await loadServiceAccount();
  const inputs = [
    "Flask upload handler receives borrower files and stores document metadata.",
    "Rate limit storage options use Redis or memory fallback with fixed-window strategy.",
    "Chat workflow retrieves document context and assembles prompt messages.",
  ];
  const results = [];
  for (const input of inputs) {
    results.push(await embed(account, input));
  }

  const checks = {
    oneTokenRequest: tokenRequestCount === 1,
    threeEmbeddings: results.length === 3 && results.every((result) => result.length === dimension && Number.isFinite(result.norm) && result.norm > 0),
    timingEvidence: results.every((result) => Number.isFinite(result.elapsedMs) && result.elapsedMs > 0),
  };

  console.log(`Model: ${model}`);
  console.log(`Dimension: ${dimension}`);
  console.log(`Token requests: ${tokenRequestCount}`);
  results.forEach((result, index) => {
    console.log(`Embedding ${index + 1}: length=${result.length} norm=${result.norm.toFixed(6)} elapsed_ms=${result.elapsedMs}`);
  });

  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) {
    console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  }
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
