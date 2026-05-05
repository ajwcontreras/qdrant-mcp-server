// Set DEEPSEEK_API_KEY secret on all 4 new codebase workers.
import { setNamespaceWorkerSecret } from "../cloudflare-mcp/lib/wfp-secret.mjs";
import { loadCfEnv } from "../cloudflare-mcp/lib/env.mjs";

const NAMESPACE = "cfcode-codebases";

const workers = [
  "cfcode-codebase-mortgage-rag",
  "cfcode-codebase-lumae-upload-api",
  "cfcode-codebase-income-scout-bun",
  "cfcode-codebase-reviewer-s-workbench",
];

const env = loadCfEnv();
const deepseekKey = process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY;
if (!deepseekKey) throw new Error("DEEPSEEK_API_KEY not found in env or .cfapikeys");

for (const scriptName of workers) {
  console.log(`Setting DEEPSEEK_API_KEY on ${scriptName}...`);
  try {
    await setNamespaceWorkerSecret({
      namespaceName: NAMESPACE,
      scriptName,
      secretName: "DEEPSEEK_API_KEY",
      secretValue: deepseekKey,
    });
    console.log(`  OK`);
  } catch (e) {
    console.log(`  FAILED: ${e.message}`);
  }
}
