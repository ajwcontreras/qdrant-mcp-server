type R2Like = {
  put(key: string, value: string): Promise<unknown>;
};

type D1StatementLike = {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<unknown>;
};

type D1Like = {
  prepare(sql: string): D1StatementLike;
};

type Env = {
  ARTIFACTS: R2Like;
  DB: D1Like;
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, has_r2: Boolean(env.ARTIFACTS), has_d1: Boolean(env.DB) });
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};
