import { DurableObject } from "cloudflare:workers";

type WorkerEnv = Env & {
  OPENAI_API_KEY: string;
  OPENAI_FALLBACK_API_KEY?: string;
  AI_GATEWAY_TOKEN?: string;
  CF_AIG_TOKEN?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_MAX_BATCH_SIZE?: string;
  HYDE_PROVIDER?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_MAX_OUTPUT_TOKENS?: string;
  DEEPSEEK_PROVIDER_BATCH_SIZE?: string;
  DEEPSEEK_PROVIDER_CONCURRENCY?: string;
  GEMINI_BASE_URL?: string;
  GEMINI_MODEL?: string;
  HYDE_ALLOWED_MODELS?: string;
  GEMINI_PROJECT?: string;
  GEMINI_LOCATION?: string;
  GEMINI_EMBEDDING_LOCATION?: string;
  GOOGLE_CLOUD_LOCATION?: string;
  GEMINI_MAX_OUTPUT_TOKENS?: string;
  GEMINI_SERVICE_ACCOUNT_B64?: string;
  EMBEDDING_PROVIDER?: string;
  EMBEDDING_CONCURRENCY?: string;
  EMBEDDING_TASK_TYPE?: string;
  EMBEDDING_OUTPUT_DIMENSIONALITY?: string;
  BATCH_AUTH_TOKEN: string;
  OPENAI_STATE: KVNamespace;
  JOBS_BUCKET: R2Bucket;
  JOB_COORDINATOR: DurableObjectNamespace<HyDEJobCoordinator>;
};

interface HyDEBatchItem {
  id: string;
  rel_path: string;
  text: string;
}

interface HyDEBatchRequest {
  items: HyDEBatchItem[];
  model?: string;
  question_count?: number;
  provider_batch_size?: number;
  provider_concurrency?: number;
}

interface EmbeddingBatchRequest {
  texts: string[];
  model?: string;
}

interface EmbeddingBatchResult {
  ok: boolean;
  count: number;
  model: string;
  active_key: OpenAIKeyName;
  elapsed_ms: number;
  cf_ray?: string;
  embeddings: number[][];
}

interface HyDEJobStartRequest {
  job_id?: string;
  batch_size?: number;
}

interface HyDEJobShardRequest {
  seq?: number;
  items: HyDEBatchItem[];
}

interface HyDEJobCommitRequest {
  expected_shards?: number;
}

interface HyDEBatchResult {
  id: string;
  rel_path: string;
  ok: boolean;
  active_key: OpenAIKeyName;
  model: string;
  provider: HyDEProviderName;
  response_json_valid: boolean;
  response_schema_valid: boolean;
  hyde_questions: string[];
  hyde_text: string;
  elapsed_ms?: number;
  cf_ray?: string;
  error?: string;
}

type OpenAIKeyName = "primary" | "fallback";
type HyDEProviderName = "openai" | "gemini_vertex";
type EmbeddingProviderName = "openai" | "gemini_vertex";
type DeepSeekBatchRecord = {
  id: string;
  rel_path: string;
  ok: boolean;
  model: string;
  provider: "deepseek";
  hyde_questions: string[];
  hyde_text: string;
  elapsed_ms?: number;
  error?: string;
};

interface OpenAIKeyState {
  activeKey: OpenAIKeyName;
}

interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let googleAccessTokenCache: { token: string; expiresAt: number } | undefined;

interface OpenAIResult {
  ok: boolean;
  status: number;
  text: string;
  keyName: OpenAIKeyName;
  elapsedMs: number;
  cfRay?: string;
  data?: unknown;
}

interface ProviderResult {
  questions: string[];
  keyName: OpenAIKeyName;
  provider: HyDEProviderName;
  model: string;
  elapsedMs: number;
  cfRay?: string;
}

interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface JobState {
  job_id: string;
  status: "open" | "running" | "done" | "failed";
  batch_size: number;
  submitted_shards: number;
  submitted_items: number;
  processed_shards: number;
  processed_items: number;
  failed_shards: number;
  expected_shards?: number;
  last_error?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

interface JobShardState {
  seq: number;
  count: number;
  status: "pending" | "processing" | "done" | "failed";
  attempts: number;
  error?: string;
  processing_started_at?: string;
  lease_expires_at?: string;
  worker_id?: string;
  updated_at: string;
}

const SHARD_PROCESSING_LEASE_MS = 10 * 60 * 1000;
const PROCESS_LOOP_BUDGET_MS = 13_000;

const HYDE_DEVELOPER_PROMPT = `You are building a RAG system for an autonomous coding agent. Given a code chunk, generate highly technical, targeted search queries and questions that an agentic tool would realistically ask to locate this specific logic within a massive codebase.

Generate questions that are grounded in identifiers, data keys, branches, external APIs, side effects, failure modes, and integration boundaries visible in the chunk. Prefer exact names over broad descriptions.

Good HyDE questions should cover a useful mix of:
- exact symbol/function/class lookup
- callers/callees and route/task/tool wiring
- payload/request/response schemas and important keys
- state mutation, persistence, cache, lock, retry, or concurrency behavior
- deletion/cleanup/idempotency and incremental-update mechanics
- error handling and edge cases
- tests or verification points

Do not invent project-specific facts that are not suggested by the code. Avoid generic questions such as "what does this function do?" or "how does error handling work?" Do not ask only high-level architectural questions. Each question should be plausible as a search query an autonomous coding agent would issue while debugging or extending this exact chunk.

Each question must be a complete natural-language sentence. Do not end questions with dangling punctuation or raw code/schema fragments. It is fine to mention short exact identifiers or payload keys, but do not paste unfinished JSON/dict literals into questions.

Return only strict JSON matching the requested schema. Each question should be specific enough that a semantic code search over HyDE question embeddings can retrieve this exact chunk.`;

const HYDE_EXAMPLE_CODE = `File: services/search_indexer.py

def sync_document_chunks(document_id, chunks, qdrant_client, embedding_client):
    existing = qdrant_client.scroll(
        collection_name="documents",
        scroll_filter=Filter(must=[FieldCondition(key="document_id", match=MatchValue(value=document_id))]),
        with_payload=["chunk_hash", "chunk_index"],
        with_vectors=False,
    )
    expected_ids = set()
    pending = []
    for index, text in enumerate(chunks):
        chunk_hash = sha256(text.encode("utf-8")).hexdigest()
        point_id = str(uuid5(INDEX_NAMESPACE, f"{document_id}:{index}"))
        expected_ids.add(point_id)
        if existing.get(point_id, {}).get("chunk_hash") == chunk_hash:
            continue
        pending.append({"id": point_id, "text": text, "chunk_hash": chunk_hash, "chunk_index": index})

    stale_ids = [point_id for point_id in existing if point_id not in expected_ids]
    if stale_ids:
        qdrant_client.delete(collection_name="documents", points_selector=PointIdsList(points=stale_ids), wait=True)

    vectors = embedding_client.embed_documents([item["text"] for item in pending])
    qdrant_client.upsert(
        collection_name="documents",
        points=[
            PointStruct(
                id=item["id"],
                vector=vector,
                payload={"document_id": document_id, "chunk_index": item["chunk_index"], "chunk_hash": item["chunk_hash"]},
            )
            for item, vector in zip(pending, vectors)
        ],
        wait=True,
    )`;

const HYDE_EXAMPLE_RESPONSE = {
  hyde_questions: [
    { question: "Where is sync_document_chunks called, and what object types are expected for qdrant_client.scroll/delete/upsert and embedding_client.embed_documents?" },
    { question: "How does the document chunk indexer compare existing payload['chunk_hash'] against freshly computed sha256 hashes to skip unchanged chunks?" },
    { question: "Find the Qdrant scroll filter that loads points by document_id without vectors and returns chunk_hash/chunk_index payload fields for incremental indexing." },
    { question: "Where are deterministic uuid5 point IDs generated from document_id and chunk index, and what happens to IDs when chunk ordering changes?" },
    { question: "Which cleanup logic deletes stale Qdrant point IDs with PointIdsList when a document shrinks or removes chunks?" },
    { question: "What payload schema is written to the documents collection during qdrant_client.upsert, especially document_id, chunk_index, and chunk_hash?" },
    { question: "How does the indexer avoid embedding unchanged chunks, and where are pending chunks batched before embedding_client.embed_documents is called?" },
    { question: "What tests should cover idempotent reruns of sync_document_chunks, stale ID deletion, and chunk_hash mismatch re-embedding behavior?" }
  ]
};

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      return await routeRequest(request, env, ctx);
    } catch (error) {
      const url = new URL(request.url);
      const status = workerErrorStatus(error);
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        message: "worker_request_failed",
        path: url.pathname,
        status,
        error: message
      }));
      return jsonResponse({ ok: false, error: status === 400 ? "bad_request" : "internal_error", message }, status);
    }
  }
} satisfies ExportedHandler<WorkerEnv>;

async function routeRequest(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return jsonResponse({ ok: true, service: "qdrant-openai-batch" });
  }

  if (url.pathname === "/state") {
    if (!isAuthorized(request, env)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    return jsonResponse(await readOpenAIState(env));
  }

  if (url.pathname === "/jobs" || url.pathname.startsWith("/jobs/")) {
    if (!isAuthorized(request, env)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    return handleJobRequest(request, env);
  }

  if (url.pathname === "/embed-batch") {
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    if (!isAuthorized(request, env)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    return handleEmbeddingBatch(request, env, ctx);
  }

  if (url.pathname === "/deepseek-hyde-batch") {
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    if (!isAuthorized(request, env)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    return handleDeepSeekHyDEBatch(request, env);
  }

  if (url.pathname !== "/hyde-batch") {
    return jsonResponse({ error: "not_found" }, 404);
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  if (!isAuthorized(request, env)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const payload = await readJson(request) as HyDEBatchRequest;
  const items = validateBatch(payload, intEnv(env.MAX_BATCH_SIZE, 25));
  const modelOverride = validateHyDEModelOverride(payload.model, env);
  const concurrency = Math.min(Math.max(1, intEnv(env.OPENAI_CONCURRENCY, 6)), 6);
  const startedAt = Date.now();
  const results = await mapLimit(items, concurrency, (item) => generateHyDE(item, env, ctx, undefined, undefined, modelOverride));
  const failures = results.filter((item) => !item.ok).length;

  return jsonResponse({
    ok: failures === 0,
    count: results.length,
    failures,
    elapsed_ms: Date.now() - startedAt,
    results
  }, failures ? 207 : 200);
}

async function handleDeepSeekHyDEBatch(request: Request, env: WorkerEnv): Promise<Response> {
  const payload = await readJson(request) as HyDEBatchRequest;
  const items = validateBatch(payload, Math.max(1, intEnv(env.MAX_BATCH_SIZE, 25) * 4));
  const questionCount = clampInt(payload.question_count, 1, 20, intEnv(env.HYDE_QUESTION_COUNT, 12));
  const providerBatchSize = clampInt(
    payload.provider_batch_size,
    1,
    50,
    intEnv(env.DEEPSEEK_PROVIDER_BATCH_SIZE, 10)
  );
  const providerConcurrency = clampInt(
    payload.provider_concurrency,
    1,
    6,
    intEnv(env.DEEPSEEK_PROVIDER_CONCURRENCY, 6)
  );
  const model = payload.model || env.DEEPSEEK_MODEL || "deepseek-v4-flash";
  const startedAt = Date.now();
  const batches = splitItems(items, providerBatchSize);
  const nested = await mapLimit(
    batches,
    providerConcurrency,
    (batch) => requestDeepSeekHyDEQuestions(batch, env, model, questionCount)
  );
  const results = nested.flat();
  const failures = results.filter((item) => !item.ok).length;
  return jsonResponse({
    ok: failures === 0,
    count: results.length,
    failures,
    elapsed_ms: Date.now() - startedAt,
    model,
    provider_batch_size: providerBatchSize,
    provider_concurrency: providerConcurrency,
    results
  }, failures ? 207 : 200);
}

function workerErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/^(Expected application\/json|Request body must|items length|Invalid item|texts length|Invalid text|missing_)/.test(message)) {
    return 400;
  }
  return 500;
}

export class HyDEJobCoordinator extends DurableObject<WorkerEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split("/").filter(Boolean)[0] || "status";

    if (request.method === "POST" && action === "start") {
      return jsonResponse(await this.startJob(await readOptionalJson<HyDEJobStartRequest>(request)));
    }
    if (request.method === "POST" && action === "shard") {
      return jsonResponse(await this.addShard(await readJson(request) as HyDEJobShardRequest));
    }
    if (request.method === "POST" && action === "commit") {
      return jsonResponse(await this.commitJob(await readOptionalJson<HyDEJobCommitRequest>(request)));
    }
    if (request.method === "POST" && action === "run") {
      return jsonResponse(await this.processAvailableShards());
    }
    if (request.method === "GET" && action === "status") {
      return jsonResponse(await this.readState());
    }
    if (request.method === "GET" && action === "result") {
      const seq = Number.parseInt(url.searchParams.get("seq") || "", 10);
      if (!Number.isFinite(seq)) {
        return jsonResponse({ error: "missing_seq" }, 400);
      }
      return this.readResult(seq);
    }
    return jsonResponse({ error: "not_found" }, 404);
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    try {
      await this.processAvailableShards();
    } catch (error) {
      const retryCount = alarmInfo?.retryCount ?? 0;
      await this.recordFailure(error);
      if (retryCount >= 5) {
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
        return;
      }
      throw error;
    }
  }

  private async startJob(request: HyDEJobStartRequest): Promise<JobState> {
    const now = new Date().toISOString();
    const existing = await this.ctx.storage.get<JobState>("state");
    if (existing && existing.status !== "done" && existing.status !== "failed") {
      return existing;
    }
    const state: JobState = {
      job_id: request.job_id || crypto.randomUUID(),
      status: "open",
      batch_size: clampInt(request.batch_size, 1, 250, intEnv(this.env.MAX_BATCH_SIZE, 25)),
      submitted_shards: 0,
      submitted_items: 0,
      processed_shards: 0,
      processed_items: 0,
      failed_shards: 0,
      created_at: now,
      updated_at: now
    };
    await this.ctx.storage.put("state", state);
    return state;
  }

  private async addShard(request: HyDEJobShardRequest): Promise<{ state: JobState; shard: JobShardState }> {
    const state = await this.requireState();
    if (state.status !== "open") {
      throw new Error(`Cannot add shard while job status is ${state.status}`);
    }
    const items = validateBatch({ items: request.items }, Math.max(1, intEnv(this.env.MAX_BATCH_SIZE, 25) * 20));
    const seq = Number.isFinite(request.seq) ? Number(request.seq) : state.submitted_shards;
    if (!Number.isInteger(seq) || seq < 0) {
      throw new Error("Shard seq must be a non-negative integer");
    }
    const existingShard = await this.ctx.storage.get<JobShardState>(shardKey(seq));
    if (existingShard) {
      throw new Error(`Shard ${seq} already exists with status ${existingShard.status}`);
    }
    const existingInput = await this.env.JOBS_BUCKET.head(inputKey(state.job_id, seq));
    if (existingInput) {
      throw new Error(`Shard ${seq} input already exists in R2`);
    }
    const now = new Date().toISOString();
    const shard: JobShardState = {
      seq,
      count: items.length,
      status: "pending",
      attempts: 0,
      updated_at: now
    };
    await this.ctx.storage.put(shardKey(seq), shard);
    try {
      await this.env.JOBS_BUCKET.put(inputKey(state.job_id, seq), JSON.stringify({ items }), {
        httpMetadata: { contentType: "application/json" }
      });
    } catch (error) {
      await this.ctx.storage.delete(shardKey(seq));
      throw error;
    }
    state.submitted_shards = Math.max(state.submitted_shards, seq + 1);
    state.submitted_items += items.length;
    state.updated_at = now;
    await this.ctx.storage.put("state", state);
    return { state, shard };
  }

  private async commitJob(request: HyDEJobCommitRequest): Promise<JobState> {
    const state = await this.requireState();
    const expectedShards = request.expected_shards ?? state.submitted_shards;
    if (expectedShards !== state.submitted_shards) {
      throw new Error(`expected_shards (${expectedShards}) must equal submitted_shards (${state.submitted_shards})`);
    }
    const now = new Date().toISOString();
    state.status = state.status === "done" ? "done" : "running";
    state.expected_shards = expectedShards;
    state.updated_at = now;
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return state;
  }

  private async processAvailableShards(): Promise<JobState> {
    const startedAt = Date.now();
    const state = await this.requireState();
    if (state.status === "done" || state.status === "failed") {
      return state;
    }
    state.status = "running";
    await this.ctx.storage.put("state", state);

    while (Date.now() - startedAt < PROCESS_LOOP_BUDGET_MS) {
      const next = await this.nextPendingShard();
      if (!next) {
        break;
      }
      await this.processShard(state, next);
    }

    const refreshed = await this.requireState();
    if (await this.hasPendingShards(refreshed)) {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    } else if (refreshed.expected_shards !== undefined && refreshed.processed_shards + refreshed.failed_shards >= refreshed.expected_shards) {
      refreshed.status = refreshed.failed_shards > 0 ? "failed" : "done";
      refreshed.completed_at = new Date().toISOString();
      refreshed.updated_at = refreshed.completed_at;
      await this.ctx.storage.put("state", refreshed);
      await this.ctx.storage.deleteAlarm();
    }
    return this.requireState();
  }

  private async processShard(state: JobState, shard: JobShardState): Promise<void> {
    const now = new Date().toISOString();
    const output = await this.env.JOBS_BUCKET.head(outputKey(state.job_id, shard.seq));
    if (output) {
      await this.markShardDone(state, shard, now);
      return;
    }
    const workerId = crypto.randomUUID();
    shard.status = "processing";
    shard.attempts += 1;
    shard.processing_started_at = now;
    shard.lease_expires_at = new Date(Date.now() + SHARD_PROCESSING_LEASE_MS).toISOString();
    shard.worker_id = workerId;
    shard.updated_at = now;
    await this.ctx.storage.put(shardKey(shard.seq), shard);

    try {
      const object = await this.env.JOBS_BUCKET.get(inputKey(state.job_id, shard.seq));
      if (!object) {
        throw new Error(`Missing input shard ${shard.seq}`);
      }
      const input = await object.json<HyDEBatchRequest>();
      const maxBatchSize = intEnv(this.env.MAX_BATCH_SIZE, 25);
      const concurrency = Math.min(Math.max(1, intEnv(this.env.OPENAI_CONCURRENCY, 6)), 6);
      const results: HyDEBatchResult[] = [];
      for (let start = 0; start < input.items.length; start += maxBatchSize) {
        const window = input.items.slice(start, start + maxBatchSize);
        results.push(...await mapLimit(window, concurrency, (item) => generateHyDE(item, this.env, this.ctx, state.job_id, shard.seq)));
      }
      await this.env.JOBS_BUCKET.put(outputKey(state.job_id, shard.seq), JSON.stringify({ results }), {
        httpMetadata: { contentType: "application/json" }
      });
      await this.markShardDone(state, shard, new Date().toISOString());
    } catch (error) {
      shard.status = "failed";
      shard.error = error instanceof Error ? error.message : String(error);
      shard.processing_started_at = undefined;
      shard.lease_expires_at = undefined;
      shard.worker_id = undefined;
      shard.updated_at = new Date().toISOString();
      await this.ctx.storage.put(shardKey(shard.seq), shard);
      state.failed_shards += 1;
      state.last_error = shard.error;
      state.updated_at = shard.updated_at;
      await this.ctx.storage.put("state", state);
    }
  }

  private async nextPendingShard(): Promise<JobShardState | undefined> {
    const shards = await this.ctx.storage.list<JobShardState>({ prefix: "shard:" });
    const now = Date.now();
    return Array.from(shards.values())
      .filter((shard) => shard.status === "pending" || isExpiredProcessingShard(shard, now))
      .sort((a, b) => a.seq - b.seq)[0];
  }

  private async markShardDone(state: JobState, shard: JobShardState, now: string): Promise<void> {
    const latest = await this.ctx.storage.get<JobShardState>(shardKey(shard.seq));
    if (latest?.status === "done") {
      return;
    }
    shard.status = "done";
    shard.error = undefined;
    shard.processing_started_at = undefined;
    shard.lease_expires_at = undefined;
    shard.worker_id = undefined;
    shard.updated_at = now;
    await this.ctx.storage.put(shardKey(shard.seq), shard);
    state.processed_shards += 1;
    state.processed_items += shard.count;
    state.updated_at = now;
    await this.ctx.storage.put("state", state);
  }

  private async hasPendingShards(state: JobState): Promise<boolean> {
    if (state.expected_shards === undefined || state.submitted_shards < state.expected_shards) {
      return true;
    }
    return Boolean(await this.nextPendingShard());
  }

  private async readState(): Promise<{ state?: JobState; shards: JobShardState[] }> {
    const state = await this.ctx.storage.get<JobState>("state");
    const shards = await this.ctx.storage.list<JobShardState>({ prefix: "shard:" });
    return { state, shards: Array.from(shards.values()).sort((a, b) => a.seq - b.seq) };
  }

  private async readResult(seq: number): Promise<Response> {
    const state = await this.requireState();
    const object = await this.env.JOBS_BUCKET.get(outputKey(state.job_id, seq));
    if (!object) {
      return jsonResponse({ error: "result_not_found", seq }, 404);
    }
    return new Response(object.body, {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "etag": object.httpEtag
      }
    });
  }

  private async requireState(): Promise<JobState> {
    const state = await this.ctx.storage.get<JobState>("state");
    if (!state) {
      throw new Error("Job has not been started");
    }
    return state;
  }

  private async recordFailure(error: unknown): Promise<void> {
    const state = await this.ctx.storage.get<JobState>("state");
    if (!state) {
      return;
    }
    state.last_error = error instanceof Error ? error.message : String(error);
    state.updated_at = new Date().toISOString();
    await this.ctx.storage.put("state", state);
  }
}

async function handleJobRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (request.method === "POST" && parts.length === 1) {
    const body = await readOptionalJson<HyDEJobStartRequest>(request);
    const jobId = body.job_id || crypto.randomUUID();
    const stub = env.JOB_COORDINATOR.get(env.JOB_COORDINATOR.idFromName(jobId));
    return stub.fetch(new Request(new URL("/start", url.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, job_id: jobId })
    }));
  }

  const jobId = parts[1];
  if (!jobId) {
    return jsonResponse({ error: "missing_job_id" }, 400);
  }
  const stub = env.JOB_COORDINATOR.get(env.JOB_COORDINATOR.idFromName(jobId));
  const action = parts[2] || "status";
  if (request.method === "POST" && action === "shards") {
    return stub.fetch(new Request(new URL("/shard", url.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await request.text()
    }));
  }
  if (request.method === "POST" && action === "commit") {
    return stub.fetch(new Request(new URL("/commit", url.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await request.text()
    }));
  }
  if (request.method === "POST" && action === "run") {
    return stub.fetch(new Request(new URL("/run", url.origin), { method: "POST" }));
  }
  if (request.method === "GET" && action === "status") {
    return stub.fetch(new Request(new URL("/status", url.origin), { method: "GET" }));
  }
  if (request.method === "GET" && action === "results") {
    const seq = parts[3] || url.searchParams.get("seq") || "";
    return stub.fetch(new Request(new URL(`/result?seq=${encodeURIComponent(seq)}`, url.origin), { method: "GET" }));
  }
  return jsonResponse({ error: "not_found" }, 404);
}

function isAuthorized(request: Request, env: WorkerEnv): boolean {
  const expected = env.BATCH_AUTH_TOKEN;
  if (!expected) {
    return false;
  }
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  const headerToken = request.headers.get("x-batch-token") || "";
  return bearer === expected || headerToken === expected;
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error("Expected application/json");
  }
  return request.json();
}

async function readOptionalJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text.trim()) {
    return {} as T;
  }
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error("Expected application/json");
  }
  return JSON.parse(text) as T;
}

function validateBatch(payload: unknown, maxBatchSize: number): HyDEBatchItem[] {
  const body = payload as HyDEBatchRequest;
  if (!body || !Array.isArray(body.items)) {
    throw new Error("Request body must contain an items array");
  }
  if (body.items.length < 1 || body.items.length > maxBatchSize) {
    throw new Error(`items length must be between 1 and ${maxBatchSize}`);
  }
  return body.items.map((item, index) => {
    if (!item || typeof item.id !== "string" || typeof item.rel_path !== "string" || typeof item.text !== "string") {
      throw new Error(`Invalid item at index ${index}`);
    }
    return item;
  });
}

async function handleEmbeddingBatch(request: Request, env: WorkerEnv, ctx: WaitUntilContext): Promise<Response> {
  const payload = await readJson(request) as EmbeddingBatchRequest;
  const texts = validateEmbeddingBatch(payload, intEnv(env.EMBEDDING_MAX_BATCH_SIZE, 64));
  const provider = embeddingProvider(env);
  const model = payload.model || embeddingModel(env);
  const startedAt = Date.now();
  if (provider === "gemini_vertex") {
    const result = await requestGeminiVertexEmbeddings(texts, model, env);
    return jsonResponse({
      ok: true,
      count: result.embeddings.length,
      model,
      active_key: "primary",
      provider,
      elapsed_ms: Date.now() - startedAt,
      embeddings: result.embeddings
    });
  }

  const keyState = await readOpenAIState(env);
  const selected = await callEmbeddingWithKeyName(texts, model, keyState.activeKey, env);
  if (selected.ok) {
    return jsonResponse(buildEmbeddingResult(selected, model, Date.now() - startedAt));
  }

  if (selected.keyName === "primary" && env.OPENAI_FALLBACK_API_KEY && shouldUseFallback(selected.status, selected.text)) {
    logEvent("embedding_primary_exhausted", {
      status: selected.status,
      cf_ray: selected.cfRay,
      model,
      count: texts.length,
      message: truncate(selected.text, 240)
    });
    ctx.waitUntil(writeOpenAIState(env, "fallback", selected.status, selected.text));
    const fallback = await callEmbeddingWithKeyName(texts, model, "fallback", env);
    if (fallback.ok) {
      return jsonResponse(buildEmbeddingResult(fallback, model, Date.now() - startedAt));
    }
    return jsonResponse({ ok: false, error: `fallback embedding request failed (${fallback.status}): ${truncate(fallback.text, 300)}` }, 502);
  }

  return jsonResponse({ ok: false, error: `embedding request failed (${selected.status}): ${truncate(selected.text, 300)}` }, 502);
}

function validateEmbeddingBatch(payload: EmbeddingBatchRequest, maxBatchSize: number): string[] {
  if (!payload || !Array.isArray(payload.texts)) {
    throw new Error("Request body must contain a texts array");
  }
  if (payload.texts.length < 1 || payload.texts.length > maxBatchSize) {
    throw new Error(`texts length must be between 1 and ${maxBatchSize}`);
  }
  return payload.texts.map((text, index) => {
    if (typeof text !== "string") {
      throw new Error(`Invalid text at index ${index}`);
    }
    return text;
  });
}

async function generateHyDE(
  item: HyDEBatchItem,
  env: WorkerEnv,
  ctx: WaitUntilContext,
  jobId?: string,
  shardSeq?: number,
  modelOverride?: string
): Promise<HyDEBatchResult> {
  try {
    const result = await requestHyDEQuestions(item, env, ctx, jobId, shardSeq, modelOverride);
    return buildResult(item, true, result.questions, result.keyName, result.provider, result.model, true, true, undefined, result.elapsedMs, result.cfRay);
  } catch (error) {
    const fallback = [`Where is the code logic from ${item.rel_path} implemented, and what surrounding functions or state does this chunk use?`];
    return buildResult(item, false, fallback, "primary", hydeProvider(env), hydeModel(env, modelOverride), false, false, error instanceof Error ? error.message : String(error));
  }
}

async function requestHyDEQuestions(
  item: HyDEBatchItem,
  env: WorkerEnv,
  ctx: WaitUntilContext,
  jobId?: string,
  shardSeq?: number,
  modelOverride?: string
): Promise<ProviderResult> {
  if (hydeProvider(env) === "gemini_vertex") {
    return requestGeminiHyDEQuestions(item, env, jobId, shardSeq, modelOverride);
  }
  const body = buildResponsesBody(item, env, modelOverride);
  const keyState = await readOpenAIState(env);
  const selected = await callOpenAIWithKeyName(body, keyState.activeKey, env, item, jobId, shardSeq);
  if (selected.ok) {
    return {
      questions: extractQuestions(selected.data, intEnv(env.HYDE_QUESTION_COUNT, 12)),
      keyName: selected.keyName,
      provider: "openai",
      model: hydeModel(env, modelOverride),
      elapsedMs: selected.elapsedMs,
      cfRay: selected.cfRay
    };
  }

  if (selected.keyName === "primary" && env.OPENAI_FALLBACK_API_KEY && shouldUseFallback(selected.status, selected.text)) {
    logEvent("openai_primary_exhausted", {
      status: selected.status,
      cf_ray: selected.cfRay,
      job_id: jobId,
      shard_seq: shardSeq,
      item_id: item.id,
      message: truncate(selected.text, 240)
    });
    ctx.waitUntil(writeOpenAIState(env, "fallback", selected.status, selected.text));
    const fallback = await callOpenAIWithKeyName(body, "fallback", env, item, jobId, shardSeq);
    if (fallback.ok) {
      return {
        questions: extractQuestions(fallback.data, intEnv(env.HYDE_QUESTION_COUNT, 12)),
        keyName: fallback.keyName,
        provider: "openai",
        model: hydeModel(env, modelOverride),
        elapsedMs: selected.elapsedMs + fallback.elapsedMs,
        cfRay: fallback.cfRay || selected.cfRay
      };
    }
    throw new Error(`fallback OpenAI request failed (${fallback.status}): ${truncate(fallback.text, 300)}`);
  }

  if (selected.keyName === "fallback" && env.OPENAI_API_KEY && shouldUseFallback(selected.status, selected.text)) {
    const primary = await callOpenAIWithKeyName(body, "primary", env, item, jobId, shardSeq);
    if (primary.ok) {
      ctx.waitUntil(writeOpenAIState(env, "primary", selected.status, selected.text));
      return {
        questions: extractQuestions(primary.data, intEnv(env.HYDE_QUESTION_COUNT, 12)),
        keyName: primary.keyName,
        provider: "openai",
        model: hydeModel(env, modelOverride),
        elapsedMs: selected.elapsedMs + primary.elapsedMs,
        cfRay: primary.cfRay || selected.cfRay
      };
    }
  }

  throw new Error(`OpenAI request failed (${selected.status}): ${truncate(selected.text, 300)}`);
}

function buildResponsesBody(item: HyDEBatchItem, env: WorkerEnv, modelOverride?: string): unknown {
  const questionCount = intEnv(env.HYDE_QUESTION_COUNT, 12);
  return {
    model: hydeModel(env, modelOverride),
    input: [
      { role: "developer", content: [{ type: "input_text", text: `${HYDE_DEVELOPER_PROMPT}\n\nGenerate exactly ${questionCount} questions.` }] },
      { role: "user", content: [{ type: "input_text", text: HYDE_EXAMPLE_CODE }] },
      { role: "assistant", content: [{ type: "output_text", text: JSON.stringify(HYDE_EXAMPLE_RESPONSE) }] },
      { role: "user", content: [{ type: "input_text", text: `File: ${item.rel_path}\n\n${item.text}` }] }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "hyde_questions_for_code",
        strict: true,
        schema: hydeSchema()
      },
      verbosity: "low"
    },
    reasoning: { effort: "none", summary: "auto" },
    tools: [],
    store: false
  };
}

async function callOpenAIWithKeyName(
  body: unknown,
  keyName: OpenAIKeyName,
  env: WorkerEnv,
  item: HyDEBatchItem,
  jobId?: string,
  shardSeq?: number
): Promise<OpenAIResult> {
  const apiKey = keyName === "fallback" ? env.OPENAI_FALLBACK_API_KEY : env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 500, text: `Missing ${keyName} OpenAI key`, keyName, elapsedMs: 0 };
  }
  const result = await callOpenAI(body, apiKey, env, item, jobId, shardSeq);
  return { ...result, keyName };
}

async function callOpenAI(
  body: unknown,
  apiKey: string,
  env: WorkerEnv,
  item: HyDEBatchItem,
  jobId?: string,
  shardSeq?: number
): Promise<{ ok: boolean; status: number; text: string; elapsedMs: number; cfRay?: string; data?: unknown }> {
  const baseUrl = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const startedAt = Date.now();
  const model = body && typeof body === "object" && "model" in body
    ? String((body as { model?: unknown }).model || hydeModel(env))
    : hydeModel(env);
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: pruneHeaders({
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
      "cf-aig-authorization": aiGatewayAuthHeader(env),
      "cf-aig-metadata": JSON.stringify({
        job_id: jobId || "adhoc",
        shard_seq: shardSeq ?? null,
        item_id: item.id,
        rel_path: item.rel_path,
        model
      })
    }),
    body: JSON.stringify(body)
  });
  const elapsedMs = Date.now() - startedAt;
  const cfRay = response.headers.get("cf-ray") || undefined;
  const text = await response.text();
  if (!response.ok) {
    logEvent("openai_request_failed", {
      status: response.status,
      elapsed_ms: elapsedMs,
      cf_ray: cfRay,
      job_id: jobId,
      shard_seq: shardSeq,
      item_id: item.id,
      message: truncate(text, 240)
    });
    return { ok: false, status: response.status, text, elapsedMs, cfRay };
  }
  try {
    return { ok: true, status: response.status, text, elapsedMs, cfRay, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: response.status, text: `OpenAI response was not valid JSON: ${truncate(text, 300)}`, elapsedMs, cfRay };
  }
}

async function callEmbeddingWithKeyName(
  texts: string[],
  model: string,
  keyName: OpenAIKeyName,
  env: WorkerEnv
): Promise<OpenAIResult> {
  const apiKey = keyName === "fallback" ? env.OPENAI_FALLBACK_API_KEY : env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 500, text: `Missing ${keyName} OpenAI key`, keyName, elapsedMs: 0 };
  }
  const baseUrl = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: pruneHeaders({
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
      "cf-aig-authorization": aiGatewayAuthHeader(env),
      "cf-aig-metadata": JSON.stringify({
        operation: "embedding_batch",
        count: texts.length,
        model
      })
    }),
    body: JSON.stringify({ model, input: texts })
  });
  const elapsedMs = Date.now() - startedAt;
  const cfRay = response.headers.get("cf-ray") || undefined;
  const text = await response.text();
  if (!response.ok) {
    logEvent("embedding_request_failed", {
      status: response.status,
      elapsed_ms: elapsedMs,
      cf_ray: cfRay,
      model,
      count: texts.length,
      message: truncate(text, 240)
    });
    return { ok: false, status: response.status, text, keyName, elapsedMs, cfRay };
  }
  try {
    return { ok: true, status: response.status, text, keyName, elapsedMs, cfRay, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: response.status, text: `Embedding response was not valid JSON: ${truncate(text, 300)}`, keyName, elapsedMs, cfRay };
  }
}

function buildEmbeddingResult(result: OpenAIResult, model: string, elapsedMs: number): EmbeddingBatchResult {
  const record = result.data as { data?: Array<{ embedding?: unknown }> };
  const embeddings = (record.data || []).map((item, index) => {
    if (!Array.isArray(item.embedding) || !item.embedding.every((value) => typeof value === "number")) {
      throw new Error(`Embedding response item ${index} did not contain a numeric embedding`);
    }
    return item.embedding;
  });
  return {
    ok: true,
    count: embeddings.length,
    model,
    active_key: result.keyName,
    elapsed_ms: elapsedMs,
    ...(result.cfRay ? { cf_ray: result.cfRay } : {}),
    embeddings
  };
}

async function requestGeminiVertexEmbeddings(
  texts: string[],
  model: string,
  env: WorkerEnv
): Promise<{ embeddings: number[][] }> {
  const documentTask = env.EMBEDDING_TASK_TYPE || "RETRIEVAL_DOCUMENT";
  const concurrency = Math.min(Math.max(1, intEnv(env.EMBEDDING_CONCURRENCY, 8)), 16);
  const embeddings = await mapLimit(texts, concurrency, (text) => callGeminiVertexEmbedding(text, model, documentTask, env));
  return { embeddings };
}

async function callGeminiVertexEmbedding(
  text: string,
  model: string,
  taskType: string,
  env: WorkerEnv
): Promise<number[]> {
  const startedAt = Date.now();
  const outputDimensionality = intEnv(env.EMBEDDING_OUTPUT_DIMENSIONALITY, 0);
  const body = {
    instances: [{ content: text, task_type: taskType }],
    parameters: {
      autoTruncate: true,
      ...(outputDimensionality > 0 ? { outputDimensionality } : {}),
    },
  };
  const response = await fetch(geminiEmbeddingVertexUrl(env, model), {
    method: "POST",
    headers: pruneHeaders({
      "authorization": await googleAuthorizationHeader(env),
      "content-type": "application/json",
      "cf-aig-authorization": env.GEMINI_SERVICE_ACCOUNT_B64 ? undefined : aiGatewayAuthHeader(env),
      "cf-aig-metadata": JSON.stringify({
        operation: "embedding_batch",
        model,
        provider: "gemini_vertex",
        task_type: taskType,
      }),
    }),
    body: JSON.stringify(body),
  });
  const elapsedMs = Date.now() - startedAt;
  const cfRay = response.headers.get("cf-ray") || undefined;
  const raw = await response.text();
  if (!response.ok) {
    logEvent("gemini_embedding_request_failed", {
      status: response.status,
      elapsed_ms: elapsedMs,
      cf_ray: cfRay,
      model,
      message: truncate(raw, 240),
    });
    throw new Error(`Gemini embedding request failed (${response.status}): ${truncate(raw, 300)}`);
  }
  const data = JSON.parse(raw) as { predictions?: Array<{ embeddings?: { values?: unknown } }> };
  const values = data.predictions?.[0]?.embeddings?.values;
  if (!Array.isArray(values) || !values.every((value) => typeof value === "number")) {
    throw new Error("Gemini embedding response did not contain a numeric embedding");
  }
  return values;
}

async function requestGeminiHyDEQuestions(
  item: HyDEBatchItem,
  env: WorkerEnv,
  jobId?: string,
  shardSeq?: number,
  modelOverride?: string
): Promise<ProviderResult> {
  const model = hydeModel(env, modelOverride);
  const body = buildGeminiBody(item, env);
  const result = await callGeminiVertex(body, env, model, item, jobId, shardSeq);
  if (!result.ok) {
    throw new Error(`Gemini request failed (${result.status}): ${truncate(result.text, 300)}`);
  }
  return {
    questions: extractQuestionsFromText(extractGeminiText(result.data), intEnv(env.HYDE_QUESTION_COUNT, 12), "Gemini"),
    keyName: "primary",
    provider: "gemini_vertex",
    model,
    elapsedMs: result.elapsedMs,
    cfRay: result.cfRay
  };
}

async function requestDeepSeekHyDEQuestions(
  items: HyDEBatchItem[],
  env: WorkerEnv,
  model: string,
  questionCount: number
): Promise<DeepSeekBatchRecord[]> {
  const startedAt = Date.now();
  try {
    if (!env.DEEPSEEK_API_KEY) {
      throw new Error("Missing DEEPSEEK_API_KEY");
    }
    const response = await fetch(`${(env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${env.DEEPSEEK_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: DEEPSEEK_BATCH_PROMPT },
          { role: "user", content: buildDeepSeekBatchPrompt(items, questionCount) }
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: intEnv(env.DEEPSEEK_MAX_OUTPUT_TOKENS, 6000)
      })
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`DeepSeek request failed (${response.status}): ${truncate(text, 300)}`);
    }
    const body = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content || "";
    const parsed = parseJsonObject(content);
    return normalizeDeepSeekBatch(items, parsed, model, questionCount, Date.now() - startedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return items.map((item) => ({
      id: item.id,
      rel_path: item.rel_path,
      ok: false,
      model,
      provider: "deepseek",
      hyde_questions: [],
      hyde_text: "",
      elapsed_ms: Date.now() - startedAt,
      error: message
    }));
  }
}

const DEEPSEEK_BATCH_PROMPT = `You generate HyDE search questions for an autonomous code-search system.

Return only valid JSON matching:
{"results":[{"id":"input id","hyde_questions":[{"question":"..."}]}]}

Rules:
- Preserve every input id exactly and return one result per chunk.
- Return exactly the requested number of questions per chunk.
- Ground each question in identifiers, functions, classes, routes, payload keys, side effects, persistence, retries, fallback branches, line ranges, request or response contracts, or tests visible in the chunk.
- Prefer exact names visible in the code over broad summaries.
- Do not invent project facts that are not visible in the chunk.
- Avoid generic questions like "what does this function do?".
- Each question must be a complete natural-language question ending in '?'.`;

function buildDeepSeekBatchPrompt(items: HyDEBatchItem[], questionCount: number): string {
  return "Generate schema-valid JSON for these chunks:\n" + JSON.stringify({
    question_count_per_chunk: questionCount,
    chunks: items.map((item) => ({
      id: item.id,
      rel_path: item.rel_path,
      text: item.text
    }))
  });
}

function normalizeDeepSeekBatch(
  items: HyDEBatchItem[],
  data: unknown,
  model: string,
  questionCount: number,
  elapsedMs: number
): DeepSeekBatchRecord[] {
  const results = data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results)
    ? (data as { results: unknown[] }).results
    : [];
  const byId = new Map<string, unknown>();
  for (const result of results) {
    if (result && typeof result === "object" && typeof (result as { id?: unknown }).id === "string") {
      byId.set((result as { id: string }).id, result);
    }
  }
  return items.map((item) => {
    const result = byId.get(item.id) as { hyde_questions?: unknown } | undefined;
    const questions = normalizeQuestionList(result?.hyde_questions);
    const errors: string[] = [];
    if (!result) {
      errors.push("missing result");
    }
    if (questions.length !== questionCount) {
      errors.push(`expected ${questionCount} questions, got ${questions.length}`);
    }
    questions.forEach((question, index) => {
      if (question.length < 10) {
        errors.push(`question ${index} too short`);
      }
      if (!question.endsWith("?")) {
        errors.push(`question ${index} does not end with '?'`);
      }
    });
    return {
      id: item.id,
      rel_path: item.rel_path,
      ok: errors.length === 0,
      model,
      provider: "deepseek" as const,
      hyde_questions: questions,
      hyde_text: questions.map((question) => `- ${question}`).join("\n"),
      elapsed_ms: elapsedMs,
      ...(errors.length ? { error: errors.join("; ") } : {})
    };
  });
}

function normalizeQuestionList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (item && typeof item === "object" && typeof (item as { question?: unknown }).question === "string") {
        return normalizeQuestion((item as { question: string }).question);
      }
      if (typeof item === "string") {
        return normalizeQuestion(item);
      }
      return "";
    })
    .filter(Boolean);
}

function normalizeQuestion(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildGeminiBody(item: HyDEBatchItem, env: WorkerEnv): unknown {
  const questionCount = intEnv(env.HYDE_QUESTION_COUNT, 12);
  return {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              HYDE_DEVELOPER_PROMPT,
              "",
              `Generate exactly ${questionCount} questions.`,
              "",
              "Few-shot example code:",
              HYDE_EXAMPLE_CODE,
              "",
              "Few-shot example JSON response:",
              JSON.stringify(HYDE_EXAMPLE_RESPONSE),
              "",
              `Target file: ${item.rel_path}`,
              "",
              item.text
            ].join("\n")
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: intEnv(env.GEMINI_MAX_OUTPUT_TOKENS, 4096),
      responseMimeType: "application/json",
      responseSchema: geminiHydeSchema(),
      thinkingConfig: {
        thinkingLevel: "MINIMAL"
      }
    }
  };
}

async function callGeminiVertex(
  body: unknown,
  env: WorkerEnv,
  model: string,
  item: HyDEBatchItem,
  jobId?: string,
  shardSeq?: number
): Promise<{ ok: boolean; status: number; text: string; elapsedMs: number; cfRay?: string; data?: unknown }> {
  const startedAt = Date.now();
  const response = await fetch(geminiVertexUrl(env, model), {
    method: "POST",
    headers: pruneHeaders({
      "content-type": "application/json",
      "authorization": await googleAuthorizationHeader(env),
      "cf-aig-authorization": env.GEMINI_SERVICE_ACCOUNT_B64 ? undefined : aiGatewayAuthHeader(env),
      "cf-aig-metadata": JSON.stringify({
        job_id: jobId || "adhoc",
        shard_seq: shardSeq ?? null,
        item_id: item.id,
        rel_path: item.rel_path,
        model,
        provider: "gemini_vertex"
      })
    }),
    body: JSON.stringify(body)
  });
  const elapsedMs = Date.now() - startedAt;
  const cfRay = response.headers.get("cf-ray") || undefined;
  const text = await response.text();
  if (!response.ok) {
    logEvent("gemini_request_failed", {
      status: response.status,
      elapsed_ms: elapsedMs,
      cf_ray: cfRay,
      job_id: jobId,
      shard_seq: shardSeq,
      item_id: item.id,
      message: truncate(text, 240)
    });
    return { ok: false, status: response.status, text, elapsedMs, cfRay };
  }
  try {
    return { ok: true, status: response.status, text, elapsedMs, cfRay, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: response.status, text: `Gemini response was not valid JSON: ${truncate(text, 300)}`, elapsedMs, cfRay };
  }
}

function extractQuestions(response: unknown, maxQuestions: number): string[] {
  const text = extractResponseText(response);
  return extractQuestionsFromText(text, maxQuestions, "OpenAI");
}

function extractQuestionsFromText(text: string, maxQuestions: number, providerLabel: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${providerLabel} output text was not valid JSON: ${truncate(text, 300)}`);
  }
  return validateHyDESchema(data).slice(0, maxQuestions);
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error(`DeepSeek output text was not valid JSON: ${truncate(text, 300)}`);
  }
}

function validateHyDESchema(data: unknown): string[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("HyDE JSON schema invalid: root must be an object");
  }
  const questions = (data as { hyde_questions?: unknown }).hyde_questions;
  if (!Array.isArray(questions)) {
    throw new Error("HyDE JSON schema invalid: hyde_questions must be an array");
  }
  const parsed = questions.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`HyDE JSON schema invalid: item ${index} must be an object`);
    }
    const question = (item as { question?: unknown }).question;
    if (typeof question !== "string" || !question.trim()) {
      throw new Error(`HyDE JSON schema invalid: item ${index}.question must be a non-empty string`);
    }
    return question.trim();
  });
  if (!parsed.length) {
    throw new Error("HyDE JSON schema invalid: at least one question is required");
  }
  return parsed;
}

function extractResponseText(response: unknown): string {
  const record = response as { output_text?: unknown; output?: Array<{ content?: Array<{ text?: unknown }> }> };
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.trim();
  }
  const chunks: string[] = [];
  for (const item of record.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function extractGeminiText(response: unknown): string {
  const record = response as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
  const chunks: string[] = [];
  for (const candidate of record.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function buildResult(
  item: HyDEBatchItem,
  ok: boolean,
  questions: string[],
  activeKey: OpenAIKeyName,
  provider: HyDEProviderName,
  model: string,
  responseJsonValid: boolean,
  responseSchemaValid: boolean,
  error?: string,
  elapsedMs?: number,
  cfRay?: string
): HyDEBatchResult {
  return {
    id: item.id,
    rel_path: item.rel_path,
    ok,
    active_key: activeKey,
    model,
    provider,
    response_json_valid: responseJsonValid,
    response_schema_valid: responseSchemaValid,
    hyde_questions: questions,
    hyde_text: questions.map((question) => `- ${question}`).join("\n"),
    ...(elapsedMs !== undefined ? { elapsed_ms: elapsedMs } : {}),
    ...(cfRay ? { cf_ray: cfRay } : {}),
    ...(error ? { error } : {})
  };
}

async function readOpenAIState(env: WorkerEnv): Promise<OpenAIKeyState> {
  const active = await env.OPENAI_STATE.get("active_openai_key");
  return { activeKey: active === "fallback" ? "fallback" : "primary" };
}

async function writeOpenAIState(env: WorkerEnv, activeKey: OpenAIKeyName, status: number, text: string): Promise<void> {
  await Promise.all([
    env.OPENAI_STATE.put("active_openai_key", activeKey),
    env.OPENAI_STATE.put("last_failover", JSON.stringify({
      active_key: activeKey,
      status,
      at: new Date().toISOString(),
      message: truncate(text, 500)
    }))
  ]);
}

async function mapLimit<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function run(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

function splitItems<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += Math.max(1, size)) {
    batches.push(items.slice(index, index + Math.max(1, size)));
  }
  return batches;
}

function hydeSchema(): unknown {
  return {
    type: "object",
    properties: {
      hyde_questions: {
        type: "array",
        description: "Targeted HyDE questions for locating this code chunk in a large codebase.",
        items: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "A precise technical retrieval question for this code chunk."
            }
          },
          required: ["question"],
          additionalProperties: false
        }
      }
    },
    required: ["hyde_questions"],
    additionalProperties: false
  };
}

function geminiHydeSchema(): unknown {
  return {
    type: "OBJECT",
    properties: {
      hyde_questions: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            question: {
              type: "STRING"
            }
          },
          required: ["question"],
          propertyOrdering: ["question"]
        }
      }
    },
    required: ["hyde_questions"],
    propertyOrdering: ["hyde_questions"]
  };
}

function hydeProvider(env: WorkerEnv): HyDEProviderName {
  return env.HYDE_PROVIDER === "gemini_vertex" || env.HYDE_PROVIDER === "gemini" ? "gemini_vertex" : "openai";
}

function validateHyDEModelOverride(model: string | undefined, env: WorkerEnv): string | undefined {
  if (!model) {
    return undefined;
  }
  const allowed = (env.HYDE_ALLOWED_MODELS || [
    "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview"
  ].join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!allowed.includes(model)) {
    throw new Error(`model override is not allowed: ${model}`);
  }
  return model;
}

function hydeModel(env: WorkerEnv, modelOverride?: string): string {
  if (hydeProvider(env) === "gemini_vertex") {
    return modelOverride || env.GEMINI_MODEL || env.HYDE_MODEL || "gemini-3.1-flash-lite-preview";
  }
  return env.HYDE_MODEL || "gpt-5.4-nano";
}

function embeddingProvider(env: WorkerEnv): EmbeddingProviderName {
  return env.EMBEDDING_PROVIDER === "gemini_vertex" || env.EMBEDDING_PROVIDER === "gemini"
    ? "gemini_vertex"
    : "openai";
}

function embeddingModel(env: WorkerEnv): string {
  if (embeddingProvider(env) === "gemini_vertex") {
    return env.EMBEDDING_MODEL || "gemini-embedding-001";
  }
  return env.EMBEDDING_MODEL || "text-embedding-3-large";
}

function geminiVertexUrl(env: WorkerEnv, model: string): string {
  const baseUrl = (env.GEMINI_BASE_URL || "").replace(/\/$/, "");
  const project = env.GEMINI_PROJECT || "evrylo";
  const location = env.GEMINI_LOCATION || "global";
  if (!baseUrl) {
    throw new Error("GEMINI_BASE_URL is required for HYDE_PROVIDER=gemini_vertex");
  }
  return `${baseUrl}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

function geminiEmbeddingVertexUrl(env: WorkerEnv, model: string): string {
  const location = env.GEMINI_EMBEDDING_LOCATION || env.GOOGLE_CLOUD_LOCATION || "us-central1";
  const baseUrl = (env.GEMINI_BASE_URL || `https://${location}-aiplatform.googleapis.com`).replace(/\/$/, "");
  const project = env.GEMINI_PROJECT || "evrylo";
  return `${baseUrl}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predict`;
}

async function googleAuthorizationHeader(env: WorkerEnv): Promise<string | undefined> {
  if (!env.GEMINI_SERVICE_ACCOUNT_B64) {
    return undefined;
  }
  const token = await googleAccessToken(env);
  return `Bearer ${token}`;
}

async function googleAccessToken(env: WorkerEnv): Promise<string> {
  const now = Date.now();
  if (googleAccessTokenCache && googleAccessTokenCache.expiresAt - 60_000 > now) {
    return googleAccessTokenCache.token;
  }
  const serviceAccount = parseGoogleServiceAccount(env);
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + 3600;
  const assertion = await signGoogleJwt(serviceAccount, {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: serviceAccount.token_uri || "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: expiresAt,
  });
  const response = await fetch(serviceAccount.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Google token request failed (${response.status}): ${truncate(raw, 300)}`);
  }
  const data = JSON.parse(raw) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Google token response did not include access_token");
  }
  googleAccessTokenCache = {
    token: data.access_token,
    expiresAt: now + Math.max(60, data.expires_in || 3600) * 1000,
  };
  return data.access_token;
}

function parseGoogleServiceAccount(env: WorkerEnv): GoogleServiceAccount {
  if (!env.GEMINI_SERVICE_ACCOUNT_B64) {
    throw new Error("GEMINI_SERVICE_ACCOUNT_B64 is required for direct Gemini Vertex calls");
  }
  const decoded = atob(env.GEMINI_SERVICE_ACCOUNT_B64);
  const serviceAccount = JSON.parse(decoded) as Partial<GoogleServiceAccount>;
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error("GEMINI_SERVICE_ACCOUNT_B64 did not decode to a valid service account JSON");
  }
  return {
    client_email: serviceAccount.client_email,
    private_key: serviceAccount.private_key,
    token_uri: serviceAccount.token_uri,
  };
}

async function signGoogleJwt(serviceAccount: GoogleServiceAccount, claims: Record<string, string | number>): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function base64UrlEncode(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function shouldUseFallback(status: number, text: string): boolean {
  const lower = text.toLowerCase();
  return status === 429
    || lower.includes("quota")
    || lower.includes("billing")
    || lower.includes("rate_limit")
    || lower.includes("rate limit")
    || lower.includes("insufficient_quota")
    || lower.includes("model_not_found")
    || lower.includes("invalid_model");
}

function intEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number.isFinite(value) ? Number(value) : fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function shardKey(seq: number): string {
  return `shard:${seq.toString().padStart(8, "0")}`;
}

function inputKey(jobId: string, seq: number): string {
  return `jobs/${jobId}/input/${seq.toString().padStart(8, "0")}.json`;
}

function outputKey(jobId: string, seq: number): string {
  return `jobs/${jobId}/output/${seq.toString().padStart(8, "0")}.json`;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function isExpiredProcessingShard(shard: JobShardState, now: number): boolean {
  if (shard.status !== "processing" || !shard.lease_expires_at) {
    return false;
  }
  return Date.parse(shard.lease_expires_at) <= now;
}

function aiGatewayAuthHeader(env: WorkerEnv): string | undefined {
  const token = env.AI_GATEWAY_TOKEN || env.CF_AIG_TOKEN;
  return token ? `Bearer ${token}` : undefined;
}

function geminiAuthorizationHeader(env: WorkerEnv): string | undefined {
  return env.GEMINI_SERVICE_ACCOUNT_B64 ? `Bearer ${env.GEMINI_SERVICE_ACCOUNT_B64}` : undefined;
}

function pruneHeaders(headers: Record<string, string | undefined>): HeadersInit {
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store"
    }
  });
}
