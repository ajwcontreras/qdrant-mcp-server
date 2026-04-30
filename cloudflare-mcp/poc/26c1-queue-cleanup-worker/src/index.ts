type Env = {
  TEST_QUEUE: { send(message: { ok: boolean }): Promise<void> };
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cfcode-poc-26c1-queue-cleanup" });
    if (url.pathname === "/send" && request.method === "POST") {
      await env.TEST_QUEUE.send({ ok: true });
      return json({ ok: true, queued: 1 });
    }
    return json({ ok: false, error: "not found" }, 404);
  },
  async queue(): Promise<void> {
    return;
  },
};
