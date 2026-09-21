# Routing reference

Dani-Free exposes these local HTTP routes:

- `GET /health` — aggregate router and backend health.
- `GET /v1/models` — OpenAI-compatible model list. Only models discovered from configured backends are advertised.
- `POST /v1/chat/completions` — OpenAI-compatible chat completion endpoint.

## Selectors

Set `model` in a chat request to one of:

- `auto` — starts at `opencode/nemotron-3-ultra-free` and walks the OpenCode-first six-model failover chain on retryable failures (transport errors, 408, 429 with a brief backoff, 5xx, empty or oversize HTTP 200 bodies). Other 4xx refusals are passed through as-is.
- the six ids from `GET /v1/models`.
- any other selector — rejected unless the process was started with a custom adapter set and allowlist.

Use the exact id returned by `/v1/models`. Explicit selectors fail closed.

## Automatic routing contract

`auto` starts at `opencode/nemotron-3-ultra-free`. Discovery uses a five-second cache. The request deadline includes discovery and stays active through streamed response EOF. Client cancellation and the request deadline are terminal: either ends the request with a 504 and never falls back to another model. Retryable upstream failures (transport errors, 408, 429 with a brief backoff, 5xx, empty or oversize HTTP 200 bodies) do fall back to the next model in the chain; other 4xx refusals are passed through as-is.

## Example

```sh
curl -sS http://127.0.0.1:4190/v1/models

curl -sS http://127.0.0.1:4190/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "authorization: Bearer ${DANI_FREE_API_KEY}" \
  -d '{
    "model": "auto",
    "messages": [{"role":"user","content":"Reply with exactly: hello"}],
    "temperature": 0,
    "max_tokens": 32
  }'
```

Omit the `Authorization` header when `DANI_FREE_API_KEY` is unset. If it is set, requests must authenticate with that bearer value. Never paste a real key into documentation or shell history.
