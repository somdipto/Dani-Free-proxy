---
name: dani-free
description: Operate the Dani-Free local OpenAI-compatible router. auto is opencode/muse-spark-1.3-contributor-free.
Canonical agent integration guide: the package root `AGENT_INTEGRATION.md`. Use it for provider setup, protocol behavior, the six-model allowlist, OMP integration, SDK examples, failure handling, and the completion checklist.

Use this skill to configure and operate the Dani-Free package; the package itself owns backend routing and protocol translation. Do not implement a second router in the skill.

## Start

1. Install Bun (1.1 or newer) and ensure each selected backend is installed and configured.
2. From a checkout, run `./install.sh`, or run `bun install` and `bun run start`.
3. Check `GET /health` and `GET /v1/models`.
4. Send a minimal non-streaming request to `POST /v1/chat/completions` before enabling advanced features.

The default listener is `127.0.0.1:4190`. Set `DANI_FREE_HOST` and `DANI_FREE_PORT` to change it. Keep the listener on loopback unless access from another trusted machine is intentional.

## Model selectors and routing

- `auto` selects `opencode/muse-spark-1.3-contributor-free`. The router does not retry another model.
- Standard listener order is three OpenCode ids, then three Kilo ids, but only exact discovered ids are advertised.
- Other `kilo/<id>`, `mimo/<id>`, and `opencode/<id>` values are rejected unless a custom adapter set was supplied.
- Use an exact model id returned by `/v1/models`. Explicit selectors fail closed.
- Capabilities come from backend discovery. A request requiring an unadvertised capability is rejected rather than silently flattened.

The API is OpenAI-compatible at `/v1/models` and `/v1/chat/completions`. Client cancellation is propagated and terminal.

## Backend configuration

Kilo Code requires its configured gateway and API key when required by the endpoint. OpenCode ids require an explicitly configured, provider-authorized OpenAI Chat Completions-compatible endpoint. Dani-Free does not start OpenCode ACP or an agent-session bridge.

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

Public OpenCode guidance does not establish authorized direct free-tier completion access for all requested ids. Configuration cannot supply that authorization. If the selected OpenCode or Kilo backend returns 401, 403, 429, 503, or a timeout, Dani-Free reports that failure and does not switch models.
