#!/usr/bin/env node
/**
 * POC 19: Throwaway Resource Cleanup
 *
 * Proves:
 *   A cleanup manifest can drive deletion of throwaway Worker, Vectorize, D1,
 *   and R2 resources, then verify they are gone.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/19-cleanup-worker");
const sessionDir = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-19");
const manifestPath = path.join(sessionDir, "cleanup-manifest.json");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const resources = {
  worker: "cfcode-poc-19-cleanup-worker",
  vectorize: "cfcode-poc-19-cleanup-index",
  d1: "cfcode-poc-19-cleanup-db",
  r2: "cfcode-poc-19-cleanup-bucket",
};

function loadCloudflareEnv() {
  const env = { ...process.env };
  if (fs.existsSync(cfKeysPath)) {
    for (const line of fs.readFileSync(cfKeysPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [rawKey, ...rest] = trimmed.split("=");
      const key = rawKey.trim();
      const value = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
      if (key === "CF_GLOBAL_API_KEY") env.CLOUDFLARE_API_KEY = value;
      if (key === "CF_EMAIL") env.CLOUDFLARE_EMAIL = value;
      if (key === "CF_ACCOUNT_ID") env.CLOUDFLARE_ACCOUNT_ID = value;
    }
  }
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || pocDir,
    env: options.env || loadCloudflareEnv(),
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0 && !options.allowFailure) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return result;
}

async function writeManifest(d1Id) {
  await fsp.mkdir(sessionDir, { recursive: true });
  const manifest = {
    schema_version: "cfcode.cleanup_manifest.v1",
    resources: [
      { type: "worker", name: resources.worker },
      { type: "vectorize", name: resources.vectorize },
      { type: "d1", name: resources.d1, id: d1Id },
      { type: "r2", name: resources.r2 },
    ],
  };
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  return manifest;
}

function extractDatabaseId(output) {
  const uuid = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!uuid) throw new Error(`Could not find D1 database UUID in output:\n${output}`);
  return uuid[0];
}

function cleanupFromManifest(manifest) {
  for (const resource of manifest.resources) {
    if (resource.type === "worker") run("npx", ["wrangler", "delete", "--name", resource.name, "--force"], { allowFailure: true });
    if (resource.type === "vectorize") run("npx", ["wrangler", "vectorize", "delete", resource.name, "--force"], { allowFailure: true });
    if (resource.type === "d1") run("npx", ["wrangler", "d1", "delete", resource.name, "--skip-confirmation"], { allowFailure: true });
    if (resource.type === "r2") run("npx", ["wrangler", "r2", "bucket", "delete", resource.name], { allowFailure: true });
  }
}

function bestEffortPreclean() {
  cleanupFromManifest({
    resources: [
      { type: "worker", name: resources.worker },
      { type: "vectorize", name: resources.vectorize },
      { type: "d1", name: resources.d1 },
      { type: "r2", name: resources.r2 },
    ],
  });
}

function verifyGone() {
  const worker = run("npx", ["wrangler", "delete", "--name", resources.worker, "--force"], { capture: true, allowFailure: true });
  const vectorize = run("npx", ["wrangler", "vectorize", "get", resources.vectorize], { capture: true, allowFailure: true });
  const d1 = run("npx", ["wrangler", "d1", "info", resources.d1], { capture: true, allowFailure: true });
  const r2 = run("npx", ["wrangler", "r2", "bucket", "list"], { capture: true });
  return {
    workerGone: worker.status !== 0 && `${worker.stdout}\n${worker.stderr}`.includes("does not exist"),
    vectorizeGone: vectorize.status !== 0,
    d1Gone: d1.status !== 0,
    r2Gone: !`${r2.stdout}\n${r2.stderr}`.includes(resources.r2),
  };
}

async function main() {
  console.log("POC 19: Throwaway Resource Cleanup\n");
  const checks = {
    resourcesCreated: false,
    manifestWritten: false,
    cleanupRan: false,
    workerGone: false,
    vectorizeGone: false,
    d1Gone: false,
    r2Gone: false,
  };
  bestEffortPreclean();
  run("npm", ["install"]);
  run("npm", ["run", "check"]);
  run("npx", ["wrangler", "deploy"]);
  run("npx", ["wrangler", "vectorize", "create", resources.vectorize, "--dimensions=32", "--metric=cosine"]);
  const d1Create = run("npx", ["wrangler", "d1", "create", resources.d1], { capture: true });
  const d1Id = extractDatabaseId(`${d1Create.stdout}\n${d1Create.stderr}`);
  run("npx", ["wrangler", "r2", "bucket", "create", resources.r2]);
  checks.resourcesCreated = true;

  const manifest = await writeManifest(d1Id);
  checks.manifestWritten = fs.existsSync(manifestPath);
  cleanupFromManifest(manifest);
  checks.cleanupRan = true;
  Object.assign(checks, verifyGone());

  console.log(`Cleanup manifest: ${manifestPath}`);
  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
