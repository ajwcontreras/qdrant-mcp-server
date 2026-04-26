#!/usr/bin/env node

const { spawn } = require("node:child_process");

const API_URL = process.env.LAUNCHER_API_URL || "https://intel-launcher.ajwc.cc/runs/parallel";
const PROVIDER = process.env.LAUNCHER_PROVIDER || "deepseek";
const TIMEOUT_MS = Number(process.env.LAUNCHER_TIMEOUT_MS || 240000);

const prompts = [
  {
    sessionId: "parallel-curl-smoke-a",
    prompt: 'Reply with exactly this JSON and no markdown: {"request":"a","ok":true}',
  },
  {
    sessionId: "parallel-curl-smoke-b",
    prompt: 'Reply with exactly this JSON and no markdown: {"request":"b","ok":true}',
  },
];

function runCurl({ prompt, sessionId }) {
  const body = JSON.stringify({ prompt, providers: [PROVIDER], sessionId });
  const args = [
    "-sS",
    "-L",
    "--max-time",
    String(Math.ceil(TIMEOUT_MS / 1000)),
    API_URL,
    "-H",
    "Content-Type: application/json",
    "-H",
    "Accept: application/json, text/plain, */*",
    "-H",
    "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
    "--data-binary",
    "@-",
  ];

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS + 2000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve(parseLauncherResponse({ code, signal, stdout, stderr, startedAt, sessionId }));
    });
    child.stdin.end(body);
  });
}

function parseLauncherResponse({ code, signal, stdout, stderr, startedAt, sessionId }) {
  const elapsedMs = Date.now() - startedAt;
  const base = { sessionId, exitCode: code, signal, elapsedMs };
  if (code !== 0) {
    return { ...base, ok: false, error: stderr.trim() || `curl exited ${code}`, raw: stdout.slice(0, 500) };
  }

  let response;
  try {
    response = JSON.parse(stdout);
  } catch (error) {
    return { ...base, ok: false, error: `launcher JSON parse failed: ${error.message}`, raw: stdout.slice(0, 500) };
  }

  const provider = (response.providers || [])[0] || {};
  if (provider.status !== "success") {
    return {
      ...base,
      ok: false,
      summary: response.summary,
      provider: provider.name,
      providerStatus: provider.status,
      providerError: provider.error,
      replyPreview: String(provider.reply || "").slice(0, 500),
    };
  }

  const reply = stripCodeFence(String(provider.reply || "").trim());
  let replyJson;
  try {
    replyJson = JSON.parse(reply);
  } catch (error) {
    return {
      ...base,
      ok: false,
      summary: response.summary,
      provider: provider.name,
      providerStatus: provider.status,
      error: `reply JSON parse failed: ${error.message}`,
      replyPreview: reply.slice(0, 500),
    };
  }

  return {
    ...base,
    ok: true,
    summary: response.summary,
    provider: provider.name,
    providerStatus: provider.status,
    providerDurationMs: provider.durationMs,
    replyJson,
  };
}

function stripCodeFence(text) {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

async function main() {
  const startedAt = Date.now();
  const results = await Promise.all(prompts.map(runCurl));
  console.log(JSON.stringify({
    ok: results.every((result) => result.ok),
    elapsedMs: Date.now() - startedAt,
    provider: PROVIDER,
    results,
  }, null, 2));
  process.exit(results.every((result) => result.ok) ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
