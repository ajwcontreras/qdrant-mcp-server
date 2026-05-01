// Set a secret_text binding on a Workers for Platforms user worker via the
// multipart upload API. wrangler's `secret put` doesn't support
// `--dispatch-namespace` as of wrangler 4.87, so we go direct.
import fs from "node:fs";
import { loadCfEnv } from "./env.mjs";

/**
 * Upserts a secret_text binding on a user worker, preserving existing bindings.
 * Note: this requires re-uploading the script body. We fetch the existing
 * script content first, then re-PUT it with the updated bindings metadata.
 *
 * @param {object} opts
 * @param {string} opts.namespaceName  dispatch namespace
 * @param {string} opts.scriptName     user worker name
 * @param {string} opts.secretName     binding name (e.g. GEMINI_SERVICE_ACCOUNT_B64)
 * @param {string} opts.secretValue    plaintext value
 */
export async function setNamespaceWorkerSecret({ namespaceName, scriptName, secretName, secretValue }) {
  const env = loadCfEnv();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiKey = env.CLOUDFLARE_API_KEY;
  const email = env.CLOUDFLARE_EMAIL;
  if (!accountId || !apiKey || !email) throw new Error("CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_KEY, CLOUDFLARE_EMAIL required");

  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${encodeURIComponent(namespaceName)}/scripts/${encodeURIComponent(scriptName)}`;
  const headers = { "X-Auth-Email": email, "X-Auth-Key": apiKey };

  // 1. Fetch existing script content. Returns multipart/form-data; we extract the
  // first part's body as the JS source. The `cf-entrypoint` header tells us the
  // module entrypoint name (e.g. index.js).
  const contentRes = await fetch(`${base}/content`, { headers });
  if (!contentRes.ok) throw new Error(`fetch script content failed ${contentRes.status}: ${await contentRes.text()}`);
  const contentType = contentRes.headers.get("content-type") || "";
  const entrypoint = contentRes.headers.get("cf-entrypoint") || "worker.js";
  const fullBody = Buffer.from(await contentRes.arrayBuffer());
  let scriptBody;
  const boundaryMatch = contentType.match(/boundary=([^;]+)/);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1].trim();
    const sep = `--${boundary}`;
    const text = fullBody.toString("binary");
    // Find the first part that contains our entrypoint filename
    const parts = text.split(sep).slice(1, -1);
    const entryPart = parts.find(p => p.includes(`name="${entrypoint}"`)) || parts[0];
    if (!entryPart) throw new Error(`could not find entry part in multipart`);
    // Strip headers up to first \r\n\r\n
    const hdrEnd = entryPart.indexOf("\r\n\r\n");
    if (hdrEnd === -1) throw new Error("malformed part");
    const bodyStart = hdrEnd + 4;
    // Trailing \r\n before the next boundary marker
    const bodyEnd = entryPart.length - 2;
    scriptBody = Buffer.from(entryPart.slice(bodyStart, bodyEnd), "binary");
  } else {
    scriptBody = fullBody;
  }

  // 2. Construct multipart upload with new secret binding + keep_bindings to preserve everything else.
  const boundary = `----wfp${Date.now()}`;
  const metadata = {
    bindings: [
      { type: "secret_text", name: secretName, text: secretValue },
    ],
    // Preserve all other binding types we configured at deploy time:
    keep_bindings: ["plain_text", "secret_text", "kv_namespace", "r2_bucket", "d1", "vectorize", "queue", "durable_object_namespace", "service"],
  };

  const filename = entrypoint;
  metadata.main_module = filename;

  const parts = [];
  parts.push(`--${boundary}\r\n`);
  parts.push(`Content-Disposition: form-data; name="metadata"\r\n`);
  parts.push(`Content-Type: application/json\r\n\r\n`);
  parts.push(JSON.stringify(metadata));
  parts.push(`\r\n--${boundary}\r\n`);
  parts.push(`Content-Disposition: form-data; name="${filename}"; filename="${filename}"\r\n`);
  parts.push(`Content-Type: application/javascript+module\r\n\r\n`);

  const head = Buffer.from(parts.join(""), "utf8");
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([head, Buffer.from(scriptBody), tail]);

  const putRes = await fetch(base, {
    method: "PUT",
    headers: { ...headers, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const text = await putRes.text();
  if (!putRes.ok) throw new Error(`secret PUT failed ${putRes.status}: ${text.slice(0, 800)}`);
  return JSON.parse(text);
}
