#!/usr/bin/env node
/**
 * POC 11: Vectorize Publication
 *
 * Proves:
 *   An embedding run can publish vectors to Vectorize and record matching
 *   vector IDs in D1.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const pocDir = path.resolve(__dirname, "../poc/11-vectorize-publication-worker");
const sessionDir = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-11");
const cfKeysPath = path.join(repoRoot, ".cfapikeys");
const workerName = "cfcode-poc-11-vectorize-publication";
const indexName = "cfcode-poc-11-vectorize-publication";
const dbName = "cfcode-poc-11-vectorize-publication";
const runId = "85f6cbff932e6f849dbf35c6ab18685b";
const runDir = path.join(repoRoot, "cloudflare-mcp", "sessions", "poc-10", "runs", runId);
const generatedConfig = path.join(pocDir, "wrangler.generated.jsonc");
const publicationManifestPath = path.join(sessionDir, "publication-manifest.json");

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

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function extractDatabaseId(output) {
  const uuid = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!uuid) throw new Error(`Could not find D1 database UUID in output:\n${output}`);
  return uuid[0];
}

function writeGeneratedConfig(databaseId) {
  const template = fs.readFileSync(path.join(pocDir, "wrangler.template.jsonc"), "utf8");
  fs.writeFileSync(generatedConfig, template.replace("__DATABASE_ID__", databaseId), "utf8");
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${init?.method || "GET"} ${url} failed ${response.status}: ${text.slice(0, 500)}`);
  }
  if (data && typeof data === "object" && "raw" in data) {
    throw new Error(`${init?.method || "GET"} ${url} returned non-JSON: ${String(data.raw).slice(0, 300)}`);
  }
  return data;
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 45_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(`${baseUrl}/health`);
      if (health.ok === true) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Worker did not become healthy: ${lastError}`);
}

async function queryUntilVisible(baseUrl, vector) {
  const deadline = Date.now() + 60_000;
  let lastResult = null;
  while (Date.now() < deadline) {
    const query = await fetchJson(`${baseUrl}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: vector.values }),
    });
    lastResult = query;
    if (query.ok === true && query.matches?.[0]?.id === vector.vector_id) return query;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Vectorize query did not return expected vector ${vector.vector_id}: ${JSON.stringify(lastResult)?.slice(0, 800)}`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function loadRunVectors() {
  const manifest = JSON.parse(await fsp.readFile(path.join(runDir, "manifest.json"), "utf8"));
  const vectors = [];
  for (const vector of manifest.vectors) {
    vectors.push(JSON.parse(await fsp.readFile(path.join(runDir, "vectors", `${vector.vector_id}.json`), "utf8")));
  }
  return { manifest, vectors };
}

async function main() {
  console.log("POC 11: Vectorize Publication\n");

  const checks = {
    indexCreate: false,
    dbCreate: false,
    configGenerated: false,
    install: false,
    typecheck: false,
    deploy: false,
    publish: false,
    d1Records: false,
    vectorQuery: false,
    manifest: false,
    cleanupWorker: false,
    cleanupIndex: false,
    cleanupDb: false,
  };

  let baseUrl = "";

  try {
    run("npx", ["wrangler", "vectorize", "create", indexName, "--dimensions=1536", "--metric=cosine"]);
    checks.indexCreate = true;
    const createDb = run("npx", ["wrangler", "d1", "create", dbName], { capture: true });
    const databaseId = extractDatabaseId(`${createDb.stdout}\n${createDb.stderr}`);
    checks.dbCreate = true;
    writeGeneratedConfig(databaseId);
    checks.configGenerated = fs.existsSync(generatedConfig);

    run("npm", ["install"]);
    checks.install = true;
    run("npm", ["run", "check"]);
    checks.typecheck = true;

    const deploy = run("npx", ["wrangler", "deploy", "--config", "wrangler.generated.jsonc"], { capture: true });
    const deployOutput = `${deploy.stdout}\n${deploy.stderr}`;
    const match = deployOutput.match(/https:\/\/[^\s]+workers\.dev/);
    if (!match) throw new Error(`Could not find workers.dev URL in deploy output:\n${deployOutput}`);
    baseUrl = match[0].replace(/\/$/, "");
    checks.deploy = true;
    await waitForHealth(baseUrl);

    const { manifest: runManifest, vectors } = await loadRunVectors();
    const publicationId = `pub-${runManifest.embedding_run_id}`;
    const publish = await fetchJson(`${baseUrl}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publication_id: publicationId,
        embedding_run_id: runManifest.embedding_run_id,
        vectorize_index: indexName,
        vectors,
      }),
    });
    checks.publish = publish.ok === true && publish.vector_count === vectors.length;

    const records = await fetchJson(`${baseUrl}/records?publication_id=${encodeURIComponent(publicationId)}`);
    checks.d1Records = records.ok === true && records.count === vectors.length;

    const query = await queryUntilVisible(baseUrl, vectors[0]);
    checks.vectorQuery = query.ok === true && query.matches?.[0]?.id === vectors[0].vector_id;

    await fsp.mkdir(sessionDir, { recursive: true });
    const publicationManifest = {
      schema_version: "cfcode.publication.v1",
      publication_id: publicationId,
      embedding_run_id: runManifest.embedding_run_id,
      vectorize_indexes: { hyde: indexName },
      d1_database: dbName,
      vector_count: vectors.length,
      vector_ids_hash: sha256(JSON.stringify(vectors.map((vector) => vector.vector_id))),
      active: true,
    };
    await fsp.writeFile(publicationManifestPath, `${JSON.stringify(publicationManifest)}\n`, "utf8");
    checks.manifest = publicationManifest.vector_count === vectors.length && publicationManifest.vectorize_indexes.hyde === indexName;
  } finally {
    try {
      run("npx", ["wrangler", "delete", "--config", "wrangler.generated.jsonc", "--name", workerName, "--force"]);
      checks.cleanupWorker = true;
    } catch (error) {
      const message = stripAnsi(error instanceof Error ? error.message : String(error));
      if (!checks.deploy || message.includes("does not exist") || message.includes("10090")) checks.cleanupWorker = true;
      else console.error(`Worker cleanup failed: ${message}`);
    }
    try {
      run("npx", ["wrangler", "vectorize", "delete", indexName, "--force"]);
      checks.cleanupIndex = true;
    } catch (error) {
      const message = stripAnsi(error instanceof Error ? error.message : String(error));
      if (!checks.indexCreate || message.includes("not_found") || message.includes("3000")) checks.cleanupIndex = true;
      else console.error(`Vectorize cleanup failed: ${message}`);
    }
    try {
      run("npx", ["wrangler", "d1", "delete", dbName, "--skip-confirmation"]);
      checks.cleanupDb = true;
    } catch (error) {
      const message = stripAnsi(error instanceof Error ? error.message : String(error));
      if (!checks.dbCreate || message.includes("not found")) checks.cleanupDb = true;
      else console.error(`D1 cleanup failed: ${message}`);
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
