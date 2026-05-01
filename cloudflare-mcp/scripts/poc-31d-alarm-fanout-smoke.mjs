#!/usr/bin/env node
// POC 31D: Prove alarm-driven fan-out with synthetic payloads.
// Smoke: node cloudflare-mcp/scripts/poc-31d-alarm-fanout-smoke.mjs
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const poc = path.resolve(__dir, "../poc/31d-alarm-fanout");
const TAG = "31d", wn = `cfcode-poc-${TAG}-afan`, dn = `cfcode-poc-${TAG}-afan`;

const env = { ...process.env }; delete env.CLOUDFLARE_API_TOKEN;
const cfk = path.resolve(__dir, "../..", ".cfapikeys");
for (const l of fs.readFileSync(cfk, "utf8").split(/\r?\n/)) {
  const [k, ...r] = l.split("="); const v = r.join("=").trim();
  if (k.trim() === "CF_GLOBAL_API_KEY") env.CLOUDFLARE_API_KEY = v;
  if (k.trim() === "CF_EMAIL") env.CLOUDFLARE_EMAIL = v;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd || poc, env, encoding: "utf8", stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit", input: opts.input });
  if (r.status !== 0 && !opts.ok) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r;
}

function d1id() {
  const c = run("npx", ["wrangler", "d1", "create", dn], { capture: true, ok: true });
  const m = (c.stdout + c.stderr).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (m) return m[0];
  const l = run("npx", ["wrangler", "d1", "list", "--json"], { capture: true });
  const f = JSON.parse(l.stdout || "[]").find(d => d.name === dn);
  if (!f) throw new Error("no d1 " + dn);
  return f.uuid;
}

function wranglerTmpl(d1id) {
  let t = fs.readFileSync(poc + "/wrangler.template.jsonc", "utf8");
  t = t.replace("__WORKER_NAME__", wn).replace(/__D1_NAME__/g, dn).replace("__D1_ID__", d1id);
  const o = poc + "/wrangler.gen.jsonc"; fs.writeFileSync(o, t); return o;
}

async function main() {
  try { run("npx", ["wrangler", "delete", "--name", wn, "--force"], { capture: 1, ok: 1 }); run("npx", ["wrangler", "d1", "delete", dn, "--skip-confirmation"], { capture: 1, ok: 1 }); } catch {}
  const id = d1id(), cp = wranglerTmpl(id);
  const d = run("npx", ["wrangler", "deploy", "--config", cp], { capture: true });
  const u = [...d.stdout.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, "")).find(u => u.includes(wn));
  if (!u) throw new Error("no URL in deploy output:\n" + d.stdout.slice(-500));
  console.log("Worker: " + u);

  for (const shards of [1, 4, 16]) {
    const jId = "j31d-" + Date.now() + "-" + shards;
    console.log("\n=== " + shards + " shards x 5 items ===");
    const t0 = Date.now();
    let r = await fetch(u + "/fanout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shard_count: shards, items_per_shard: 5 }) });
    const txt = await r.text();
    console.log("status=" + r.status + " response_ms=" + (Date.now() - t0));
    if (!r.ok) { console.log("body: " + txt.slice(0, 300)); continue; }
    const ing = JSON.parse(txt);
    console.log("job=" + ing.job_id + " total=" + ing.total);

    const dl = Date.now() + 30000; let job = null;
    while (Date.now() < dl) {
      r = await fetch(u + "/status?job_id=" + ing.job_id);
      const jt = await r.json();
      if (jt.ok && jt.job) { job = jt.job; process.stdout.write("\r  " + job.status + "/" + job.completed + "/" + job.total + "  "); if (job.status !== "running") break; }
      await new Promise(r => setTimeout(r, 500));
    }
    console.log("");
    const pass = job && job.status === "published" && job.completed === job.total;
    console.log((pass ? "PASS" : "FAIL") + " 31D shard_count=" + shards);
  }

  try { run("npx", ["wrangler", "delete", "--name", wn, "--force"], { capture: 1, ok: 1 }); run("npx", ["wrangler", "d1", "delete", dn, "--skip-confirmation"], { capture: 1, ok: 1 }); } catch {}
}
main().catch(e => { console.error(e.message); process.exit(1); });
