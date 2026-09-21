# Design

## Decision

Reuse `OpenCodeAdapter` against `http://127.0.0.1:4187/v1`. Do not add ACP to this proxy.

## Defaults

`defaultAdapters()` = `[kiloAdapter, openCodeAdapter]`.

`createRouterServer` default allowlist = Kilo primary plus the three OpenCode free ids above.

Callers that pass `allowedModels` keep that list. `kilo-only.ts` still passes Kilo-only adapters; extra OpenCode allowlist entries then 503 as `backend_unavailable` if requested.

## Errors

Preserve upstream 401/429/503/timeout. No second-model retry.

## Honest limit

This is the legacy Chat Completions shim, not official OpenCode ACP. OpenCode has said free-tier use in other harnesses is restricted. Upstream 403/429 is returned, not hidden.
