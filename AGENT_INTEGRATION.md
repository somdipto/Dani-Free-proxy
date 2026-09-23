# Dani-Free: agent integration guide

This is the canonical guide for an AI coding agent, developer, or integration author connecting to Dani-Free.

## 1. What Dani-Free is

Dani-Free is a local OpenAI-compatible model router. The standard listener lists three OpenCode free ids, then three Kilo free ids. `auto` walks an OpenCode-first six-model failover chain starting at `opencode/nemotron-3-ultra-free`: a missing or unhealthy model is skipped, and a transport error, 408, 429 (pauses briefly, then advances to the next model — no pause after the final attempt), 5xx, an anomalous HTTP 204, 1xx, or 3xx response (no content, an interim status, or a redirect — never a chat answer), an HTTP 200 with empty content or a malformed `choices` key, an HTTP 200 with an invalid JSON body, an HTTP 200 with a non-JSON, non-SSE body, an HTTP 200 carrying an `{"error": …}` envelope (OpenAI-style object, bare-string, string-array, list-of-error-objects, message-less numeric-code, bare-numeric, nested-envelope, plural-`errors`-key, Python-style `status_code`/`statusCode`-key, or FastAPI-style `detail`-key, or nested-`detail`-key form, `msg`-keyed form, or top-level-`msg`-keyed form, top-level-`message`-keyed form, or top-level-`code`-keyed form), or an HTTP 200 whose body exceeds the 8 MiB buffer cap fails over to the next model in the chain. Each attempt also has its own per-attempt deadline (default 60s, `DANI_FREE_ATTEMPT_TIMEOUT_MS`, clamped to the overall request deadline): a hung backend is abandoned after that long and the chain walks on with an `attempt timed out` reason. The overall request deadline is shared by all attempts: if it fires mid-chain (or the caller cancels), the request ends with a 504 without trying the remaining models. Any other 4xx refusal from the upstream is returned to the caller as-is with an `x-dani-free-model` header naming the model that answered. If every model in the chain fails, the caller gets a 503 `all_models_failed` with per-attempt reasons.

```text
Dani-Free standard route:
auto → opencode/nemotron-3-ultra-free, then the OpenCode-first failover chain
```

The agent does not need a Dani-Free plugin. It only needs support for a custom OpenAI-compatible provider.

Dani-Free is not a model, training service, credential vault, or replacement for the backend clients. It translates and routes requests; backend credentials remain backend configuration.

## 2. The provider contract

Default local endpoint:

```text
Base URL: http://127.0.0.1:4190/v1
API key:  local, unless DANI_FREE_API_KEY is set
```

Required client operations:

```http
GET  /v1/models
POST /v1/chat/completions
```

The router also exposes:

```http
GET /health
```

Minimal request:

```json
{
  "model": "auto",
  "messages": [
    {"role": "user", "content": "Reply with exactly ACK"}
  ]
}
```

Minimal shell verification:

```sh
curl -fsS http://127.0.0.1:4190/health
curl -fsS http://127.0.0.1:4190/v1/models
curl -fsS http://127.0.0.1:4190/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Reply with exactly ACK"}]}'
```

If `DANI_FREE_API_KEY` is configured, send it as:

```http
Authorization: Bearer <DANI_FREE_API_KEY>
```

or, equivalently, as the `x-api-key` header with the same value (the Bearer <redacted> is matched case-insensitively). The router's own CLI sends both.

Never put a real key in a checked-in config, prompt, fixture, or diagnostic report.

## 3. Model selection

Always call `/v1/models` and use an exact returned id.

Supported selectors on the standard listener:

```text
auto                                          OpenCode-first failover chain starting at opencode/nemotron-3-ultra-free
opencode/nemotron-3-ultra-free                OpenCode slot 1 (auto starts here)
opencode/muse-spark-1.3-contributor-free      OpenCode slot 2
opencode/mimo-v2.6-flash-free                       OpenCode slot 3
kilo/nex-agi/nex-n2.5-pro:free                Kilo slot 4
kilo/dots-studio/dots-3-note-preview:free     Kilo slot 5
kilo/nex-agi/nex-n2.5-mini:free               Kilo slot 6
```

Example:

```json
{"model":"kilo/nex-agi/nex-n2.5-pro:free", "messages":[...]}
```

Routing rules:

- `auto` maps to `opencode/nemotron-3-ultra-free` and then walks the OpenCode-first six-model failover chain (OpenCode first, then Kilo).
- Missing or unhealthy models are skipped. Transport errors, 408, 429 (pauses briefly, then advances to the next model — no pause after the final attempt), 5xx, an anomalous HTTP 204, 1xx, or 3xx response (no content, an interim status, or a redirect — never a chat answer), HTTP 200 with empty content or a malformed `choices` key, HTTP 200 with an invalid JSON body, HTTP 200 with a non-JSON, non-SSE body, HTTP 200 carrying an `{"error": …}` envelope (OpenAI-style object, bare-string, string-array, list-of-error-objects, message-less numeric-code, bare-numeric, nested-envelope, plural-`errors`-key, Python-style `status_code`/`statusCode`-key, or FastAPI-style `detail`-key, or nested-`detail`-key form, `msg`-keyed form, or top-level-`msg`-keyed form, top-level-`message`-keyed form, or top-level-`code`-keyed form; a recognized rate-limit string keyed as `msg` or `message` (nested or top-level) counts too), and HTTP 200 with a body exceeding the 8 MiB buffer cap fail over to the next model in the chain. A request-deadline abort never fails over: it ends the request with a 504. A per-attempt deadline abort (default 60s for one model, `DANI_FREE_ATTEMPT_TIMEOUT_MS`) does fail over to the next model with an `attempt timed out` reason. Any other 4xx refusal is passed through to the caller as-is, with an `x-dani-free-model` header naming the model that answered.
- An explicit selector is tried first, then the remaining models in the chain: explicit selectors fail over too, they do not fail closed.
- Other `kilo/<id>`, `mimo/<id>`, and `opencode/<id>` selectors are rejected unless the process was started with a custom adapter set and allowlist.
- An id appearing in `/v1/models` proves discovery, not guaranteed generation. Free-tier capacity can change.

## 4. Start and install

Requirements:

- Bun 1.1+
- A configured backend endpoint or local backend command
- Backend credentials where required

Portable install from a checkout:

```sh
cd /path/to/dani-free
./install.sh
```

Manual start:

```sh
bun install
bun run start
```

The installer adds `dani-free` to `~/.local/bin` and copies the operational skill into the OMP and OpenCode skill directories for documentation and invocation convenience. That installation does not install or authenticate backend services, does not add OpenCode to the automatic pool, and does not implement OpenCode ACP.

Useful commands:

```sh
dani-free start
dani-free status
dani-free models
dani-free doctor
```

The default listener is loopback-only. Do not bind it to a network interface unless the network is trusted and an external authentication/TLS boundary exists.

## 5. Configuration

Configuration can come from:

1. environment variables;
2. optional JSON at `~/.config/dani-free/config.json`;
3. command-line host/port overrides.

Common variables:

```text
DANI_FREE_HOST=127.0.0.1
DANI_FREE_PORT=4190
DANI_FREE_API_KEY=<client-key>

DANI_FREE_OPENCODE_BASE_URL=<verified-endpoint-if-explicitly-using-legacy-compatibility>
DANI_FREE_OPENCODE_API_KEY=<optional>

DANI_FREE_KILO_BASE_URL=https://api.kilo.ai/api/gateway
DANI_FREE_KILO_API_KEY=<required-by-kilo>

DANI_FREE_MIMO_BASE_URL=<verified-openai-endpoint>
DANI_FREE_MIMO_API_KEY=<optional>
DANI_FREE_MIMO_COMMAND=/absolute/path/to/mimo
DANI_FREE_MIMO_PROTOCOL=opencode
DANI_FREE_MIMO_SERVE_PORT=4191
```

The standard listener uses the OpenCode HTTP adapter plus Kilo. MiMo environment variables do not enroll extra models in `auto`.

## 6. Backend-specific setup

### Kilo Code

Kilo ids use Kilo's gateway. Configure `DANI_FREE_KILO_API_KEY` before starting the router. `:4290` is Kilo-only and walks the three-model Kilo failover chain on `auto`, starting at Nex Pro — not pinned to one model (the Nex Pro primary is only used for the precise 404/503 when the chain is empty).

### OpenCode

OpenCode ids go through the local `:4187` proxy. Dani-Free does not implement OpenCode ACP.

## 7. Optional legacy OpenCode client configuration

The following fragment configures an OpenCode client to call Dani-Free as an OpenAI-compatible provider. It is not an OpenCode ACP bridge and does not enable the legacy OpenCode adapter in Dani-Free's automatic pool.

Merge this into the user's existing OpenCode config. Preserve existing providers and append `dani-free` to `enabled_providers`; do not replace the whole array blindly.

```jsonc
{
  "enabled_providers": ["dani-free"],
  "provider": {
    "dani-free": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Dani-Free",
      "options": {
        "baseURL": "http://127.0.0.1:4190/v1",
        "apiKey": "local"
      },
      "models": {
        "auto": {"name": "Dani-Free Auto"}
      }
    }
  }
}
```

If an existing `enabled_providers` array is present, merge rather than overwrite it. Use this only for an explicit client integration; do not describe it as native OpenCode ACP or as proof of OpenCode free-tier availability.

## 8. OMP configuration

Copy the provider block from `integrations/omp-models.yml` into `~/.omp/agent/models.yml` and select:

```text
dani-free/auto
```

OMP must be able to reach the router before selecting the model. `auto` is the OpenCode-first failover chain starting at `opencode/nemotron-3-ultra-free`. Verify with:

```sh
omp models find dani-free --json
omp -p --no-tools --no-session --model dani-free/auto \
  'Reply with exactly ACK'
```

## 9. Other agents and SDKs

For any agent exposing a custom OpenAI-compatible provider, enter:

```text
Provider name: Dani-Free
Base URL:      http://127.0.0.1:4190/v1
API key:       local, or DANI_FREE_API_KEY
Model:         auto
```

Examples of clients that can use this pattern include Continue, Cline, Roo Code, LibreChat, Jan, and custom OpenAI SDK clients. Their exact config syntax differs; the transport values do not.

Python example:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:4190/v1",
    api_key="local",
)

result = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Reply with exactly ACK"}],
)
print(result.choices[0].message.content)
```

JavaScript example:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:4190/v1",
  apiKey: "local",
});

const result = await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Reply with exactly ACK" }],
});
console.log(result.choices[0].message.content);
```

## 10. Agent implementation algorithm

An agent integrating Dani-Free should follow this sequence:

1. Start or locate the router.
2. `GET /health`.
3. `GET /v1/models`.
4. Filter models by requested capability, if the client uses capabilities.
5. Select `auto` or one of the OpenCode/Kilo free ids listed by `/v1/models`.
6. Send a minimal non-streaming request first.
7. Enable streaming only if the selected backend/client path is known to support it.
8. Preserve backend error status and message in diagnostics, after redaction.
9. Do not invent model ids or silently substitute another backend for an explicit selector.
10. Do not retry a failed completion against another model.
11. Propagate request cancellation and treat cancellation as terminal.

## 11. Failure interpretation

| Result | Meaning | Action |
|---|---|---|
| `401` | Dani-Free client key is missing or invalid | Send the configured key as `Bearer <key>` or the `x-api-key` header |
| `413 request_too_large` | Request body exceeds `DANI_FREE_BODY_LIMIT_BYTES` (default 4 MiB) | Shrink the request (fewer/longer-turn messages) or raise the cap |
| `403` | Upstream credential rejected (passed through as-is) | Check backend credentials |
| `404` | Wrong Dani-Free route, explicit backend, or model selector | Check the exact selector; do not fall back |
| `429` | Upstream throttling. The router pauses briefly (backoff) before failing over to the next model — no pause after the final attempt, which ends in 503 — on `auto` and on explicit selectors alike; a missing or unhealthy explicit model fails closed instead | The router already retried the chain; check `x-dani-free-model`, then wait or switch backends if every model stays throttled |
| `5xx` | Backend failure. The router fails over to the next model on 408, 429, 5xx, anomalous 204/1xx/3xx responses, transport errors, empty 200s, 200s carrying an `{"error": …}` envelope (OpenAI-style object, bare-string, string-array, list-of-error-objects, message-less numeric-code, bare-numeric, nested-envelope, plural-`errors`-key, Python-style `status_code`/`statusCode`-key, or FastAPI-style `detail`-key, or nested-`detail`-key form, `msg`-keyed form, or top-level-`msg`-keyed form, top-level-`message`-keyed form, or top-level-`code`-keyed form), and oversized 200s — on `auto` and on explicit selectors alike; a missing or unhealthy explicit model fails closed instead | Check backend health; on repeated failures wait or use a different backend |
| `502 backend_network_error` | Router could not complete the upstream request | Inspect backend health and endpoint |
| `503 all_models_failed` | Every model in the failover chain failed; the body lists per-attempt reasons | Read the per-attempt reasons, then fix the backend configuration or wait |
| `504 timeout` | Discovery or the request reached its deadline | Check request size/cancellation and the router timeout |
| empty `/v1/models` | Discovery failed or no backend is configured | Check `/health` and credentials |

## 12. Security rules

- Bind to `127.0.0.1` by default.
- Do not expose the router directly to an untrusted network.
- Use `DANI_FREE_API_KEY` when multiple local processes need separation.
- Keep backend credentials outside source control.
- Use absolute trusted executable paths for `DANI_FREE_MIMO_COMMAND`.
- Never interpolate request text into a shell command.
- Redact authorization headers, keys, cookies, and sensitive prompts.
- Treat model output and tool calls as untrusted input.

## 13. What this contract does not promise

The current contract is centered on `/v1/chat/completions`, model discovery, text messages, and backend routing. It does not promise full support for every OpenAI API surface, including embeddings, audio, image generation, or `/v1/responses`. It also does not implement OpenCode ACP, native OpenCode tool ownership, or a universal agent harness.

## 14. Integration checklist

Before declaring an agent integration complete:

- [ ] Router starts on the intended host and port.
- [ ] `/health` responds.
- [ ] `/v1/models` returns at least one intended model.
- [ ] The exact selected model id came from `/v1/models`.
- [ ] Requested capabilities match the selected model.
- [ ] A minimal non-streaming completion returns text.
- [ ] Authentication is tested if enabled.
- [ ] Streaming behavior and cancellation are tested before enabling them by default.
- [ ] Existing provider config was merged, not overwritten.
- [ ] Failover is visible, not silent: every answer carries `x-dani-free-model` naming the model that actually answered — verify which backend served the request instead of assuming the requested one stayed fixed.
- [ ] Secrets are absent from logs, docs, and commits.
- [ ] Backend-specific failures remain visible.
