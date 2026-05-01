// Per-user CLI state cache at ~/.config/cfcode/.
// Tracks which codebases this user has indexed and their canonical paths.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_DIR = path.join(os.homedir(), ".config/cfcode");

function ensureDir() { fs.mkdirSync(STATE_DIR, { recursive: true }); }
function statePath(slug) { return path.join(STATE_DIR, `${slug}.json`); }

export function readState(slug) {
  const p = statePath(slug);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function writeState(slug, state) {
  ensureDir();
  fs.writeFileSync(statePath(slug), JSON.stringify(state, null, 2), "utf8");
}

export function deleteState(slug) {
  const p = statePath(slug);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function listIndexedRepos() {
  if (!fs.existsSync(STATE_DIR)) return [];
  const slugs = fs.readdirSync(STATE_DIR).filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, ""));
  return slugs.map(slug => ({ slug, ...readState(slug) }));
}
