#!/usr/bin/env node
/**
 * POC 26D1: Combined Worker Compiles With All Bindings
 *
 * Proves: A single Worker merging 26D0 safety, 26B Vertex embedding,
 * and 26C4 publication compiles and type-checks. No deploy, no Cloudflare resources.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pocDir = path.resolve(__dirname, "../poc/26d1-full-job-worker");

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: pocDir, encoding: "utf8", stdio: "inherit" });
  return result.status === 0;
}

console.log("POC 26D1: Combined Worker Compiles With All Bindings\n");

const checks = {
  npmInstall: run("npm", ["install"]),
  typeCheck: run("npm", ["run", "check"]),
  noCloudflareResources: true,
};

console.log("\n── Pass Criteria ──");
for (const [name, passed] of Object.entries(checks)) console.log(`  ${name}: ${passed ? "PASS" : "FAIL"}`);
const allPass = Object.values(checks).every(Boolean);
console.log(`\n${allPass ? "✅ POC 26D1: PASS" : "❌ POC 26D1: FAIL"}`);
if (!allPass) process.exit(1);
