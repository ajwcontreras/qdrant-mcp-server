#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const out = "ephemeral/handoff-prompt-2026-04-30.md";

function read(path) {
  try {
    return fs.readFileSync(path, "utf8");
  } catch (error) {
    return `[[could not read ${path}: ${error.message}]]\n`;
  }
}

function cmd(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

const gitStatus = cmd("git", ["status", "--short"]);
const gitLog = cmd("git", ["log", "--oneline", "-30"]);
const plan = read("EXECUTION_PLAN.md");
const handoff = read("AGENT_HANDOFF_MASTER_PLAN.md");
const claude = read("CLAUDE.md");

const lines = [];
function h(text = "") { lines.push(text); }

h("# Handoff Prompt — Cloudflare Codebase MCP Indexing");
h("");
h("Date: 2026-04-30");
h("Target receiving agent: Claude with very large context window");
h("Primary repo: /Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server");
h("Target codebase being indexed: /Users/awilliamspcsevents/PROJECTS/lumae-fresh");
h("");
h("## Non-Negotiable First Instructions");
h("");
h("1. Read this entire handoff before editing files.");
h("2. Read EXECUTION_PLAN.md before implementation.");
h("3. Read AGENT_HANDOFF_MASTER_PLAN.md before implementation.");
h("4. Continue exactly the next pending POC: POC 26D0 Full Job Safety Preflight.");
h("5. Do not skip to POC 26D until POC 26D0 passes and is committed/pushed.");
h("6. If the current POC gets two failed executions in a row, stop it, revert only that POC's own uncommitted files, split it into four smaller POCs in EXECUTION_PLAN.md, and resume at the first smaller POC.");
h("7. Preserve unrelated dirty work in the repo. Do not reset or checkout unrelated files.");
h("8. Never print or commit secrets from .cfapikeys or the Google service account.");
h("9. If you switch GitHub CLI auth to ajwcontreras to push, switch back to awilliamsevrylo immediately after.");
h("10. Use live Cloudflare docs before making Cloudflare API claims.");
h("");
h("## Current User Request That Triggered This Handoff");
h("");
h("The user asked to prepare a very long handoff for a Claude agent and update Claude memory files for all projects touched. They explicitly asked for generous context because the receiving Claude agent has a very large context window. They also previously asked to add POCs for git diff manifests and Cloudflare-tracked git history so incremental indexing can reprocess whole changed files and tombstone deleted files.");
h("");
h("## Skills To Load In The Receiving Session");
h("");
h("- prepare-handoff, if continuing handoff/documentation work.");
h("- poc-driven-development, always for this task.");
h("- cloudflare-codebase-mcp-indexing, always for this task.");
h("- wrangler, before Wrangler commands.");
h("- agents-sdk, if changing MCP Worker / Cloudflare Agent primitives.");
h("- launcher-api-review, if asking council/reviewer models through the public Launcher API.");
h("");
h("## Repository And Identity State");
h("");
h("Repository: /Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server");
h("Remote for pushes: mine -> https://github.com/ajwcontreras/qdrant-mcp-server.git");
h("Default GH account after pushes should be: awilliamsevrylo");
h("Push pattern used successfully:");
h("");
h("```bash");
h("gh auth switch -u ajwcontreras && git push mine main; rc=$?; gh auth switch -u awilliamsevrylo; exit $rc");
h("```");
h("");
h("## Credentials And Secret Paths");
h("");
h("Cloudflare credentials are in:");
h("");
h("```text");
h("/Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server/.cfapikeys");
h("```");
h("");
h("Google service account JSON is in:");
h("");
h("```text");
h("/Users/awilliamspcsevents/Downloads/team (1).json");
h("```");
h("");
h("Never print those secret values. Scripts generally load .cfapikeys and map CF_GLOBAL_API_KEY to CLOUDFLARE_API_KEY, CF_EMAIL to CLOUDFLARE_EMAIL, and CF_ACCOUNT_ID to CLOUDFLARE_ACCOUNT_ID. Some shells have CLOUDFLARE_API_TOKEN set to the wrong token; robust scripts delete/unset CLOUDFLARE_API_TOKEN before invoking wrangler.");
h("");
h("## High-Level Architecture Direction");
h("");
h("The project pivoted hard from local/Qdrant-first indexing to Cloudflare-first per-codebase MCP indexing. The local machine may read repos, package artifacts, start jobs, poll status, and write docs. Expensive work must fan out through Cloudflare Workers and Queues. Full indexing should not be a slow local sequential Vertex loop.");
h("");
h("Target architecture:");
h("");
h("- Local controller packages filtered source/chunk/HyDE inputs.");
h("- R2 stores source, chunk, HyDE, embedding, publication, and incremental artifacts.");
h("- D1 stores job state, counters, chunk metadata, active publication metadata, git state, and diff manifest rows.");
h("- Queues fan out embedding and publication work across Worker isolates.");
h("- Worker consumers call Vertex gemini-embedding-001 at 1536 dimensions.");
h("- Vectorize stores 1536-dimensional vectors.");
h("- MCP endpoint is an unauthenticated URL per indexed codebase.");
h("- Generated docs tell agents how to install the MCP endpoint and how to run full redo, incremental diff, resume/retry, and status polling.");
h("");
h("## Cloudflare Docs Facts Verified During Session");
h("");
h("Queues:");
h("");
h("- Wrangler supports queues.producers and queues.consumers.");
h("- Consumer config supports max_batch_size, max_batch_timeout, max_retries, dead_letter_queue.");
h("- Leaving max_concurrency unset lets consumers scale to the supported maximum, but council warned this can overload Vertex.");
h("- Queue consumer Workers must be unbound before Worker/Queue deletion. POC 26C1 proved `wrangler queues consumer remove <queue> <worker>`.");
h("");
h("Vectorize:");
h("");
h("- Worker binding supports insert/upsert/query.");
h("- deleteByIds is available and asynchronous; stale vectors can remain visible briefly.");
h("- returnMetadata: all is slower and topK is limited to 50.");
h("- Metadata indexes should be created before vector insertion.");
h("- Metadata indexes are limited to 10 properties.");
h("- Create metadata index command pattern: `wrangler vectorize create-metadata-index <index> --property-name=<name> --type=string`.");
h("");
h("D1:");
h("");
h("- Prepared statements use prepare/bind/run/first/all.");
h("- batch groups prepared statements.");
h("- D1 should be treated as the authoritative state store for active chunks and job completion.");
h("");
h("R2:");
h("");
h("- Worker bindings support put/get/head/delete.");
h("- Prefer R2 bindings from Workers in same account.");
h("- Remote cleanup may require `wrangler r2 object delete <bucket>/<key> --remote` before bucket deletion.");
h("");
h("## Council Review Summary");
h("");
h("The Launcher API council was invoked after the user requested it. The uploaded bundle was `ephemeral/cloudflare-codebase-mcp-council-bundle.txt`. The prompt explicitly required reviewers to use live official Cloudflare docs before making claims. Providers: Gemini Pro, ChatGPT, Claude. All succeeded.");
h("");
h("Converged findings:");
h("");
h("- 26D full job architecture is fundamentally sound only if idempotency and D1 source-of-truth semantics are built first.");
h("- Cloudflare Queues are at-least-once. Duplicate delivery must be expected.");
h("- Deterministic chunk/vector IDs are required.");
h("- D1 rows with active flags are the source of truth for search and resume.");
h("- Vectorize is eventually consistent. Do not use Vectorize query visibility for resume/completion.");
h("- Vectorize deletes are async. Mark D1 rows inactive first and optionally run deleteByIds as garbage collection.");
h("- Create Vectorize metadata indexes before inserting vectors.");
h("- Whole-file reprocessing for changed files is the correct v1 incremental strategy.");
h("- Renames should be old-path tombstone plus new-path whole-file add.");
h("- Generated docs must warn that deletes may lag in search and that incremental v1 reprocesses entire changed files.");
h("- It is reasonable to add a POC 26D0 before full 26D.");
h("");
h("## Completed POC Chain Since Cloudflare Pivot");
h("");
const completed = [
  ["426794d", "POC 26A1 PASS", "Worker toolchain compiles with R2 and D1 bindings."],
  ["37ce776", "POC 26A2 PASS", "R2 upload endpoint only."],
  ["885a61e", "POC 26A3 PASS", "D1 job endpoint only."],
  ["0e10809", "POC 26A4 PASS", "Combined local packager to R2 and D1. Packaged 5 lumae files, 8731-byte artifact, 0 Vertex calls."],
  ["4512713", "POC 26B PASS", "Cloudflare Queue fan-out embedding. 3 messages, 3 real Vertex embeddings from Workers, 0 local Vertex calls."],
  ["fa78322", "PLAN REVISION", "Split POC 26C after two failed runs."],
  ["b6f6caa", "POC 26C1 PASS", "Explicit Queue consumer cleanup and queue name reuse."],
  ["e93e24d", "POC 26C2 PASS", "Remote R2 publication artifact write/head/delete lifecycle."],
  ["7a09ecd", "POC 26C3 PASS", "Vectorize 1536d upsert visibility with bounded polling."],
  ["84430c9", "POC 26C4 PASS", "Combined Queue publication to Vectorize and D1; D1 active metadata and search worked."],
  ["e9689a4", "PLAN REVISION", "Added git diff incremental POCs 26E1-26E5."],
  ["5bd6633", "PLAN REVISION", "Added POC 26D0 safety preflight from council review."]
];
for (const [sha, title, detail] of completed) h(`- ${sha} — ${title}: ${detail}`);
h("");
h("## Current Next POC");
h("");
h("POC 26D0: Full Job Safety Preflight.");
h("");
h("The exact run command planned in EXECUTION_PLAN.md is:");
h("");
h("```bash");
h("node cloudflare-mcp/scripts/poc-26d0-full-job-safety-preflight.mjs");
h("```");
h("");
h("This script does not exist yet at handoff time. A directory may exist from the interrupted start:");
h("");
h("```text");
h("cloudflare-mcp/poc/26d0-full-job-safety-worker/src");
h("```");
h("");
h("Reuse or delete that empty directory as appropriate. It was created immediately before the user interrupted for this handoff.");
h("");
h("## POC 26D0 Requirements");
h("");
h("POC 26D0 must prove these things before implementing POC 26D:");
h("");
h("- Create a bounded Worker with R2, D1, Vectorize, Queue bindings.");
h("- Create Vectorize metadata indexes for repo_slug, file_path, active_commit before any vector insert.");
h("- D1 schema must include deterministic chunk_id, repo_slug, file_path, source_sha256, active, job_id, and counters.");
h("- Queue consumer must handle duplicate messages idempotently using deterministic chunk IDs and insert/replace semantics.");
h("- Search must cross-check Vectorize matches against D1 active=1 rows.");
h("- It should use deterministic vectors or bounded fake embeddings; no Vertex calls in 26D0.");
h("- Cleanup must explicitly remove Queue consumer binding before deleting Worker/Queue/DLQ.");
h("- Cleanup must delete any remote R2 object before deleting the bucket.");
h("");
h("## Future POC 26D");
h("");
h("After 26D0 passes, POC 26D should run the full lumae Cloudflare job. It should compose the proven pieces:");
h("");
h("- local packaging from 26A4");
h("- queue fan-out real Vertex embedding from 26B");
h("- publication/search from 26C4");
h("- safety contracts from 26D0");
h("");
h("POC 26D must generate docs under:");
h("");
h("```text");
h("cloudflare-mcp/sessions/index-codebase/lumae-fresh/");
h("```");
h("");
h("POC 26D docs must include MCP URL, indexed path, full redo command, incremental command placeholder, resume/retry command, status URL, runtime, and throughput.");
h("");
h("## Future Diff/Incremental POCs");
h("");
h("POC 26E1: Git Diff Manifest JSON Export.");
h("POC 26E2: Cloudflare Stores Git History State.");
h("POC 26E3: Incremental Diff Packager Uses Whole-File Reprocessing.");
h("POC 26E4: Cloudflare Incremental Job Processes Diff Manifest.");
h("POC 26E5: Generated Docs Include Diff Reindex Commands.");
h("");
h("Important design decisions for 26E:");
h("");
h("- v1 incremental reprocesses whole changed files.");
h("- deleted files create tombstones and deactivate old chunks.");
h("- renames are delete old path + add new path.");
h("- manifest JSON must include manifest_id, repo_slug, repo_path, base_commit, target_commit, generated_at, working_tree_clean, changed/deleted/renamed rows, sha256, blob SHA where available, byte size, previous_path.");
h("- D1 should track codebase_git_state, diff_manifests, diff_manifest_files, chunks, and active publication.");
h("");
h("## Dirty Worktree At Handoff");
h("");
h("The following is the exact `git status --short` captured while preparing handoff:");
h("");
h("```text");
h(gitStatus || "(clean)");
h("```");
h("");
h("Do not revert these unless they belong to your own active POC. Many are unrelated/pre-existing.");
h("");
h("## Recent Git Log");
h("");
h("```text");
h(gitLog);
h("```");
h("");
h("## Files Updated For This Handoff");
h("");
h("- CLAUDE.md was updated with current Cloudflare-first pivot, fixed paths, council findings, and POC 26D0 requirements.");
h("- AGENT_HANDOFF_MASTER_PLAN.md was updated with a prepare-handoff entry.");
h("- Claude memory file added for qdrant-mcp-server:");
h("  `/Users/awilliamspcsevents/.claude/projects/-Users-awilliamspcsevents-PROJECTS-qdrant-mcp-server/memory/project_session_2026-04-30_cloudflare_mcp_pivot.md`");
h("- Claude memory file added for lumae:");
h("  `/Users/awilliamspcsevents/.claude/projects/-Users-awilliamspcsevents-PROJECTS-lumae/memory/codebase_mcp_indexing_2026-04-30.md`");
h("- Claude memory file added for cf-docs-mcp:");
h("  `/Users/awilliamspcsevents/.claude/projects/-Users-awilliamspcsevents-PROJECTS-cf-docs-mcp/memory/reference_cloudflare_docs_for_codebase_mcp_2026-04-30.md`");
h("- Each affected memory directory's MEMORY.md index was updated.");
h("");
h("## Important Existing Skills");
h("");
h("The global skill `cloudflare-codebase-mcp-indexing` was previously installed in multiple skill roots and points to the canonical repo and credential paths. Load it whenever working on per-codebase Cloudflare MCP indexing.");
h("");
h("The `skill-creator` skill was previously edited so future global/multi-agent skills use Vercel Labs `npx skills` by default.");
h("");
h("## Exact Commands That Have Been Working");
h("");
h("Load Cloudflare creds robustly:");
h("");
h("```bash");
h("set -a");
h("source /Users/awilliamspcsevents/PROJECTS/qdrant-mcp-server/.cfapikeys");
h("set +a");
h("unset CLOUDFLARE_API_TOKEN");
h("export CLOUDFLARE_API_KEY=\"$CF_GLOBAL_API_KEY\"");
h("export CLOUDFLARE_EMAIL=\"$CF_EMAIL\"");
h("export CLOUDFLARE_ACCOUNT_ID=\"$CF_ACCOUNT_ID\"");
h("```");
h("");
h("Set Google service-account Worker secret:");
h("");
h("```bash");
h("node -e 'process.stdout.write(Buffer.from(require(\"fs\").readFileSync(\"/Users/awilliamspcsevents/Downloads/team (1).json\", \"utf8\")).toString(\"base64\"))' \\");
h("  | npx wrangler secret put GEMINI_SERVICE_ACCOUNT_B64 --config wrangler.generated.jsonc");
h("```");
h("");
h("Push qdrant repo safely:");
h("");
h("```bash");
h("gh auth switch -u ajwcontreras && git push mine main; rc=$?; gh auth switch -u awilliamsevrylo; exit $rc");
h("```");
h("");
h("## POC Failure Policy");
h("");
h("If one run fails, fix the small issue and rerun. If the same current POC has two failed runs in a row, stop it. Do not keep patching. Revert only that POC's own uncommitted files. Preserve unrelated/user work. Revise EXECUTION_PLAN.md. Split that POC into four smaller POCs. Resume from the first smaller POC. This was followed for POC 26A and POC 26C.");
h("");
h("## How POC 26C Failed And Was Fixed");
h("");
h("Initial combined 26C failed twice. First failure: publication and D1/Vectorize writes passed, but search visibility assertion failed. Second failure: stale Queue names remained bound to the Worker. Then the POC was stopped, resources cleaned up, and split into 26C1-26C4.");
h("");
h("Takeaway:");
h("");
h("- Always explicitly remove Queue consumer binding before deleting the Worker/Queue.");
h("- Always delete remote R2 objects before deleting buckets.");
h("- Always bound-poll Vectorize search visibility.");
h("- Always make cleanup scripts robust against CLOUDFLARE_API_TOKEN pointing at the wrong account.");
h("");
h("## Live Endpoint Reference");
h("");
h("Existing bounded lumae MCP endpoint:");
h("");
h("```text");
h("https://cfcode-lumae-fresh.frosty-butterfly-d821.workers.dev/mcp");
h("```");
h("");
h("This endpoint exists from earlier bounded POC work. It is not yet the final full Cloudflare fan-out indexed endpoint for all lumae files.");
h("");
h("## Current Repo CLAUDE.md Snapshot");
h("");
h("```markdown");
h(claude);
h("```");
h("");
h("## Current AGENT_HANDOFF_MASTER_PLAN.md Snapshot");
h("");
h("```markdown");
h(handoff);
h("```");
h("");
h("## Current EXECUTION_PLAN.md Snapshot");
h("");
h("```markdown");
h(plan);
h("```");
h("");
h("## Continuation Checklist");
h("");
const checklist = [
  "Open EXECUTION_PLAN.md and confirm POC 26D0 is the next pending POC.",
  "Open AGENT_HANDOFF_MASTER_PLAN.md and confirm handoff state.",
  "Check git status and identify unrelated dirty files.",
  "Do not revert unrelated dirty files.",
  "Inspect any existing 26d0 directory.",
  "If it is empty, reuse it.",
  "Implement Worker folder cloudflare-mcp/poc/26d0-full-job-safety-worker.",
  "Implement script cloudflare-mcp/scripts/poc-26d0-full-job-safety-preflight.mjs.",
  "Use R2/D1/Vectorize/Queue bindings.",
  "Use deterministic vectors; do not call Vertex in 26D0.",
  "Create Vectorize index.",
  "Create metadata indexes before inserts: repo_slug.",
  "Create metadata index before inserts: file_path.",
  "Create metadata index before inserts: active_commit.",
  "List metadata indexes and assert they exist.",
  "Create D1 schema with jobs, chunks, active publication or equivalent.",
  "Use deterministic chunk_id.",
  "Use INSERT OR IGNORE or INSERT OR REPLACE semantics.",
  "Send duplicate queue messages for the same chunk.",
  "Assert completed counters do not over-count.",
  "Assert D1 chunk row count is one for the duplicate chunk.",
  "Mark one chunk inactive.",
  "Query Vectorize and cross-check against D1 active rows.",
  "Assert inactive chunk is filtered out.",
  "Explicitly remove queue consumer binding during cleanup.",
  "Delete Worker.",
  "Delete Queue.",
  "Delete DLQ.",
  "Delete remote R2 object if created.",
  "Delete R2 bucket.",
  "Delete Vectorize index.",
  "Delete D1 database.",
  "Update EXECUTION_PLAN.md with POC 26D0 evidence.",
  "Update AGENT_HANDOFF_MASTER_PLAN.md with timestamp and exact next step.",
  "Commit POC 26D0 if passing.",
  "Push to mine with ajwcontreras and switch GH auth back.",
  "Only then continue to POC 26D full lumae job."
];
for (let i = 0; i < checklist.length; i += 1) {
  h(`${String(i + 1).padStart(4, "0")}. ${checklist[i]}`);
}
h("");
h("## End State");
h("");
h("At the moment this handoff was generated, no 26D0 implementation had passed. The safe continuation is to implement and run exactly POC 26D0, then commit/push if it passes.");

fs.mkdirSync("ephemeral", { recursive: true });
fs.writeFileSync(out, `${lines.join("\n")}\n`, "utf8");
console.log(out);
