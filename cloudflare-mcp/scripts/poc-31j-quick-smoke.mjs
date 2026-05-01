#!/usr/bin/env node
// Quick smoke for 31J: 5 chunks, tailed
import { spawnSync } from "child_process"; import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
const __dir = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(__dir, "../.."), poc = path.resolve(__dir, "../poc/31j-3pop");
const wn = "cfcode-poc-31j-3pop", u = `https://${wn}.frosty-butterfly-d821.workers.dev`;
console.log("Testing " + u);

const chunks = ["function add(a,b){return a+b}", "class User{name:string}", "export const API=42", "async function main(){await fetch('/')}", "type Foo={a:1}"].map((t, i) => ({ chunk_id: `sss${i}000000000001`, repo_slug: "test", file_path: `f${i}.ts`, source_sha256: "abc", text: t }));
const at = chunks.map(c => JSON.stringify(c)).join("\n") + "\n", jid = "sm31j-" + Date.now();

console.log("Sending " + chunks.length + " chunks...");
const t0 = Date.now();
const ing = await (await fetch(u + "/ingest-sharded", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job_id: jid, repo_slug: "test", indexed_path: "/tmp", active_commit: "x", artifact_key: "31j/sm.jsonl", artifact_text: at, code_shard_count: 1, qgen_shard_count: 4, hemb_shard_count: 2, code_batch_size: 10, hemb_batch_size: 10, hyde: true }) })).json();
console.log("response_ms=" + (Date.now() - t0) + " status=" + ing.status + " chunks=" + (ing.chunks || "?"));
console.log("Polling...");
const dl = Date.now() + 120000; let job = null;
while (Date.now() < dl) { const r = await (await fetch(u + "/jobs/" + jid + "/status")).json(); if (r.ok && r.job) { job = r.job; process.stdout.write("\r  code=" + job.code_status + "/" + job.completed + "  qgen=" + (job.questions_generated || 0) + "  hyde=" + job.hyde_status + "/" + job.hyde_completed + "  st=" + job.status + "  "); if (job.status !== "running") break; } await new Promise(r => setTimeout(r, 2000)); }
console.log("\nFinal: code=" + job?.completed + " qgen=" + job?.questions_generated + " hyde=" + job?.hyde_completed + " status=" + job?.status);
