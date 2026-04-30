#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function has(name) {
  return process.argv.includes(name);
}

function runGit(repo, args, allowFailure = false) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  return result;
}

async function main() {
  const repo = arg("--repo");
  const repoSlug = arg("--repo-slug", repo ? path.basename(repo) : undefined);
  const mode = arg("--mode", "incremental");
  const diffBase = arg("--diff-base", "HEAD");
  const resume = has("--resume");
  const dryRun = has("--dry-run");
  if (!repo || !repoSlug) throw new Error("--repo and --repo-slug are required");

  const status = runGit(repo, ["status", "--short"]).stdout.trim().split("\n").filter(Boolean);
  const diff = mode === "incremental"
    ? runGit(repo, ["diff", "--name-status", `${diffBase}...HEAD`], true).stdout.trim().split("\n").filter(Boolean)
    : [];
  const tracked = runGit(repo, ["ls-files"]).stdout.trim().split("\n").filter(Boolean);
  const changedPaths = new Set([
    ...status.map((line) => line.slice(3).trim()).filter(Boolean),
    ...diff.map((line) => line.split(/\t+/).pop()).filter(Boolean),
  ]);
  const pathsForIndex = mode === "full" ? tracked : tracked.filter((file) => changedPaths.has(file));
  const manifest = {
    schema_version: "cfcode.index_plan.v1",
    repo,
    repo_slug: repoSlug,
    mode,
    diff_base: diffBase,
    resume,
    dry_run: dryRun,
    tracked_file_count: tracked.length,
    changed_file_count: changedPaths.size,
    files_to_index_count: pathsForIndex.length,
    files_to_index: pathsForIndex,
    stages: ["snapshot", "chunk", "hyde", "embedding", "publication", "docs"],
    resumable_keys: {
      chunks: "chunk_identity",
      hyde: "content_hash + hyde_version + hyde_model",
      embeddings: "embedding_run_id + input_hash",
    },
  };
  const outDir = path.resolve("cloudflare-mcp/sessions/index-codebase", repoSlug);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "last-plan.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
