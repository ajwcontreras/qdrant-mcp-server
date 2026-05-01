#!/usr/bin/env node
// POC 31F.1: Prove Vertex embedding works inside a Durable Object.
// Smoke: node cloudflare-mcp/scripts/poc-31f1-vertex-in-do-smoke.mjs
import { spawnSync } from "child_process"; import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
const __dir = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(__dir, "../.."), poc = path.resolve(__dir, "../poc/31f1-vertex-in-do");
const wn = "cfcode-poc-31f1-vdo", T = "31f1";

const env = { ...process.env }; delete env.CLOUDFLARE_API_TOKEN;
for (const l of fs.readFileSync(root + "/.cfapikeys", "utf8").split(/\r?\n/)) { const [k, ...r] = l.split("="); const v = r.join("=").trim(); if (k.trim() === "CF_GLOBAL_API_KEY") env.CLOUDFLARE_API_KEY = v; if (k.trim() === "CF_EMAIL") env.CLOUDFLARE_EMAIL = v; }
function r(cmd, args, o = {}) { const R = spawnSync(cmd, args, { cwd: o.c || poc, env, encoding: "utf8", stdio: o.q ? ["ignore", "pipe", "pipe"] : "inherit", input: o.i }); if (R.status !== 0 && !o.ok) throw new Error(`${cmd} ${args.join(" ")} failed`); return R; }
function durl(out) { return [...out.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map(m => m[0].replace(/\/$/, "")).find(u => u.includes(wn)) || (() => { throw new Error("no URL: " + out.slice(-400)); })(); }

async function main() {
  try { r("npx", ["wrangler", "delete", "--name", wn, "--force"], { q: 1, ok: 1 }); } catch {}
  let t = fs.readFileSync(poc + "/wrangler.template.jsonc", "utf8").replace("__WORKER_NAME__", wn);
  fs.writeFileSync(poc + "/wrangler.gen.jsonc", t);
  console.log("Deploying...");
  const d = r("npx", ["wrangler", "deploy", "--config", poc + "/wrangler.gen.jsonc"], { q: 1 });
  const u = durl(d.stdout + d.stderr); console.log("Worker: " + u);
  const saB64 = Buffer.from(fs.readFileSync("/Users/awilliamspcsevents/.config/cfcode/sas/team (1).json", "utf8")).toString("base64");
  if (spawnSync("npx", ["wrangler", "secret", "put", "GEMINI_SERVICE_ACCOUNT_B64", "--config", poc + "/wrangler.gen.jsonc"], { cwd: poc, env, input: saB64, encoding: "utf8" }).status !== 0) throw new Error("secret failed");
  await new Promise(r => setTimeout(r, 3000));

  console.log("Testing Vertex in DO...");
  const t0 = Date.now();
  const res = await (await fetch(u + "/embed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts: ["function add(a,b) { return a + b; }", "export class User { name: string }"] }) })).json();
  console.log("response_ms=" + (Date.now() - t0));
  console.log(JSON.stringify(res, null, 2).slice(0, 500));
  const pass = res.ok === true && Array.isArray(res.results) && res.results.length === 2 && res.results[0].dims === 1536;
  console.log("\n" + (pass ? "PASS" : "FAIL") + " POC 31F.1");
  try { r("npx", ["wrangler", "delete", "--name", wn, "--force"], { q: 1, ok: 1 }); } catch {}
  if (!pass) process.exit(1);
}
main().catch(e => { console.error(e.message); process.exit(1); });
