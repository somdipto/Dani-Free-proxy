# Dani-Free

Dani-Free is a small Bun/TypeScript local OpenAI-compatible router. The standard listener advertises three OpenCode free ids, then three Kilo free ids. `auto` is `opencode/muse-spark-1.3-contributor-free`. If the selected model is missing, unhealthy, quota-exhausted, timed out, or otherwise failed, the router returns that error and does not switch models. Free-tier availability is promotional and can change; `:free` in an id is not a billing or privacy guarantee.

## Requirements

- Bun 1.1 or newer.
- A configured Kilo Code gateway credential (`DANI_FREE_KILO_API_KEY`) for the Kilo ids.
- The local OpenCode proxy on `127.0.0.1:4187` for the OpenCode ids.

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

Dani-Free is an OpenAI-compatible inference proxy for the pinned Kilo model. It does not implement OpenCode ACP, own OpenCode's agent loop, or expose OpenCode free models through this listener. Do not send OpenCode traffic to Dani-Free and expect a silent substitute.

## Security

The canonical implementation guide for AI agents and custom model-provider clients is [`AGENT_INTEGRATION.md`](AGENT_INTEGRATION.md). It documents the protocol contract, the pinned Kilo selector, setup, OMP, Python, JavaScript, security, failure handling, and an integration checklist.

The shorter provider templates remain in [`integrations/`](integrations/), and the operational skill is in [`skills/dani-free/SKILL.md`](skills/dani-free/SKILL.md).
