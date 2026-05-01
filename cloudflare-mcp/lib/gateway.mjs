// Talk to the production cfcode gateway.
// One URL, one source of truth for which codebases are registered.
import { fetchJson } from "./http.mjs";

export const GATEWAY_URL = "https://cfcode-gateway.frosty-butterfly-d821.workers.dev";
export const NAMESPACE_NAME = "cfcode-codebases";
export const USER_WORKER_PREFIX = "cfcode-codebase-";

export function userWorkerNameFor(slug) { return `${USER_WORKER_PREFIX}${slug}`; }

export async function listCodebases() {
  const r = await fetchJson(`${GATEWAY_URL}/admin/codebases`);
  return r.codebases || [];
}

export async function registerCodebase(slug, indexedPath) {
  return fetchJson(`${GATEWAY_URL}/admin/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, indexed_path: indexedPath }),
  });
}

export async function unregisterCodebase(slug) {
  return fetchJson(`${GATEWAY_URL}/admin/register/${encodeURIComponent(slug)}`, { method: "DELETE" });
}

// Proxy an HTTP request through the gateway to the slug's user worker.
// Use for /ingest, /incremental-ingest, /jobs/:id/status, /git-state/:slug, etc.
export async function proxyToCodebase(slug, pathAndQuery, init = {}) {
  const url = `${GATEWAY_URL}/admin/codebases/${encodeURIComponent(slug)}${pathAndQuery}`;
  return fetchJson(url, init);
}
