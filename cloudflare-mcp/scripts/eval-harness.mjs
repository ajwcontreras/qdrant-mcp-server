#!/usr/bin/env node
// Golden eval harness for cfcode search quality.
// Usage: node cloudflare-mcp/scripts/eval-harness.mjs <slug> [golden-queries.json]
// Golden queries format: [{ "query": "...", "answer_files": ["path/to/file.ts"] }]

import { repoSlugFromPath } from "../lib/env.mjs";
import { GATEWAY_URL, proxyToCodebase, listCodebases } from "../lib/gateway.mjs";
import { loadCfEnv } from "../lib/env.mjs";

Object.assign(process.env, loadCfEnv());

function log(msg) { console.log(msg); }

function dcg(scores, k) {
  let d = scores[0] || 0;
  for (let i = 1; i < Math.min(k, scores.length); i++) d += scores[i] / Math.log2(i + 2);
  return d;
}

function ndcg(relevance, k) {
  const ideal = [...relevance].sort((a, b) => b - a);
  const d = dcg(relevance, k);
  const id = dcg(ideal, k);
  return id === 0 ? 0 : d / id;
}

async function runEval(slug, queries) {
  log(`\n📊 Eval: ${slug}`);
  log(`   ${queries.length} golden queries\n`);

  let totalRecall5 = 0, totalRecall10 = 0, totalMRR = 0, totalNDCG = 0;
  const perQuery = [];

  for (const q of queries) {
    const t0 = Date.now();
    const res = await proxyToCodebase(slug, "/search-hybrid", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: q.query, repo_slug: slug, topK: 10 }),
    });

    if (!res?.ok) { perQuery.push({ query: q.query, error: res?.error || "failed" }); continue; }

    const matches = res.matches || [];
    const answerSet = new Set(q.answer_files);

    // Recall@K: did any answer file appear in top K?
    let recall5 = 0, recall10 = 0, mrr = 0;
    const relevance = [];

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const fp = m.chunk?.file_path || "";
      const rel = answerSet.has(fp) ? 1 : 0;
      relevance.push(rel);

      if (rel) {
        if (i < 5) recall5 = 1;
        if (i < 10) recall10 = 1;
        if (mrr === 0) mrr = 1 / (i + 1);
      }
    }

    totalRecall5 += recall5;
    totalRecall10 += recall10;
    totalMRR += mrr;
    totalNDCG += ndcg(relevance, 10);

    perQuery.push({
      query: q.query,
      latency_ms: Date.now() - t0,
      recall5, recall10, mrr: mrr.toFixed(4),
      top_hits: matches.slice(0, 5).map(m => m.chunk?.file_path),
    });
  }

  const n = queries.length;
  log(`   Recall@5:  ${(totalRecall5 / n).toFixed(3)}`);
  log(`   Recall@10: ${(totalRecall10 / n).toFixed(3)}`);
  log(`   MRR:       ${(totalMRR / n).toFixed(3)}`);
  log(`   nDCG@10:   ${(totalNDCG / n).toFixed(3)}`);
  log(`   queries:   ${n}`);

  return { slug, recall5: totalRecall5 / n, recall10: totalRecall10 / n, mrr: totalMRR / n, ndcg: totalNDCG / n, perQuery };
}

// Build reasonable golden queries for a codebase
function generateQueries(repoPath, slug) {
  // Core architectural questions that any codebase should answer
  return [
    { query: "how is the main server or entry point set up", answer_files: [] },
    { query: "how are API requests handled", answer_files: [] },
    { query: "how is configuration loaded", answer_files: [] },
    { query: "how is authentication implemented", answer_files: [] },
    { query: "what are the main data types or schemas", answer_files: [] },
    { query: "how does error handling work", answer_files: [] },
    { query: "how are external services called", answer_files: [] },
  ];
}

async function main() {
  const args = process.argv.slice(2);
  const slug = args[0] || "cfpubsub-scaffold";

  const all = await listCodebases();
  const reg = all.find(c => c.slug === slug);
  if (!reg) { log(`Not registered: ${slug}`); process.exit(1); }

  const queries = args[1]
    ? JSON.parse(await import("fs").then(fs => fs.readFileSync(args[1], "utf8")))
    : generateQueries(reg.indexed_path, slug);

  const result = await runEval(slug, queries);
  // Write results
  const outPath = `cloudflare-mcp/sessions/eval-${slug}-${Date.now().toString(36)}.json`;
  await import("fs").then(fs => fs.writeFileSync(outPath, JSON.stringify(result, null, 2)));
  log(`\n   Saved: ${outPath}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
