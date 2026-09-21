# Dani-Free

Dani-Free is a small Bun/TypeScript local OpenAI-compatible router. The standard listener advertises three OpenCode free ids, then three Kilo free ids. `auto` is `opencode/nemotron-3-ultra-free`. If the selected model is missing, unhealthy, quota-exhausted, timed out, or otherwise failed, the router returns that error and does not switch models. Free-tier availability is promotional and can change; `:free` in an id is not a billing or privacy guarantee.

## Requirements

- Bun 1.1 or newer.
- A configured Kilo Code gateway credential (`DANI_FREE_KILO_API_KEY`) for the Kilo ids.
- The genuine local `opencode serve` sidecar on `127.0.0.1:4187` for the OpenCode ids (see below).

## Setup

```sh
cd ~/workspace/Dani-Free-proxy
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
| `DANI_FREE_OPENCODE_BASE_URL` | `opencode serve` sidecar base URL. Defaults to `http://127.0.0.1:4187`. |
| `DANI_FREE_OPENCODE_API_KEY` | Sidecar password, only when the sidecar runs with `OPENCODE_SERVER_PASSWORD`. Sent as HTTP Basic `opencode:<key>`; never as a Bearer token and never to any remote API. |

The Kilo-only listener on `:4290` advertises the three Kilo ids and pins `auto` to Nex Pro.

## API

- `GET /health` — backend configuration and health state.
- `GET /v1/models` — OpenAI-compatible model list.
- `POST /v1/chat/completions` — OpenAI-compatible chat completion request/response.

The `model` selector is one of:

- `auto` — exact alias of `opencode/nemotron-3-ultra-free`.
- the six ids from `GET /v1/models` (OpenCode nemotron-3-ultra, Muse Spark 1.3, MiMo v2.5, then Kilo Nex Pro, dots3-note, Nex Mini).
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

## OpenCode transport

The OpenCode ids are served through the genuine local `opencode serve` sidecar — a session API (`/session`, `/session/{id}/message`, `/config/providers`, `/global/health`), **not** an OpenAI-compatible upstream. There is no OpenAI-compatible endpoint at `:4187`.

Install the genuine `opencode` binary if you don't have it yet:

```sh
curl -fsSL https://opencode.ai/install | bash
```

OpenCode's free tier only works from inside the genuine OpenCode client, so the adapter talks only to the local sidecar: zero payment, zero API keys sent anywhere (direct HTTPS to `https://opencode.ai/zen/v1` is rejected by OpenCode with "OpenCode's free tier can only be used from within OpenCode"). For a non-loopback or shared setup, start the sidecar with a password and mirror it in `.env`:

```sh
# start the local sidecar the proxy talks to (genuine opencode client; free tier only works through it)
OPENCODE_SERVER_PASSWORD=$(openssl rand -hex 32) opencode serve --port 4187 --hostname 127.0.0.1
# then set the same value as DANI_FREE_OPENCODE_API_KEY in .env
```

```sh
# .env
DANI_FREE_OPENCODE_BASE_URL=http://127.0.0.1:4187
DANI_FREE_OPENCODE_API_KEY=<same password>
```

The key is sent as HTTP Basic `opencode:<key>` on every sidecar request. Unset means no auth, which is fine for local loopback dev. The password is optional for loopback dev (no password = no auth); it is required-ish for anything non-loopback or shared.

## OpenCode boundary

Dani-Free is an OpenAI-compatible inference proxy. For the OpenCode ids it drives the local `opencode serve` sidecar's session API and translates the result into OpenAI SSE; it does not implement OpenCode ACP or own OpenCode's agent loop. Do not point the adapter at anything other than the sidecar and expect the free tier to work.

## Security

The canonical implementation guide for AI agents and custom model-provider clients is [`AGENT_INTEGRATION.md`](AGENT_INTEGRATION.md). It documents the protocol contract, the pinned Kilo selector, setup, OMP, Python, JavaScript, security, failure handling, and an integration checklist.

The shorter provider templates remain in [`integrations/`](integrations/), and the operational skill is in [`skills/dani-free/SKILL.md`](skills/dani-free/SKILL.md).
