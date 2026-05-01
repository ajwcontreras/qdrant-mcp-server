#!/usr/bin/env node
// POC 31I: Measure real CF rate limits — fetch concurrency + Vertex RPM
import { spawnSync } from "child_process"; import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
const __dir = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(__dir, "../.."), poc = path.resolve(__dir, "../poc/31i-rate-measure");
const wn = "cfcode-poc-31i-measure";
const env = { ...process.env }; delete env.CLOUDFLARE_API_TOKEN;
for (const l of fs.readFileSync(root + "/.cfapikeys", "utf8").split(/\r?\n/)) { const [k, ...r] = l.split("="); const v = r.join("=").trim(); if (k.trim() === "CF_GLOBAL_API_KEY") env.CLOUDFLARE_API_KEY = v; if (k.trim() === "CF_EMAIL") env.CLOUDFLARE_EMAIL = v; }
function run(cmd, args, o = {}) { const R = spawnSync(cmd, args, { cwd: o.c || poc, env, encoding: "utf8", stdio: o.q ? ["ignore", "pipe", "pipe"] : "inherit", input: o.i }); if (R.status !== 0 && !o.ok) throw new Error(`${cmd} ${args.join(" ")} failed`); return R; }

async function main() {
  try { run("npx", ["wrangler", "delete", "--name", wn, "--force"], { q: 1, ok: 1 }); } catch {}
  let t = fs.readFileSync(poc + "/wrangler.template.jsonc", "utf8").replace("__WORKER_NAME__", wn);
  const cp = poc + "/wrangler.gen.jsonc"; fs.writeFileSync(cp, t);
  const d = run("npx", ["wrangler", "deploy", "--config", cp], { q: 1 });
  const u = [...d.stdout.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, "")).find(u => u.includes(wn));
  if (!u) throw new Error("no URL"); console.log("Worker: " + u);

  // Test 1: fetch concurrency cap
  console.log("\n=== Test 1: Per-isolate fetch concurrency ===");
  for (const n of [6, 12, 24, 48]) {
    const r = await (await fetch(u + "/concurrency", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n }) })).json();
    console.log(`n=${n} wall=${r.wall_ms}ms batches=${JSON.stringify(r.batch_sizes)}`);
  }

  // Test 2: Vertex RPM (need SA secret)
  const saB64 = Buffer.from(fs.readFileSync("/Users/awilliamspcsevents/.config/cfcode/sas/team (1).json", "utf8")).toString("base64");
  if (spawnSync("npx", ["wrangler", "secret", "put", "GEMINI_SERVICE_ACCOUNT_B64", "--config", cp], { cwd: poc, env, input: saB64, encoding: "utf8" }).status !== 0) throw new Error("secret failed");
  await new Promise(r => setTimeout(r, 3000));

  console.log("\n=== Test 2: Vertex RPM per SA ===");
  for (const n of [5, 10, 20, 40]) {
    const r = await (await fetch(u + "/vertex-rpm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n }) })).json();
    console.log(`n=${n} wall=${r.wall_ms}ms ok=${r.ok} first_429=${r.first_429_at} statuses=${JSON.stringify(r.status_counts)}`);
  }

  try { run("npx", ["wrangler", "delete", "--name", wn, "--force"], { q: 1, ok: 1 }); } catch {}
}
main().catch(e => { console.error(e.message); process.exit(1); });
