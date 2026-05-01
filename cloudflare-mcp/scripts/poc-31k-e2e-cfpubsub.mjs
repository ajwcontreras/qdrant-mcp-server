#!/usr/bin/env node
// POC 31K E2E: Index cfpubsub-scaffold with 31K dual fan-out. Streams poll to log.
import { spawnSync } from "child_process"; import crypto from "crypto"; import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
const __dir = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(__dir, "../.."), poc = path.resolve(__dir, "../poc/31k-2pop-fixed");
const T = "31k", wn = `cfcode-poc-${T}-2pop`, dn = `cfcode-poc-${T}-2pop`, r2b = `cfcode-poc-${T}-2pop`, vi = `cfcode-poc-${T}-2pop`;
const sas = ["team (1).json", "underwriter-agent-479920-af2b45745dac.json"].map(f => "/Users/awilliamspcsevents/.config/cfcode/sas/" + f);
const REPO = "/Users/awilliamspcsevents/PROJECTS/cfpubsub-scaffold", repoS = "cfpubsub-scaffold";
const LOG = path.join(poc, "e2e-cfpubsub-poll.jsonl");
const env = { ...process.env }; delete env.CLOUDFLARE_API_TOKEN;
for (const l of fs.readFileSync(root + "/.cfapikeys", "utf8").split(/\r?\n/)) { const [k, ...r] = l.split("="); const v = r.join("=").trim(); if (k.trim() === "CF_GLOBAL_API_KEY") env.CLOUDFLARE_API_KEY = v; if (k.trim() === "CF_EMAIL") env.CLOUDFLARE_EMAIL = v; if (k.trim() === "DEEPSEEK_API_KEY") env._DS = v; }
function run(cmd, args, o = {}) { const R = spawnSync(cmd, args, { cwd: o.c || poc, env, encoding: "utf8", stdio: o.q ? ["ignore", "pipe", "pipe"] : "inherit", input: o.i }); if (R.status !== 0 && !o.ok) throw new Error(`${cmd} ${args.join(" ")} failed`); return R; }
function d1id() { const c = run("npx", ["wrangler", "d1", "create", dn], { q: 1, ok: 1 }); const m = (c.stdout + c.stderr).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); if (m) return m[0]; const l = run("npx", ["wrangler", "d1", "list", "--json"], { q: 1 }); return JSON.parse(l.stdout || "[]").find(d => d.name === dn).uuid; }
function tpl(d1id) { let t = fs.readFileSync(poc + "/wrangler.template.jsonc", "utf8"); t = t.replace("__WORKER_NAME__", wn).replace("__R2_BUCKET__", r2b).replace(/__D1_NAME__/g, dn).replace("__D1_ID__", d1id).replace("__VECTORIZE_INDEX__", vi); const o = poc + "/wrangler.gen.jsonc"; fs.writeFileSync(o, t); return o; }

const SKIP = /^(\.|node_modules|venv|__pycache__|dist|build|\.git|\.cfpubsub|_archive)/;
const SKIP_EXT = /\.(lock|map|min\.js|min\.css|woff2?|ttf|eot|ico|png|jpe?g|gif|svg|pdf|zip|tar|gz|pyc)$/i;

function buildChunks(repoPath, slug) {
  const ls = spawnSync("git", ["ls-files"], { cwd: repoPath, encoding: "utf8" }).stdout.trim().split("\n").filter(f => f && !SKIP.test(f) && !SKIP_EXT.test(f) && !f.includes("node_modules"));
  const chunks = [];
  for (const rel of ls) {
    try { const p2 = path.join(repoPath, rel), st = fs.statSync(p2); if (st.isDirectory() || st.size > 1e6) continue; let t = fs.readFileSync(p2, "utf8"); if (!t.trim()) continue; t = t.slice(0, 4000); chunks.push({ chunk_id: "chk-" + crypto.createHash("sha256").update(rel + ":0").digest("hex").slice(0, 16), repo_slug: slug, file_path: rel, source_sha256: crypto.createHash("sha256").update(t).digest("hex"), text: t }); } catch { continue; }
  }
  return chunks;
}

async function main() {
  try { run("npx", ["wrangler", "delete", "--name", wn, "--force"], { q: 1, ok: 1 }); run("npx", ["wrangler", "vectorize", "delete", vi, "--force"], { q: 1, ok: 1 }); run("npx", ["wrangler", "r2", "bucket", "delete", r2b], { q: 1, ok: 1 }); run("npx", ["wrangler", "d1", "delete", dn, "--skip-confirmation"], { q: 1, ok: 1 }); } catch {}
  run("npx", ["wrangler", "r2", "bucket", "create", r2b], { q: 1, ok: 1 }); run("npx", ["wrangler", "vectorize", "create", vi, "--dimensions=1536", "--metric=cosine"], { q: 1, ok: 1 });
  const id = d1id(), cp = tpl(id);
  console.log("Deploying 31K worker..."); const d = run("npx", ["wrangler", "deploy", "--config", cp], { q: 1 });
  const u = [...d.stdout.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, "")).find(u => u.includes(wn)); if (!u) throw new Error("no URL");
  console.log("Worker: " + u);
  for (let i = 0; i < 2; i++) { const sn = `GEMINI_SERVICE_ACCOUNT_B64${i === 0 ? "" : "_" + (i + 1)}`, sv = Buffer.from(fs.readFileSync(sas[i], "utf8")).toString("base64"); if (spawnSync("npx", ["wrangler", "secret", "put", sn, "--config", cp], { cwd: poc, env, input: sv, encoding: "utf8" }).status !== 0) throw new Error("secret " + sn + " failed"); }
  if (spawnSync("npx", ["wrangler", "secret", "put", "DEEPSEEK_API_KEY", "--config", cp], { cwd: poc, env, input: env._DS, encoding: "utf8" }).status !== 0) throw new Error("secret DS failed");
  await new Promise(r => setTimeout(r, 3000));

  console.log("\n--- Indexing " + REPO + " ---");
  const chunks = buildChunks(REPO, repoS); console.log(chunks.length + " chunks, " + chunks.reduce((s, c) => s + c.text.length, 0) + " chars");
  const ak = T + "/" + repoS + "-" + Date.now() + ".jsonl", at = chunks.map(c => JSON.stringify(c)).join("\n") + "\n", jid = "e2e-" + T + "-" + Date.now();
  fs.writeFileSync(LOG, "", "utf8");
  console.log("Log: " + LOG);

  const t0 = Date.now();
  const ing = await (await fetch(u + "/ingest-sharded", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job_id: jid, repo_slug: repoS, indexed_path: REPO, active_commit: "e2e", artifact_key: ak, artifact_text: at, code_shard_count: 4, hyde_shard_count: 48, code_batch_size: 500, hyde_batch_size: 500, hyde: true }) })).json();
  const respMs = Date.now() - t0;
  console.log("response_ms=" + respMs + " status=" + ing.status + " chunks=" + (ing.chunks || "?"));

  let codeLive = null, hydeLive = null, published = null, prevCode = 0, prevHyde = 0;
  const dl = Date.now() + 600000;
  while (Date.now() < dl) {
    const r = await (await fetch(u + "/jobs/" + jid + "/status")).json();
    if (!r.ok || !r.job) { await new Promise(r => setTimeout(r, 2000)); continue; }
    const j = r.job, el = Date.now() - t0;
    if (!codeLive && (j.code_status === "live" || j.code_status === "partial")) codeLive = el;
    if (!hydeLive && (j.hyde_status === "live" || j.hyde_status === "partial")) hydeLive = el;
    if (!published && (j.status === "published" || j.status === "partial")) published = el;
    const line = JSON.stringify({ t: el, code: j.code_status + "/" + j.completed + " Δ" + (j.completed - prevCode), hyde: j.hyde_status + "/" + (j.hyde_completed || 0) + " Δ" + ((j.hyde_completed || 0) - prevHyde), status: j.status }) + "\n";
    fs.appendFileSync(LOG, line);
    prevCode = j.completed || 0; prevHyde = j.hyde_completed || 0;
    process.stdout.write("\r  t=" + (el / 1000).toFixed(0) + "s code=" + j.code_status + "/" + j.completed + " hyde=" + j.hyde_status + "/" + (j.hyde_completed || 0) + " " + j.status + "  ");
    if (published) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log("\n");

  const final = await (await fetch(u + "/jobs/" + jid + "/status")).json();
  const fj = final.job;
  const expectedHyde = chunks.length * 12;
  console.log("═══ E2E Results ═══");
  console.log("  Repo           : " + REPO);
  console.log("  Chunks         : " + chunks.length);
  console.log("  Code completed : " + (fj?.completed || 0) + "/" + chunks.length);
  console.log("  HyDE completed : " + (fj?.hyde_completed || 0) + "/" + expectedHyde + " (" + ((fj?.hyde_completed || 0) / expectedHyde * 100).toFixed(1) + "%)");
  console.log("  Response ms    : " + respMs);
  console.log("  Code live @    : " + (codeLive ? (codeLive / 1000).toFixed(1) + "s" : "never"));
  console.log("  HyDE live @    : " + (hydeLive ? (hydeLive / 1000).toFixed(1) + "s" : "never"));
  console.log("  Published @    : " + (published ? (published / 1000).toFixed(1) + "s" : "never"));
  if (codeLive && hydeLive) console.log("  Decouple gap   : " + ((hydeLive - codeLive) / 1000).toFixed(1) + "s");
  console.log("  Poll log       : " + LOG);

  const pass = fj && fj.completed === chunks.length && (fj.hyde_completed || 0) >= expectedHyde * 0.95;
  console.log("\n" + (pass ? "PASS" : "FAIL") + " E2E cfpubsub-scaffold");
  try { run("npx", ["wrangler", "delete", "--name", wn, "--force"], { q: 1, ok: 1 }); run("npx", ["wrangler", "vectorize", "delete", vi, "--force"], { q: 1, ok: 1 }); run("npx", ["wrangler", "r2", "bucket", "delete", r2b], { q: 1, ok: 1 }); run("npx", ["wrangler", "d1", "delete", dn, "--skip-confirmation"], { q: 1, ok: 1 }); } catch {}
  if (!pass) process.exit(1);
}
main().catch(e => { console.error(e.message); process.exit(1); });
