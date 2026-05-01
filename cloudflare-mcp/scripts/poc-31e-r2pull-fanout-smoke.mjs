#!/usr/bin/env node
// POC 31E: Prove alarm fan-out + R2-pull per shard.
// Smoke: node cloudflare-mcp/scripts/poc-31e-r2pull-fanout-smoke.mjs
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const poc = path.resolve(__dir, "../poc/31e-r2pull-fanout");
const TAG = "31e", wn = `cfcode-poc-${TAG}-r2pull`, dn = `cfcode-poc-${TAG}-r2pull`, r2 = `cfcode-poc-${TAG}-r2pull`;

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
  t = t.replace("__WORKER_NAME__", wn).replace("__R2_BUCKET__", r2).replace(/__D1_NAME__/g, dn).replace("__D1_ID__", d1id);
  const o = poc + "/wrangler.gen.jsonc"; fs.writeFileSync(o, t); return o;
}

async function main() {
  try { run("npx", ["wrangler", "delete", "--name", wn, "--force"], { capture: 1, ok: 1 }); run("npx", ["wrangler", "d1", "delete", dn, "--skip-confirmation"], { capture: 1, ok: 1 }); run("npx", ["wrangler", "r2", "bucket", "delete", r2], { capture: 1, ok: 1 }); } catch {}
  run("npx", ["wrangler", "r2", "bucket", "create", r2], { capture: 1, ok: 1 });
  const id = d1id(), cp = wranglerTmpl(id);
  const d = run("npx", ["wrangler", "deploy", "--config", cp], { capture: true });
  const u = [...d.stdout.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, "")).find(u => u.includes(wn));
  if (!u) throw new Error("no URL");
  console.log("Worker: " + u);

  for (const [shards, count] of [[4, 100], [16, 100]]) {
    console.log(`\n=== ${shards} shards x ${count} records (R2-pull) ===`);
    const t0 = Date.now();
    const r = await fetch(u + "/fanout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shard_count: shards, record_count: count }) });
    const ing = await r.json();
    console.log(`status=${r.status} job=${ing.job_id} total=${ing.total} response_ms=${Date.now() - t0}`);

    const dl = Date.now() + 30000; let job = null;
    while (Date.now() < dl) {
      const st = await (await fetch(u + "/status?job_id=" + ing.job_id)).json();
      if (st.ok && st.job) { job = st.job; process.stdout.write(`\r  ${job.status}/${job.completed}/${job.total}  `); if (job.status !== "running") break; }
      await new Promise(r => setTimeout(r, 500));
    }
    console.log("");
    const pass = job && job.status === "published" && job.completed === job.total;
    console.log((pass ? "PASS" : "FAIL") + ` 31E shards=${shards} count=${count}`);
  }

  try { run("npx", ["wrangler", "delete", "--name", wn, "--force"], { capture: 1, ok: 1 }); run("npx", ["wrangler", "d1", "delete", dn, "--skip-confirmation"], { capture: 1, ok: 1 }); run("npx", ["wrangler", "r2", "bucket", "delete", r2], { capture: 1, ok: 1 }); } catch {}
}
main().catch(e => { console.error(e.message); process.exit(1); });
