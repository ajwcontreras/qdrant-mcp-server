#!/usr/bin/env node
/**
 * POC 02: R2 Artifact Bucket Smoke
 *
 * Proves:
 *   A Worker can write/read/delete content-addressed JSON artifacts in R2.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/02-r2-artifact-smoke");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const workerName = "cfcode-poc-02-r2-artifact";
const bucketName = "cfcode-poc-02-r2-artifacts";

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
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return result;
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`${init?.method || "GET"} ${url} failed ${response.status}: ${text.slice(0, 300)}`);
  }
  return { response, data, text };
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 30_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(`${baseUrl}/health`);
      if (health.data?.ok === true) return;
      lastError = JSON.stringify(health.data).slice(0, 200);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Worker did not become healthy: ${lastError}`);
}

async function main() {
  console.log("POC 02: R2 Artifact Bucket Smoke\n");

  const checks = {
    bucketCreate: false,
    install: false,
    typecheck: false,
    deploy: false,
    put: false,
    get: false,
    deleteObject: false,
    cleanupWorker: false,
    cleanupBucket: false,
  };
  let baseUrl = "";

  try {
    try {
      run("npx", ["wrangler", "r2", "bucket", "create", bucketName]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("already exists")) throw error;
    }
    checks.bucketCreate = true;

    run("npm", ["install"]);
    checks.install = true;
    run("npm", ["run", "check"]);
    checks.typecheck = true;

    const deploy = run("npx", ["wrangler", "deploy"], { capture: true });
    const deployOutput = `${deploy.stdout}\n${deploy.stderr}`;
    const match = deployOutput.match(/https:\/\/[^\s]+workers\.dev/);
    if (!match) throw new Error(`Could not find workers.dev URL in deploy output:\n${deployOutput}`);
    baseUrl = match[0].replace(/\/$/, "");
    checks.deploy = true;
    console.log(`Deployed artifact Worker: ${baseUrl}`);
    await waitForHealth(baseUrl);

    const artifact = {
      chunk_identity: "poc-02:example.py:0",
      content_hash: "example-content-hash",
      text: "def example():\n    return 'artifact'",
      line_span: [1, 2],
    };
    const body = JSON.stringify(artifact);
    const expectedHash = crypto.createHash("sha256").update(body).digest("hex");
    const put = await fetchJson(`${baseUrl}/artifact`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
    });
    checks.put = put.data.ok === true && put.data.sha256 === expectedHash;
    const key = put.data.key;

    const got = await fetchJson(`${baseUrl}/artifact?key=${encodeURIComponent(key)}`);
    checks.get = got.text === body && got.response.headers.get("x-artifact-sha256") === expectedHash;

    const deleted = await fetchJson(`${baseUrl}/artifact?key=${encodeURIComponent(key)}`, { method: "DELETE" });
    checks.deleteObject = deleted.data.ok === true;
  } finally {
    try {
      run("npx", ["wrangler", "delete", "--name", workerName, "--force"]);
      checks.cleanupWorker = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("does not exist") || message.includes("code: 10090")) {
        checks.cleanupWorker = true;
      } else {
        console.error(`Worker cleanup failed: ${message}`);
      }
    }
    try {
      run("npx", ["wrangler", "r2", "bucket", "delete", bucketName]);
      checks.cleanupBucket = true;
    } catch (error) {
      console.error(`Bucket cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) {
    console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  }
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
