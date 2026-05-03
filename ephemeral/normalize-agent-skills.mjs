#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const home = os.homedir();
const repoRoot = path.resolve(import.meta.dirname, "..");
const canonicalRoot = path.join(home, ".agents", "skills");
const skillNames = [
  "cloudflare-master",
  "cloudflare-codebase-mcp-indexing",
  "poc-driven-development",
];
const targets = [
  path.join(home, ".claude", "skills"),
  path.join(home, ".codex", "skills"),
  path.join(home, ".config", "opencode", "skills"),
  path.join(home, ".opencode", "skill"),
];

function rmIfExists(p) {
  if (fs.existsSync(p) || fs.lstatSync(path.dirname(p)).isDirectory()) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
}

function ensureSymlink(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  rmIfExists(dest);
  fs.symlinkSync(src, dest, "dir");
  const skillFile = path.join(dest, "SKILL.md");
  if (!fs.existsSync(skillFile)) throw new Error(`missing SKILL.md after link: ${skillFile}`);
}

function seedCanonicalFromFallback(name) {
  const src = path.join(canonicalRoot, name);
  if (fs.existsSync(path.join(src, "SKILL.md"))) return;
  const fallbackRoots = [
    path.join(home, ".codex", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".config", "opencode", "skills"),
    path.join(home, ".opencode", "skill"),
  ];
  const fallback = fallbackRoots.map(root => path.join(root, name)).find(p => fs.existsSync(path.join(p, "SKILL.md")));
  if (!fallback) throw new Error(`canonical skill missing and no fallback found: ${name}`);
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.cpSync(fallback, src, { recursive: true, force: true, dereference: true });
}

const accidentalProjectSkills = path.join(repoRoot, ".agents");
rmIfExists(accidentalProjectSkills);

for (const name of skillNames) {
  seedCanonicalFromFallback(name);
  const src = path.join(canonicalRoot, name);
  if (!fs.existsSync(path.join(src, "SKILL.md"))) throw new Error(`canonical skill missing: ${src}`);
  for (const targetRoot of targets) ensureSymlink(src, path.join(targetRoot, name));
}

console.log("Normalized critical skills:");
for (const targetRoot of targets) {
  console.log(`- ${targetRoot}`);
  for (const name of skillNames) console.log(`  ${name}: ${fs.existsSync(path.join(targetRoot, name, "SKILL.md")) ? "OK" : "MISSING"}`);
}
