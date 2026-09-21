# Backend configuration reference

Dani-Free reads configuration from the process environment (normally `.env` when started through Bun). `dani-free start` starts OpenCode then Kilo.

The standard listener advertises three OpenCode ids then three Kilo ids. `auto` is Muse Spark 1.3.

## Listener and Kilo

| Variable | Meaning |
| --- | --- |
| `DANI_FREE_HOST` | Bind address. Default is `127.0.0.1`. |
| `DANI_FREE_PORT` | Listening port. Default is `4190`. |
| `DANI_FREE_API_KEY` | Optional key for clients of the Dani-Free HTTP API. If set, require `Authorization: Bearer <value>`. |
| `DANI_FREE_KILO_BASE_URL` | Verified Kilo Code HTTP endpoint, including its scheme and optional path. Defaults to `https://api.kilo.ai/api/gateway`. |
| `DANI_FREE_KILO_API_KEY` | Credential required by that endpoint, if any. |

Verify the endpoint and authentication with the Kilo Code installation before use. A URL that merely responds is not proof that its model or chat protocol is compatible.

After changing configuration, restart the process and inspect `/health` and `/v1/models`. The pinned model is usable only when Kilo is both configured and healthy.

## Custom adapters (unused by default)

`DANI_FREE_OPENCODE_*` and `DANI_FREE_MIMO_*` are not part of the standard pool. They are unused unless a caller deliberately constructs a custom adapter set. `dani-free start` does not read them as fallbacks.
