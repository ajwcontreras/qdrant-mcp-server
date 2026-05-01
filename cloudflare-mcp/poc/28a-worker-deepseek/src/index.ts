// POC 28A: Worker calls DeepSeek v4-pro for HyDE (12 questions per chunk).
// Stable system prompt → second call should hit DeepSeek prompt cache.
type Env = { DEEPSEEK_API_KEY: string };

const SYSTEM_PROMPT = `You are a senior software engineer generating hypothetical questions a developer would ask to find a specific code chunk.

Given a chunk of source code, output exactly 12 short, varied questions a developer might type into a code search box to find this chunk. Questions should:

- Span symbol queries ("how is X implemented"), behavior queries ("how do we handle Y"), pattern queries ("where do we Z"), and bug-style queries ("what catches edge case W").
- Be 5-15 words each.
- NOT quote the code or use the exact identifiers as the only signal.
- Be a mix of natural-language and snake_case/camelCase styles when relevant.
- Avoid generic filler like "what does this code do".

Return ONLY a JSON object: {"questions": [string × 12]}`;

type DeepSeekResponse = {
  choices: Array<{ message: { content: string } }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
};

async function generateHyde(env: Env, text: string): Promise<{ questions: string[]; usage: DeepSeekResponse["usage"]; ms: number }> {
  const start = Date.now();
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Source code chunk:\n\n${text}` },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 1500,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`DeepSeek ${res.status}: ${t.slice(0, 400)}`);
  }
  const body = (await res.json()) as DeepSeekResponse;
  const content = body.choices?.[0]?.message?.content || "";
  let parsed: { questions?: string[] };
  try { parsed = JSON.parse(content); } catch { throw new Error(`bad JSON from DeepSeek: ${content.slice(0, 300)}`); }
  const questions = Array.isArray(parsed.questions) ? parsed.questions.filter(q => typeof q === "string" && q.length > 0) : [];
  return { questions, usage: body.usage, ms: Date.now() - start };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "28a-worker-deepseek" });
    if (url.pathname === "/hyde" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { text?: string };
      if (!body.text) return Response.json({ ok: false, error: "text required" }, { status: 400 });
      try {
        const r = await generateHyde(env, body.text);
        return Response.json({ ok: true, ...r });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({ ok: false, error: msg }, { status: 500 });
      }
    }
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  },
};
