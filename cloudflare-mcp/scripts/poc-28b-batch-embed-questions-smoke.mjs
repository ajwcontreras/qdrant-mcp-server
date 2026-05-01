#!/usr/bin/env node
// POC 28B: Worker batch-embeds 12 questions in a single Vertex :predict call.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/28b-batch-embed-questions");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const saPath = "/Users/awilliamspcsevents/Downloads/team (1).json";
const workerName = "cfcode-poc-28b-batch-embed";

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

async function waitHealth(base) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error("not healthy");
}

function cleanup() {
  console.log("--- Cleanup ---");
  run("npx", ["wrangler", "delete", "--name", workerName, "--force"], { allowFailure: true, capture: true });
}

const QUESTIONS = [
  "how do we fetch chat history",
  "how is user membership in a chat checked",
  "what does the get_history endpoint return",
  "what is returned when a chat does not exist",
  "where is the chat blueprint defined",
  "how do we serialize chat messages",
  "where do we use ChatRepo to load a chat",
  "how is the require_user middleware applied",
  "what http method handles chat history fetch",
  "where is the chat_id route parameter declared",
  "how does the endpoint return 404",
  "what library is used to construct the JSON response",
];

async function main() {
  console.log("POC 28B: Worker batch-embeds 12 questions in one Vertex call\n");
  const checks = { deployed: false, secretSet: false, returns12: false, dimsCorrect: false, under3s: false, cleanedUp: false };

  try {
    cleanup();
    run("npm", ["install"], { capture: true });
    run("npm", ["run", "check"], { capture: true });
    const d = run("npx", ["wrangler", "deploy", "--config", "wrangler.jsonc"], { capture: true });
    const baseUrl = deployUrl(`${d.stdout}\n${d.stderr}`);
    checks.deployed = !!baseUrl;
    console.log(`Worker: ${baseUrl}`);

    if (!fs.existsSync(saPath)) throw new Error(`SA missing: ${saPath}`);
    const saB64 = Buffer.from(fs.readFileSync(saPath, "utf8")).toString("base64");
    const sec = spawnSync("npx", ["wrangler", "secret", "put", "GEMINI_SERVICE_ACCOUNT_B64", "--config", "wrangler.jsonc"],
      { cwd: pocDir, env: loadCfEnv(), input: saB64, encoding: "utf8" });
    if (sec.status !== 0) throw new Error(`secret put failed:\n${sec.stdout}\n${sec.stderr}`);
    checks.secretSet = true;
    await waitHealth(baseUrl);

    console.log("\n--- POST /embed-questions (12 questions) ---");
    const r = await fetch(`${baseUrl}/embed-questions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ questions: QUESTIONS }),
    });
    const j = await r.json();
    console.log(JSON.stringify(j, null, 2));
    checks.returns12 = j.ok === true && j.count === 12;
    checks.dimsCorrect = j.dims === 1536;
    checks.under3s = j.ms < 3000;
  } finally {
    cleanup();
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 28B: PASS" : "❌ POC 28B: FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
