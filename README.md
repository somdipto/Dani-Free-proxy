# Dani-Free

Dani-Free is a small Bun/TypeScript local OpenAI-compatible router.

## Quick Install (one-liner)

```sh
curl -fsSL https://raw.githubusercontent.com/somdipto/Dani-Free-proxy/main/bootstrap.sh | bash
```

Installs Bun if needed, clones the repo, creates `.env` from `.env.example` (mode 600, only if missing), and runs the full setup. Then:

```sh
dani-free start
```

Point your agent at `http://127.0.0.1:4190/v1` with model `auto`.

### Paste-this prompt (any harness)

Give this block to any agent (Hermes, OMP, OpenCode, Composio, Agent Mail, a plain coding agent):

> Run `curl -fsSL https://raw.githubusercontent.com/somdipto/Dani-Free-proxy/main/bootstrap.sh | bash`. Then start the proxy with `dani-free start` (add `export PATH="$HOME/.local/bin:$PATH"` first if the command is not found). Point your OpenAI-compatible client at base URL `http://127.0.0.1:4190/v1` with model `auto`. Verify with `curl -fsS http://127.0.0.1:4190/health` and `curl -fsS http://127.0.0.1:4190/v1/models`. Never commit `.env` or any API key. If a backend credential is missing, report the error — never substitute a paid model.

---

Dani-Free is a small Bun/TypeScript local OpenAI-compatible router. The standard listener advertises three OpenCode free ids, then three Kilo free ids. `auto` walks an OpenCode-first six-model failover chain starting at `opencode/nemotron-3-ultra-free` — not an alias: if nemotron fails, another model in the chain answers. If a selected model is missing or unhealthy it is skipped; if it fails with a transport error, a 408, a 429 (pauses briefly, then advances to the next model — no pause after the final attempt), a 5xx, an anomalous HTTP 204, 1xx, or 3xx response (no content, an interim status, or a redirect — never a chat answer), an HTTP 200 with empty content or a malformed `choices` key, an HTTP 200 with an invalid JSON body, an HTTP 200 with a non-JSON, non-SSE body, an HTTP 200 carrying an `{"error": …}` envelope (OpenAI-style object, bare-string, string-array, list-of-error-objects, message-less numeric-code, bare-numeric, nested-envelope, plural-`errors`-key, Python-style `status_code`/`statusCode`-key, or FastAPI-style `detail`-key, or nested-`detail`-key form, `msg`-keyed form, or top-level-`msg`-keyed form, top-level-`message`-keyed form, or top-level-`code`-keyed form; an envelope carrying a 429 error code/status in `code`/`status`/`status_code`/`statusCode`/`type` — including a recognized rate-limit string code such as `rate_limit_exceeded` or `rate_limit_error` (even when keyed as `msg` or `message` (nested or top-level), or carried on the top level as `code`/`status`/`status_code`/`statusCode`/`type`) — pauses like a real 429 before advancing), or an HTTP 200 whose body exceeds the 8 MiB buffer cap, the router fails over to the next model in the chain. If the 200 body fails mid-read, the response is handed to the caller as-is instead, preserving the upstream error surface. Each attempt also has its own per-attempt deadline (default 60s, `DANI_FREE_ATTEMPT_TIMEOUT_MS`, clamped to the overall request deadline): a hung backend is abandoned after that long and the chain walks on with an `attempt timed out` reason. The overall request deadline is shared by all attempts: if it fires mid-chain (or the caller cancels), the request ends with a 504 without trying the remaining models. Any other 4xx refusal from the upstream is returned to the caller as-is with an `x-dani-free-model` header naming the model that answered. If every model in the chain fails, the caller gets a 503 `all_models_failed` with per-attempt reasons. Free-tier availability is promotional and can change; `:free` in an id is not a billing or privacy guarantee.

## Model catalog: auto-refresh, auto default, picker (`dani-free start`)

`dani-free start` runs from a live model catalog instead of a fixed six-model list:

- **Refresh on every start and every 24h** (plus up to 30 min of random spread). Each refresh re-reads the Kilo gateway's model list and keeps every currently free, unexpired chat model, so a free model released today shows up with no code change, and an expired one goes away. `dani-free refresh` (or `POST /v1/models/refresh`, accepted from this machine only) refreshes right away.
- **New models get a real test.** A model that has never answered gets one tiny test prompt during refresh. Models present at first install are the baseline; models that show up later carry `"new": true` in `/v1/models` for 7 days.
- **`auto` is the default** and is listed first in `/v1/models` (`"default": true`). It tries healthy models in catalog order. A rate-limited model (429) goes on a short cooldown and is tried after the others, but it is never hidden. A model that fails 3 times in a row for other reasons is hidden until it answers again.
- **Picker:** any id from `/v1/models` can be sent as `model` to pin it. If it fails, the rest of the chain still answers.
- The catalog lives in `~/.config/dani-free/catalog.json` (mode 600). A failed refresh keeps the last catalog, and chat never waits for a refresh.
- Kilo's free models work without an API key (anonymous, rate-limited by Kilo to 200 requests/hour per IP). A `DANI_FREE_KILO_API_KEY` raises that limit.
- The OpenCode sidecar adapter is **off** on this listener unless `DANI_FREE_ENABLE_OPENCODE=1`. OpenCode has said its free tier may not be used from other harnesses.

| Variable | Purpose |
| --- | --- |
| `DANI_FREE_CATALOG_PATH` | Catalog file; defaults to `catalog.json` next to the config file. |
| `DANI_FREE_REFRESH_INTERVAL_HOURS` | Hours between background refreshes (1-168, default 24). |
| `DANI_FREE_PROBE_ON_REFRESH` | `0` turns off the one-prompt test for never-answered models. |
| `DANI_FREE_ENABLE_OPENCODE` | `1` adds the OpenCode sidecar adapter to `dani-free start`. |

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

## Speed, failover, and cancellation behavior

The router keeps a five-second model-discovery cache. The request deadline starts when the request is received, includes discovery, and stays active through streamed response EOF. Each attempt runs under its own per-attempt deadline (default 60s, `DANI_FREE_ATTEMPT_TIMEOUT_MS`, clamped to the request deadline), so a hung backend is abandoned and the chain walks on instead of burning the whole deadline on one attempt. On failure the router walks the OpenCode-first chain: an explicit selector is tried first, then the remaining models. Client cancellation is terminal, and once streamed bytes have been emitted to the client there is no failing over. Any other 4xx refusal from an upstream is passed through to the caller rather than retried (408 and 429 fail over, as above). On a 429 the router honors the upstream `Retry-After` header (delta-seconds or HTTP date, clamped at 30s) when pausing before the next attempt, since the cooldown usually applies to the whole rate-limited backend rather than one model.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DANI_FREE_HOST` | Bind address; defaults to `127.0.0.1`. |
| `DANI_FREE_PORT` | Listen port; defaults to `4190` (`4290` for the Kilo-only listener). |
| `DANI_FREE_API_KEY` | Optional client API key. When set, clients must send `Authorization: Bearer <value>` (case-insensitive scheme) or the `x-api-key` header with the same value. |
| `DANI_FREE_KILO_BASE_URL` | Verified Kilo Code endpoint. Defaults to `https://api.kilo.ai/api/gateway`. |
| `DANI_FREE_KILO_API_KEY` | Kilo Code endpoint credential, if required. |
| `DANI_FREE_OPENCODE_BASE_URL` | `opencode serve` sidecar base URL. Defaults to `http://127.0.0.1:4187`. |
| `DANI_FREE_OPENCODE_API_KEY` | Sidecar password, only when the sidecar runs with `OPENCODE_SERVER_PASSWORD`. Sent as HTTP Basic `opencode:<key>`; never as a Bearer token and never to any remote API. |
| `DANI_FREE_MIMO_BASE_URL` | Verified MiMo Code endpoint (OpenAI-compatible). Optional; an invalid or non-HTTP(S) value leaves the adapter unavailable, and an unset value means the MiMo adapter only runs in command mode. Also accepted from the JSON file's `mimo` object. |
| `DANI_FREE_MIMO_API_KEY` | MiMo endpoint credential, if required. Also accepted from the JSON file's `mimo` object. |
| `DANI_FREE_MIMO_COMMAND` | Absolute path to the `mimo` executable. Starts a local `mimo serve` HTTP server on `DANI_FREE_MIMO_SERVE_PORT` and speaks the opencode protocol to it; the CLI's own command protocol and flags are not verified, so command mode only uses the `mimo serve` HTTP API. Also accepted from the JSON file's `mimo` object. |
| `DANI_FREE_MIMO_PROTOCOL` | `openai` (default) or `opencode`. Env-only: the MiMo adapter reads it from the process environment, not from the JSON file. Any other value makes the transport unavailable. |
| `DANI_FREE_MIMO_SERVE_PORT` | Command-mode server port; defaults to `4191` and must be an integer from 1 to 65535. Env-only. |
| `DANI_FREE_MIMO_PROVIDERS` | Comma-separated provider ids the opencode-protocol path may use; defaults to `mimo`. Env-only. |
| `DANI_FREE_MIMO_AGENT` / `DANI_FREE_MIMO_ORCHESTRATOR` | Agent name for opencode-protocol prompts; `DANI_FREE_MIMO_AGENT` wins, then `DANI_FREE_MIMO_ORCHESTRATOR`, then `build`. Env-only. |
| `DANI_FREE_BODY_LIMIT_BYTES` | Incoming request-body size cap; defaults to 4 MiB. Bodies larger than the cap are rejected with a 413 `request_too_large` (the router library default is 1 MiB when no config is used). |
| `DANI_FREE_REQUEST_TIMEOUT_MS` | Single request deadline in milliseconds, shared across incoming body, discovery, completion, and streamed response EOF; defaults to 180_000 for the standard listener and 120_000 for the Kilo-only listener. Must be an integer between 100 and 300_000. |
| `DANI_FREE_ATTEMPT_TIMEOUT_MS` | Per-attempt deadline in milliseconds for one model in the failover chain; a hung backend is abandoned after this long and the chain walks to the next model. Defaults to 60_000 and is clamped to the overall request deadline; must be an integer between 5_000 and 300_000. |
| `DANI_FREE_CONFIG` | Optional JSON config file path. Defaults to `~/.config/dani-free/config.json` when it exists; a missing file is only an error when this variable names it explicitly. |

Settings resolve with defaults first, then the JSON file, then environment variables: any `DANI_FREE_*` variable above overrides the same key from the file. The file accepts the flat keys `host`, `port`, `apiKey`, `requestTimeoutMs`, `attemptTimeoutMs`, `bodyLimitBytes`, plus one object per backend (`opencode`, `kilo`, `mimo` — or nested under `backends`) with `baseUrl`, `apiKey`, `command`, and `timeoutMs`.

The Kilo-only listener on `:4290` advertises the three Kilo ids and walks them as a three-model failover chain on `auto`, starting at Nex Pro (not pinned to one model; the Nex Pro primary is only used for the precise 404/503 when the chain is empty). It resolves the same JSON config file and `DANI_FREE_*` variables as the standard listener, but keeps its own defaults (port `4290`, request deadline `120_000`); client API-key auth (`DANI_FREE_API_KEY`) is not enforced on `:4290`.

## API

- `GET /health` — backend configuration and health state.
- `GET /v1/models` — OpenAI-compatible model list.
- `POST /v1/chat/completions` — OpenAI-compatible chat completion request/response.

The `model` selector is one of:

- `auto` — the ordered failover chain, starting at `opencode/nemotron-3-ultra-free` and failing over to the next healthy model (OpenCode-first, then Kilo) on retryable errors. Not an alias: if nemotron fails, the request is served by another model.
- the six ids from `GET /v1/models`: `opencode/nemotron-3-ultra-free`, `opencode/muse-spark-1.3-contributor-free`, `opencode/mimo-v2.6-flash-free`, `kilo/nex-agi/nex-n2.5-pro:free`, `kilo/dots-studio/dots-3-note-preview:free`, `kilo/nex-agi/nex-n2.5-mini:free`.
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

The canonical implementation guide for AI agents and custom model-provider clients is [`AGENT_INTEGRATION.md`](AGENT_INTEGRATION.md). It documents the protocol contract, the `auto` failover chain and the Kilo-only listener, setup, OMP, Python, JavaScript, security, failure handling, and an integration checklist.

The shorter provider templates remain in [`integrations/`](integrations/), and the operational skill is in [`skills/dani-free/SKILL.md`](skills/dani-free/SKILL.md).
