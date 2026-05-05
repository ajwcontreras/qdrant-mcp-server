import { loadCfEnv } from "../cloudflare-mcp/lib/env.mjs";

const env = loadCfEnv();
const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/dispatch/namespaces/cfcode-codebases/scripts`;

for (const sn of ["cfcode-codebase-reviewer-s-workbench", "cfcode-codebase-lumae-upload-api"]) {
  const headers = { "X-Auth-Email": env.CLOUDFLARE_EMAIL, "X-Auth-Key": env.CLOUDFLARE_API_KEY };
  const res = await fetch(`${base}/${sn}`, { headers });
  const d = await res.json();
  const bindings = d.result?.bindings || [];
  const secrets = bindings.filter(b => b.type === "secret_text");
  console.log(`${sn}: ${secrets.length} secrets`);
  for (const s of secrets) console.log(`  ${s.name}`);
}
