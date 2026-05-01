// Cloudflare credentials loader + repo slug derivation.
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const CF_KEYS_PATH = path.join(REPO_ROOT, ".cfapikeys");

export function loadCfEnv() {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  if (!fs.existsSync(CF_KEYS_PATH)) throw new Error(`.cfapikeys not found at ${CF_KEYS_PATH}`);
  for (const line of fs.readFileSync(CF_KEYS_PATH, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    const v = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
    if (k.trim() === "CF_GLOBAL_API_KEY") env.CLOUDFLARE_API_KEY = v;
    if (k.trim() === "CF_EMAIL") env.CLOUDFLARE_EMAIL = v;
    if (k.trim() === "CF_ACCOUNT_ID") env.CLOUDFLARE_ACCOUNT_ID = v;
  }
  return env;
}

// Derive a Cloudflare-resource-friendly slug from a repo path.
// "/Users/me/PROJECTS/foo-bar" -> "foo-bar"
// Lowercase, alphanumeric + hyphens, trimmed to 40 chars.
export function repoSlugFromPath(repoPath) {
  const base = path.basename(path.resolve(repoPath));
  const slug = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!slug) throw new Error(`could not derive slug from ${repoPath}`);
  return slug;
}

export function workerNameForSlug(slug) { return `cfcode-${slug}`; }
export function r2BucketForSlug(slug) { return `cfcode-${slug}-artifacts`; }
export function d1NameForSlug(slug) { return `cfcode-${slug}`; }
export function vectorizeIndexForSlug(slug) { return `cfcode-${slug}`; }
export function queueNameForSlug(slug) { return `cfcode-${slug}-work`; }
export function dlqNameForSlug(slug) { return `cfcode-${slug}-work-dlq`; }
