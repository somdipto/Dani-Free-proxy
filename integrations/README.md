# Dani-Free integrations

Use [`../AGENT_INTEGRATION.md`](../AGENT_INTEGRATION.md) as the canonical guide for integrating Dani-Free into an AI agent or custom model-provider client.

This directory contains copyable configuration fragments:

- [`omp-models.yml`](omp-models.yml) — OMP provider block.
- [`opencode.jsonc`](opencode.jsonc) — explicit OpenCode client/provider fragment; legacy OpenAI-compatible compatibility only, not an ACP bridge.
## Quick provider values

```text
Base URL: http://127.0.0.1:4190/v1
API key:  local, unless DANI_FREE_API_KEY is configured
Model:    auto (opencode/muse-spark-1.3-contributor-free), or an exact id from GET /v1/models
```

The minimum provider contract is:

```text
GET  /v1/models
POST /v1/chat/completions
```

Do not copy these values without first checking `/health` and `/v1/models`. Preserve existing provider configuration when merging the fragments; especially preserve existing OpenCode `enabled_providers` entries. The OpenCode fragment configures a client to call Dani-Free and does not enable an OpenCode backend or add it to `auto`.

Direct smoke test:

```sh
curl -fsS http://127.0.0.1:4190/health
curl -fsS http://127.0.0.1:4190/v1/models
curl -fsS http://127.0.0.1:4190/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Reply with exactly ACK"}]}'
```
