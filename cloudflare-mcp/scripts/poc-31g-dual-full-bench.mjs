#!/usr/bin/env node
// POC 31G: Full dual fan-out — code + hyde on alarm fan-out + R2-pull.
import { spawnSync } from "child_process"; import crypto from "crypto"; import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
const __dir = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(__dir, "../.."), poc = path.resolve(__dir, "../poc/31g-dual-full");
const T = "31g", wn = `cfcode-poc-${T}-dual`, dn = `cfcode-poc-${T}-dual`, r2b = `cfcode-poc-${T}-dual`, vi = `cfcode-poc-${T}-dual`;
const sa1 = "/Users/awilliamspcsevents/.config/cfcode/sas/team (1).json", sa2 = "/Users/awilliamspcsevents/.config/cfcode/sas/underwriter-agent-479920-af2b45745dac.json";
const luma = "/Users/awilliamspcsevents/PROJECTS/lumae-fresh", repoS = `lumae-bench-${T}`;

const env = { ...process.env }; delete env.CLOUDFLARE_API_TOKEN;
for (const l of fs.readFileSync(root + "/.cfapikeys", "utf8").split(/\r?\n/)) { const [k, ...r] = l.split("="); const v = r.join("=").trim(); if (k.trim() === "CF_GLOBAL_API_KEY") env.CLOUDFLARE_API_KEY = v; if (k.trim() === "CF_EMAIL") env.CLOUDFLARE_EMAIL = v; if (k.trim() === "DEEPSEEK_API_KEY") env._DS = v; }
function run(cmd, args, o = {}) { const R = spawnSync(cmd, args, { cwd: o.c || poc, env, encoding: "utf8", stdio: o.q ? ["ignore", "pipe", "pipe"] : "inherit", input: o.i }); if (R.status !== 0 && !o.ok) throw new Error(`${cmd} ${args.join(" ")} failed`); return R; }

function d1id() { const c = run("npx", ["wrangler", "d1", "create", dn], { q: 1, ok: 1 }); const m = (c.stdout + c.stderr).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); if (m) return m[0]; const l = run("npx", ["wrangler", "d1", "list", "--json"], { q: 1 }); return JSON.parse(l.stdout || "[]").find(d => d.name === dn).uuid; }
function tpl(d1id) { let t = fs.readFileSync(poc + "/wrangler.template.jsonc", "utf8"); t = t.replace("__WORKER_NAME__", wn).replace("__R2_BUCKET__", r2b).replace(/__D1_NAME__/g, dn).replace("__D1_ID__", d1id).replace("__VECTORIZE_INDEX__", vi); const o = poc + "/wrangler.gen.jsonc"; fs.writeFileSync(o, t); return o; }

function buildChunks() {
  const f = spawnSync("git", ["ls-files"], { cwd: luma, encoding: "utf8" }).stdout.trim().split("\n").filter(f => f && !/^(\.|node_modules|venv|__pycache__|dist|build)/.test(f) && !/\.(lock|map|min\.js|min\.css|woff2?|ttf|eot|ico|png|jpe?g|gif|svg|pdf|zip|tar|gz|pyc)$/i.test(f) && !f.includes("node_modules"));
  return f.map(rel => { try { const p2 = path.join(luma, rel), st = fs.statSync(p2); if (st.isDirectory() || st.size > 1e6) return null; let t = fs.readFileSync(p2, "utf8"); if (!t.trim()) return null; t = t.slice(0, 4000); return { chunk_id: "chunk-" + crypto.createHash("sha256").update(rel + ":0").digest("hex").slice(0, 16), repo_slug: repoS, file_path: rel, source_sha256: crypto.createHash("sha256").update(t).digest("hex"), text: t }; } catch { return null; } }).filter(Boolean);
}

async function main() {
  try { run("npx", ["wrangler", "delete", "--name", wn, "--force"], { q: 1, ok: 1 }); run("npx", ["wrangler", "vectorize", "delete", vi, "--force"], { q: 1, ok: 1 }); run("npx", ["wrangler", "r2", "bucket", "delete", r2b], { q: 1, ok: 1 }); run("npx", ["wrangler", "d1", "delete", dn, "--skip-confirmation"], { q: 1, ok: 1 }); } catch {}
  run("npx", ["wrangler", "r2", "bucket", "create", r2b], { q: 1, ok: 1 });
  run("npx", ["wrangler", "vectorize", "create", vi, "--dimensions=1536", "--metric=cosine"], { q: 1, ok: 1 });
  const id = d1id(), cp = tpl(id);
  const d = run("npx", ["wrangler", "deploy", "--config", cp], { q: 1 });
  const u = [...d.stdout.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, "")).find(u => u.includes(wn));
  if (!u) throw new Error("no URL"); console.log("Worker: " + u);
  const sa1b = Buffer.from(fs.readFileSync(sa1, "utf8")).toString("base64"), sa2b = Buffer.from(fs.readFileSync(sa2, "utf8")).toString("base64");
  for (const [k, v] of [["GEMINI_SERVICE_ACCOUNT_B64", sa1b], ["GEMINI_SERVICE_ACCOUNT_B64_2", sa2b], ["DEEPSEEK_API_KEY", env._DS]]) { if (spawnSync("npx", ["wrangler", "secret", "put", k, "--config", cp], { cwd: poc, env, input: v, encoding: "utf8" }).status !== 0) throw new Error("secret " + k + " failed"); }
  await new Promise(r => setTimeout(r, 3000));
  console.log("\n--- Build chunks ---"); const chunks = buildChunks(); console.log(chunks.length + " chunks");
  const ak = T + "/" + Date.now() + ".jsonl", at = chunks.map(c => JSON.stringify(c)).join("\n") + "\n", jid = "j" + T + "-" + Date.now();
  console.log("\n--- POST /ingest-sharded ---"); const t0 = Date.now();
  const ing = await (await fetch(u + "/ingest-sharded", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job_id: jid, repo_slug: repoS, indexed_path: luma, active_commit: T, artifact_key: ak, artifact_text: at, code_shard_count: 4, hyde_shard_count: 16, code_batch_size: 500, hyde_batch_size: 500, hyde: true }) })).json();
  console.log("response_ms=" + (Date.now() - t0) + " status=" + ing.status + " chunks=" + (ing.chunks || "?"));

  const dl = Date.now() + 300000; let job = null, codeLive = null, hydeLive = null;
  while (Date.now() < dl) { const r = await (await fetch(u + "/jobs/" + jid + "/status")).json(); if (r.ok && r.job) { job = r.job; const el = Date.now() - t0; if (!codeLive && (job.code_status === "live" || job.code_status === "partial")) codeLive = el; if (!hydeLive && (job.hyde_status === "live" || job.hyde_status === "partial")) hydeLive = el; process.stdout.write("\r  code=" + job.code_status + "/" + job.completed + "  hyde=" + job.hyde_status + "/" + job.hyde_completed + "  st=" + job.status + "  "); if (job.status !== "running") break; } await new Promise(r => setTimeout(r, 2000)); }
  console.log("");
  const pass = job && job.status === "published" && job.completed === chunks.length && job.hyde_completed >= chunks.length * 12 * 0.95;
  if (codeLive && hydeLive) console.log("decouple gap: " + ((hydeLive - codeLive) / 1000).toFixed(1) + "s");
  console.log((pass ? "PASS" : "FAIL") + " POC 31G");
  try { run("npx", ["wrangler", "delete", "--name", wn, "--force"], { q: 1, ok: 1 }); run("npx", ["wrangler", "vectorize", "delete", vi, "--force"], { q: 1, ok: 1 }); run("npx", ["wrangler", "r2", "bucket", "delete", r2b], { q: 1, ok: 1 }); run("npx", ["wrangler", "d1", "delete", dn, "--skip-confirmation"], { q: 1, ok: 1 }); } catch {}
  if (!pass) process.exit(1);
}
main().catch(e => { console.error(e.message); process.exit(1); });
