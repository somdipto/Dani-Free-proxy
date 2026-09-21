---
name: dani-free
description: Operate the Dani-Free local OpenAI-compatible router. auto starts at opencode/nemotron-3-ultra-free and walks the OpenCode-first six-model failover chain.
Canonical agent integration guide: the package root `AGENT_INTEGRATION.md`. Use it for provider setup, protocol behavior, the six-model allowlist, OMP integration, SDK examples, failure handling, and the completion checklist.

Use this skill to configure and operate the Dani-Free package; the package itself owns backend routing and protocol translation. Do not implement a second router in the skill.

## Start

1. Install Bun (1.1 or newer) and ensure each selected backend is installed and configured.
2. From a checkout, run `./install.sh`, or run `bun install` and `bun run start`.
3. Check `GET /health` and `GET /v1/models`.
4. Send a minimal non-streaming request to `POST /v1/chat/completions` before enabling advanced features.

The default listener is `127.0.0.1:4190`. Set `DANI_FREE_HOST` and `DANI_FREE_PORT` to change it. Keep the listener on loopback unless access from another trusted machine is intentional.

## Model selectors and routing

- `auto` starts at `opencode/nemotron-3-ultra-free` and walks the OpenCode-first six-model failover chain. Retryable failures (transport errors, 408, 429 with a brief backoff, 5xx, HTTP 200 with empty content, invalid JSON, an `{"error": …}` envelope — OpenAI-style object, bare-string, or string-array form — or an oversize body) advance to the next model; other 4xx refusals are passed through as-is. A request-deadline timeout or client cancellation never advances: it ends the request with a 504.
- Standard listener ids: three OpenCode free models, then three Kilo free models.
- Other `kilo/<id>`, `mimo/<id>`, and `opencode/<id>` values are rejected unless a custom adapter set was supplied.
- Use an exact model id returned by `/v1/models`. An explicit selector is tried first, then the remaining models in the chain: explicit selectors fail over too, they do not fail closed.
- Advertised models include `tools` and `reasoning` so OMP coding requests do not 422.

The API is OpenAI-compatible at `/v1/models` and `/v1/chat/completions`. Client cancellation is propagated and terminal.

## Backend configuration

Kilo Code requires its configured gateway and API key when required by the endpoint. OpenCode ids require the local `:4187` proxy.

See:

- [Routing](references/routing.md) for selector and request examples.
- [Backend configuration](references/backends.md) for every environment variable and verification procedure.
- [Diagnostics](references/diagnostics.md) for health checks, failure interpretation, and safe troubleshooting.

## Security rules

- Never commit `.env`, API keys, cookies, bearer tokens, or command output containing secrets.
- Keep `.env` readable only by the local user (`chmod 600 .env`).
- Prefer loopback host binding. If binding beyond loopback, put the router behind authenticated transport and a firewall; do not treat `DANI_FREE_API_KEY` as a substitute for network controls.
- Redact `Authorization` headers and full request/response bodies before sharing diagnostics.
- Treat `DANI_FREE_MIMO_COMMAND` as code: use an absolute, trusted executable and avoid shell interpolation of untrusted request data.

## Current limitation

Free-tier availability can change. If Kilo returns 429/503/timeout, Dani-Free reports that failure and does not switch models.
