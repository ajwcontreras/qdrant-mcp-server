// Wrangler/git/shell execution helpers.
import { spawnSync } from "node:child_process";
import { loadCfEnv } from "./env.mjs";

// Run a command. Returns { status, stdout, stderr } when capture=true; otherwise inherits stdio.
// Throws on non-zero unless allowFailure=true.
export function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd, env: opts.env || loadCfEnv(),
    encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    input: opts.input,
  });
  if (result.status !== 0 && !opts.allowFailure) {
    const out = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(`${cmd} ${args.join(" ")} failed${out ? `:\n${out}` : ""}`);
  }
  return result;
}

export function git(repoPath, args, opts = {}) {
  return run("git", args, { cwd: repoPath, capture: true, ...opts });
}
