#!/usr/bin/env node
/**
 * POC 28A: Worker calls DeepSeek v4-pro for HyDE.
 *
 * Proves: from inside a Cloudflare Worker, DeepSeek returns 12 valid questions
 * in JSON for one source chunk in <5s. Second call demonstrates prompt cache hit.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/28a-worker-deepseek");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const workerName = "cfcode-poc-28a-worker-deepseek";

function loadCfEnv() {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  if (!fs.existsSync(cfKeysPath)) throw new Error(".cfapikeys missing");
  for (const line of fs.readFileSync(cfKeysPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    const v = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
    if (k.trim() === "CF_GLOBAL_API_KEY") env.CLOUDFLARE_API_KEY = v;
    if (k.trim() === "CF_EMAIL") env.CLOUDFLARE_EMAIL = v;
    if (k.trim() === "CF_ACCOUNT_ID") env.CLOUDFLARE_ACCOUNT_ID = v;
    if (k.trim() === "DEEPSEEK_API_KEY") env._DEEPSEEK_API_KEY = v;
  }
  return env;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || pocDir, env: opts.env || loadCfEnv(),
    encoding: "utf8", stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    input: opts.input,
  });
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

const SAMPLE_CHUNK = `# chat_history.py
import os, json, uuid, logging
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, current_app

chat_history_bp = Blueprint("chat_history", __name__)

@chat_history_bp.route("/chat/history/<chat_id>", methods=["GET"])
def get_history(chat_id):
    """Return the message list for a chat in chronological order.

    Returns 404 if the chat does not exist or the caller is not a member.
    """
    user = require_user(request)
    chat = ChatRepo(current_app).load(chat_id, user.id)
    if not chat:
        return jsonify({"error": "not found"}), 404
    return jsonify([m.to_dict() for m in chat.messages])
`;

async function main() {
  console.log("POC 28A: Worker calls DeepSeek v4-pro for HyDE\n");
  const checks = {
    secretSet: false,
    deployed: false,
    call1Ok: false,
    call1HasTwelve: false,
    call1Under10s: false,
    call2HasCacheHit: false,
    cleanedUp: false,
  };

  try {
    cleanup();

    console.log("--- Install + check + deploy ---");
    run("npm", ["install"], { capture: true });
    run("npm", ["run", "check"], { capture: true });
    const d = run("npx", ["wrangler", "deploy", "--config", "wrangler.jsonc"], { capture: true });
    const baseUrl = deployUrl(`${d.stdout}\n${d.stderr}`);
    checks.deployed = !!baseUrl;
    console.log(`Worker: ${baseUrl}`);

    console.log("\n--- Set DEEPSEEK_API_KEY secret ---");
    const env = loadCfEnv();
    if (!env._DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY not in .cfapikeys");
    const sec = spawnSync("npx", ["wrangler", "secret", "put", "DEEPSEEK_API_KEY", "--config", "wrangler.jsonc"], {
      cwd: pocDir, env: loadCfEnv(), input: env._DEEPSEEK_API_KEY, encoding: "utf8",
    });
    if (sec.status !== 0) throw new Error(`secret put failed:\n${sec.stdout}\n${sec.stderr}`);
    checks.secretSet = /uploaded|Success/i.test(`${sec.stdout}\n${sec.stderr}`);
    await waitHealth(baseUrl);

    console.log("\n--- Call 1: /hyde ---");
    const t1 = Date.now();
    const r1 = await fetch(`${baseUrl}/hyde`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: SAMPLE_CHUNK }),
    });
    const j1 = await r1.json();
    const elapsed1 = Date.now() - t1;
    console.log(`status=${r1.status} elapsed=${elapsed1}ms`);
    console.log(`questions: ${(j1.questions || []).length}`);
    if (j1.questions) j1.questions.slice(0, 3).forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
    console.log(`usage: ${JSON.stringify(j1.usage)}`);
    checks.call1Ok = j1.ok === true;
    checks.call1HasTwelve = (j1.questions || []).length === 12;
    checks.call1Under10s = elapsed1 < 10000;

    // Sleep a little so the server-side cache window is fresh
    await new Promise(r => setTimeout(r, 500));

    console.log("\n--- Call 2 (same system prompt, same chunk → cache hit expected) ---");
    const r2 = await fetch(`${baseUrl}/hyde`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: SAMPLE_CHUNK }),
    });
    const j2 = await r2.json();
    console.log(`usage: ${JSON.stringify(j2.usage)}`);
    const cacheHit = (j2.usage?.prompt_cache_hit_tokens || 0);
    console.log(`prompt_cache_hit_tokens: ${cacheHit}`);
    checks.call2HasCacheHit = cacheHit > 0;

  } finally {
    cleanup();
    checks.cleanedUp = true;
  }

  console.log("\n══ Pass Criteria ══");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v ? "PASS" : "FAIL"}`);
  const allPass = Object.values(checks).every(Boolean);
  console.log(`\n${allPass ? "✅ POC 28A: PASS" : "❌ POC 28A: FAIL"}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
