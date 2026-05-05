// Re-set SA and DeepSeek secrets after deploy on the 3 partial codebase workers.
import { setNamespaceWorkerSecret } from "../cloudflare-mcp/lib/wfp-secret.mjs";
import { loadCfEnv } from "../cloudflare-mcp/lib/env.mjs";
import fs from "node:fs";

const NAMESPACE = "cfcode-codebases";
const SA_PATH = "/Users/awilliamspcsevents/Downloads/team (1).json";
const saB64 = Buffer.from(fs.readFileSync(SA_PATH, "utf8")).toString("base64");

const workers = [
  "cfcode-codebase-mortgage-rag",
  "cfcode-codebase-lumae-upload-api",
  "cfcode-codebase-income-scout-bun",
];

const env = loadCfEnv();
const deepseekKey = process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY;

for (const scriptName of workers) {
  console.log(`Setting secrets on ${scriptName}...`);
  try {
    await setNamespaceWorkerSecret({ namespaceName: NAMESPACE, scriptName, secretName: "GEMINI_SERVICE_ACCOUNT_B64", secretValue: saB64 });
    console.log(`  GEMINI_SERVICE_ACCOUNT_B64: OK`);
  } catch (e) { console.log(`  GEMINI_SERVICE_ACCOUNT_B64 FAILED: ${e.message}`); }
  try {
    await setNamespaceWorkerSecret({ namespaceName: NAMESPACE, scriptName, secretName: "DEEPSEEK_API_KEY", secretValue: deepseekKey });
    console.log(`  DEEPSEEK_API_KEY: OK`);
  } catch (e) { console.log(`  DEEPSEEK_API_KEY FAILED: ${e.message}`); }
}
