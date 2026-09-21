# Dani-Free

Dani-Free is a small Bun/TypeScript local OpenAI-compatible router. Its standard preference order is three OpenCode ids, then three Kilo ids. `auto` resolves only to `opencode/muse-spark-1.3-contributor-free`. `/v1/models` lists only exact ids discovered from configured backends, in that preference order. A missing, unhealthy, quota-exhausted, timed-out, or otherwise failed model returns its own error and never switches backend.

## Requirements

- Bun 1.1 or newer.
- A configured Kilo Code gateway credential (`DANI_FREE_KILO_API_KEY`) for Kilo slots 4–6.
- Written provider authorization and a direct OpenAI Chat Completions-compatible endpoint for any OpenCode slot. The current public OpenCode material does not establish this for all three requested free IDs. See [`docs/research/opencode-free-access-2026-09-21.md`](docs/research/opencode-free-access-2026-09-21.md).
## Setup

```sh
cd /Users/dan/Desktop/x/dani-free
bun install
cp .env.example .env
# Edit .env; leave unused backends blank.
chmod 600 .env
bun run start
```

The default listener is `http://127.0.0.1:4190`. Override it with `DANI_FREE_HOST` and `DANI_FREE_PORT`. For development, `bun run dev` starts the same service with Bun's watcher. `bun run check` runs the TypeScript check; `bun test` runs the test suite.

## Speed and cancellation behavior

The router keeps a five-second model-discovery cache. The request deadline starts when the request is received, includes discovery, and stays active through streamed response EOF. Client cancellation is terminal. There is no second-model retry.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DANI_FREE_HOST` | Bind address; defaults to `127.0.0.1`. |
| `DANI_FREE_PORT` | Listen port; defaults to `4190`. |
| `DANI_FREE_API_KEY` | Optional client API key. When set, clients must send `Authorization: Bearer <value>`. |
| `DANI_FREE_OPENCODE_BASE_URL` | Explicit, provider-authorized OpenAI Chat Completions-compatible endpoint for OpenCode. Unset by default. |
| `DANI_FREE_OPENCODE_API_KEY` | Credential for that endpoint, if required. |
| `DANI_FREE_KILO_BASE_URL` | Verified Kilo Code endpoint. Defaults to `https://api.kilo.ai/api/gateway`. |
| `DANI_FREE_KILO_API_KEY` | Kilo Code endpoint credential, if required. |

The Kilo-only listener on `:4290` advertises the three Kilo ids and pins `auto` to Nex Pro.

## API

- `GET /health` — backend configuration and health state.
- `GET /v1/models` — OpenAI-compatible model list.
- `POST /v1/chat/completions` — OpenAI-compatible chat completion request/response.

The `model` selector is one of:

- `auto` — exact alias of `opencode/muse-spark-1.3-contributor-free`.
- the six ids from `GET /v1/models` (OpenCode Muse 1.3, Muse 1.2, MiMo v2.5, then Kilo Nex Pro, dots3-note, Nex Mini).
- any other selector — rejected unless the caller supplied a custom adapter set and allowlist.

Always use the exact id returned by `/v1/models`.

```sh
curl -sS http://127.0.0.1:4190/health
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

If `DANI_FREE_API_KEY` is unset, omit the authorization header. The deterministic request/response examples in [`test/fixtures/`](test/fixtures/) are suitable for protocol-level tests and documentation checks; they are not provider credentials or fake backend responses.

## OpenCode boundary

Dani-Free has no default OpenCode endpoint and does not start OpenCode ACP or an OpenCode agent/session bridge. Configuring `DANI_FREE_OPENCODE_BASE_URL` only selects an HTTP transport; it does not establish entitlement, free-tier authorization, model availability, or tool support. The configured endpoint must advertise each exact model and its capabilities. Missing requested ids stay absent from `/v1/models`; `auto` then fails closed rather than selecting Kilo.

## Security

The canonical implementation guide for AI agents and custom model-provider clients is [`AGENT_INTEGRATION.md`](AGENT_INTEGRATION.md). It documents the protocol contract, configured backends, OMP, Python, JavaScript, security, failure handling, and an integration checklist.

The shorter provider templates remain in [`integrations/`](integrations/), and the operational skill is in [`skills/dani-free/SKILL.md`](skills/dani-free/SKILL.md).
