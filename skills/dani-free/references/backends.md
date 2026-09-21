# Backend configuration reference

Dani-Free reads resolved configuration from its JSON file and environment. The standard listener constructs OpenCode and Kilo adapters from that configuration.

The standard preference order is three OpenCode ids then three Kilo ids. `auto` is Muse Spark 1.3, but `/v1/models` lists only discovered exact ids.

## Listener and backends

| Variable | Meaning |
| --- | --- |
| `DANI_FREE_HOST` | Bind address. Default is `127.0.0.1`. |
| `DANI_FREE_PORT` | Listening port. Default is `4190`. |
| `DANI_FREE_API_KEY` | Optional key for clients of the Dani-Free HTTP API. If set, require `Authorization: Bearer <value>`. |
| `DANI_FREE_OPENCODE_BASE_URL` | Explicit, provider-authorized OpenAI Chat Completions-compatible endpoint. Unset by default. |
| `DANI_FREE_OPENCODE_API_KEY` | Credential required by that endpoint, if any. |
| `DANI_FREE_KILO_BASE_URL` | Verified Kilo Code HTTP endpoint, including its scheme and optional path. Defaults to `https://api.kilo.ai/api/gateway`. |
| `DANI_FREE_KILO_API_KEY` | Credential required by that endpoint, if any. |

Verify the endpoint and authentication with the Kilo Code installation before use. A URL that merely responds is not proof that its model or chat protocol is compatible.

After changing configuration, restart the process and inspect `/health` and `/v1/models`. A configured endpoint or zero-priced catalogue row does not prove OpenCode free-tier authorization, entitlement, tool support, or model availability. Do not use an OpenCode ACP or agent-session bridge as a substitute for a direct completion endpoint.
