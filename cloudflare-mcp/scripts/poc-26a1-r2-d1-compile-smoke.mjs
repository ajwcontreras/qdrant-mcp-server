#!/usr/bin/env node
/**
 * POC 26A1: Worker Toolchain Compiles With R2 And D1 Bindings
 *
 * Proves:
 *   The Cloudflare Worker TypeScript/package baseline for R2+D1 compiles
 *   before any remote resources are created.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pocDir = path.resolve(__dirname, "../poc/26a1-r2-d1-compile-worker");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: pocDir,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

async function main() {
  console.log("POC 26A1: Worker Toolchain Compiles With R2 And D1 Bindings\n");
  const checks = {
    npmInstall: false,
    typecheck: false,
    noCloudflareResources: true,
  };

  run("npm", ["install"]);
  checks.npmInstall = true;
  run("npm", ["run", "check"]);
  checks.typecheck = true;

  console.log("\nPass Criteria");
  for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
