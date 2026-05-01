#!/usr/bin/env node
// POC 28C: per-chunk consumer = HyDE + embed + upsert. End-to-end on 1 chunk.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/28c-consumer-pipeline");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const saPath = "/Users/awilliamspcsevents/Downloads/team (1).json";

const workerName = "cfcode-poc-28c-consumer";
const dbName = "cfcode-poc-28c";
const r2Bucket = "cfcode-poc-28c-artifacts";
const vecIndex = "cfcode-poc-28c-vec";
const queueName = "cfcode-poc-28c-work";
const dlqName = "cfcode-poc-28c-dlq";

function loadCfEnv() {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  for (const line of fs.readFileSync(cfKeysPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    const v = rest.join("=").trim();
    if (k.trim() === "CF_GLOBAL_API_KEY") env.CLOUDFLARE_API_KEY = v;
    if (k.trim() === "CF_EMAIL") env.CLOUDFLARE_EMAIL = v;
    if (k.trim() === "CF_ACCOUNT_ID") env.CLOUDFLARE_ACCOUNT_ID = v;
    if (k.trim() === "DEEPSEEK_API_KEY") env._DEEPSEEK_API_KEY = v;
  }
  return env;
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd || pocDir, env: opts.env || loadCfEnv(), encoding: "utf8", stdio: opts.capture ? ["ignore","pipe","pipe"] : "inherit", input: opts.input });
  if (r.status !== 0 && !opts.allowFailure) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r;
}
function deployUrl(out) {
  const urls = [...out.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, ""));
  return urls.find(u => u.includes(workerName)) || (() => { throw new Error(`no URL: ${out}`); })();
}
function ensureD1() {
  const c = run("npx", ["wrangler", "d1", "create", dbName], { capture: true, allowFailure: true });
  const out = `${c.stdout}\n${c.stderr}`;
  let m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (m) return m[0];
  const list = run("npx", ["wrangler", "d1", "list", "--json"], { capture: true });
  const dbs = JSON.parse(list.stdout || "[]");
  const f = dbs.find(d => d.name === dbName);
  if (!f) throw new Error(`could not find d1`);
  return f.uuid;
}
function writeConfig(d1Id) {
  const tpl = fs.readFileSync(path.join(pocDir, "wrangler.template.jsonc"), "utf8");
  fs.writeFileSync(path.join(pocDir, "wrangler.generated.jsonc"), tpl.replace("__D1_ID__", d1Id), "utf8");
}
async function fetchJson(url, init) { const r = await fetch(url, init); const t = await r.text(); return { status: r.status, body: JSON.parse(t) }; }
async function waitHealth(b) {
  const dl = Date.now() + 60_000;
  while (Date.now() < dl) {
    try { const r = await fetch(`${b}/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error("not healthy");
}
function cleanup() {
  console.log("--- Cleanup ---");
  run("npx", ["wrangler", "queues", "consumer", "remove", queueName, workerName], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "queues", "delete", queueName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "queues", "delete", dlqName, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "vectorize", "delete", vecIndex, "--force"], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "r2", "bucket", "delete", r2Bucket], { allowFailure: true, capture: true });
  run("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"], { allowFailure: true, capture: true });
}

const SAMPLE = `def get_history(chat_id):
    user = require_user(request)
    chat = ChatRepo(current_app).load(chat_id, user.id)
    if not chat:
        return jsonify({"error": "not found"}), 404
    return jsonify([m.to_dict() for m in chat.messages])`;

async function main() {
  console.log("POC 28C: queue consumer = HyDE + embed + upsert (1 chunk)\n");
  const checks = { resourcesReady: false, deployed: false, secretsSet: false, ingestQueued: false, totalRows13: false, codeRow1: false, hydeRows12: false, under30s: false, cleanedUp: false };

  try {
    cleanup();
    console.log("--- Resources ---");
    run("npx", ["wrangler", "queues", "create", dlqName], { capture: true });
    run("npx", ["wrangler", "queues", "create", queueName], { capture: true });
    run("npx", ["wrangler", "r2", "bucket", "create", r2Bucket], { capture: true });
    run("npx", ["wrangler", "vectorize", "create", vecIndex, "--dimensions=1536", "--metric=cosine"], { capture: true });
    const d1Id = ensureD1();
    writeConfig(d1Id);
    checks.resourcesReady = true;

    run("npm", ["install"], { capture: true });
    run("npm", ["run", "check"], { capture: true });
    const d = run("npx", ["wrangler", "deploy", "--config", "wrangler.generated.jsonc"], { capture: true });
    const baseUrl = deployUrl(`${d.stdout}\n${d.stderr}`);
    checks.deployed = !!baseUrl;
    console.log(`Worker: ${baseUrl}`);

    // Set both secrets
    const env = loadCfEnv();
    if (!env._DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY missing");
    const saB64 = Buffer.from(fs.readFileSync(saPath, "utf8")).toString("base64");
    for (const [name, val] of [["DEEPSEEK_API_KEY", env._DEEPSEEK_API_KEY], ["GEMINI_SERVICE_ACCOUNT_B64", saB64]]) {
      const sec = spawnSync("npx", ["wrangler", "secret", "put", name, "--config", "wrangler.generated.jsonc"],
        { cwd: pocDir, env: loadCfEnv(), input: val, encoding: "utf8" });
      if (sec.status !== 0) throw new Error(`secret ${name} failed: ${sec.stderr}`);
    }
    checks.secretsSet = true;
    await waitHealth(baseUrl);

    console.log("\n--- POST /ingest (1 chunk) ---");
    const chunkId = `chunk-${crypto.createHash("sha256").update("test:0").digest("hex").slice(0, 16)}`;
    const artifactKey = `test/${Date.now()}.jsonl`;
    const record = {
      chunk_id: chunkId, repo_slug: "test28c", file_path: "test.py",
      source_sha256: crypto.createHash("sha256").update(SAMPLE).digest("hex"),
      text: SAMPLE,
    };
    const t0 = Date.now();
    const ing = await fetchJson(`${baseUrl}/ingest`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: "j1", repo_slug: "test28c", artifact_key: artifactKey, artifact_text: JSON.stringify(record) + "\n" }),
    });
    checks.ingestQueued = ing.body.ok && ing.body.queued === 1;
    console.log(JSON.stringify(ing.body));

    console.log("\n--- Poll /count until 13 rows ---");
    let last;
    const dl = Date.now() + 90_000;
    while (Date.now() < dl) {
      const c = await fetchJson(`${baseUrl}/count`).catch(() => null);
      last = c?.body;
      process.stdout.write(`\r   total=${last?.total ?? 0} code=${last?.code ?? 0} hyde=${last?.hyde ?? 0}    `);
      if (last && last.total >= 13) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    process.stdout.write("\n");
    const elapsed = Date.now() - t0;
    console.log(`elapsed=${elapsed}ms`);
    checks.totalRows13 = last?.total === 13;
    checks.codeRow1 = last?.code === 1;
    checks.hydeRows12 = last?.hyde === 12;
    checks.under30s = elapsed < 30000;
  } finally {
    cleanup();
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 28C: PASS" : "❌ POC 28C: FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
