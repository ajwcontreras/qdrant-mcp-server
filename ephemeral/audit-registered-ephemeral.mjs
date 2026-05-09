#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const out = execFileSync("cfcode", ["list"], { encoding: "utf8" });
const rows = out.trim().split("\n").filter(Boolean).map(line => {
  const [slug, indexedPath] = line.split("\t");
  return { slug, indexedPath };
});

for (const row of rows) {
  if (!row.indexedPath || !fs.existsSync(row.indexedPath)) {
    console.log(`${row.slug}\tMISSING\t${row.indexedPath || ""}\t0`);
    continue;
  }
  let files = [];
  try {
    const tracked = execFileSync("git", ["-C", row.indexedPath, "ls-files", "ephemeral"], { encoding: "utf8" });
    files = tracked.trim().split("\n").filter(Boolean);
  } catch {
    console.log(`${row.slug}\tNOT_GIT\t${row.indexedPath}\t0`);
    continue;
  }
  const sample = files.slice(0, 3).join(",");
  console.log(`${row.slug}\t${files.length ? "HAS_EPHEMERAL" : "clean"}\t${row.indexedPath}\t${files.length}\t${sample}`);
}
