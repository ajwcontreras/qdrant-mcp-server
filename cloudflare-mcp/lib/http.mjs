// Strict JSON HTTP helpers + polling.
export async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!(res.headers.get("content-type") || "").includes("application/json")) {
    throw new Error(`${url} non-JSON ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

export async function fetchJsonOptional(url, init) {
  try { return await fetchJson(url, init); } catch { return null; }
}

export async function waitHealth(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const h = await fetchJson(`${baseUrl}/health`); if (h.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(`Worker ${baseUrl} not healthy in ${timeoutMs}ms`);
}

export async function pollPublished(baseUrl, jobId, { timeoutMs = 600_000, onProgress } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fetchJson(`${baseUrl}/jobs/${jobId}/status`);
    if (last.ok && last.job?.status === "published") return last;
    if (onProgress && last.ok) onProgress(last.job);
    if (last.ok && last.job?.failed > 0 && last.job?.completed + last.job?.failed >= last.job?.total) {
      throw new Error(`job has ${last.job.failed} failures and is stuck: ${JSON.stringify(last.job)}`);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`job not published in ${timeoutMs}ms: ${JSON.stringify(last)}`);
}
