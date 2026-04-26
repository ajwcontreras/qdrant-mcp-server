# Cloudflare AI Gateway Runbook

For this indexing pipeline, bulk provider calls must originate from Cloudflare Workers, not from the local machine.

Rules:

- Use provider-specific AI Gateway endpoints, not the unified endpoint.
- Use an unauthenticated gateway unless explicitly changing the design to BYOK/authenticated Gateway.
- Do not point Workers at `unified` unless `cf-aig-authorization` and provider keys are configured and tested.
- Before a full indexing run, smoke test both provider paths against the selected gateway:
  - OpenAI: `/{account_id}/{gateway_id}/openai/embeddings` returns a 3072-dimensional `text-embedding-3-large` vector.
  - Vertex: `/{account_id}/{gateway_id}/google-vertex-ai/v1/projects/evrylo/locations/global/publishers/google/models/gemini-3.1-flash-lite-preview:generateContent` returns HTTP 200.
- The local Python indexer may call the Worker and local Qdrant, but must not call OpenAI directly when `EMBEDDING_WORKER_URL` is configured.

Verified gateway as of 2026-04-22:

- Account: `776ba01baf2a9a9806fa0edb1b5ddc96`
- Gateway: `default`
- Authentication: `false`
- OpenAI provider-specific smoke: HTTP 200, 3072 dimensions.
- Vertex provider-specific smoke: HTTP 200.
- Worker `/embed-batch` smoke: HTTP 200, 3072 dimensions, `active_key=primary`.
