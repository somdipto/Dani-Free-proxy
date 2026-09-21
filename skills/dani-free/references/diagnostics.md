# Diagnostics reference

Use the router's observable state before changing code or credentials.

## First checks

```sh
curl -sS http://127.0.0.1:4190/health
curl -sS http://127.0.0.1:4190/v1/models
```

`/health` reports each backend's `configured` and `healthy` state, check time, reason, and (when available) latency. A backend that is not configured is not an outage: configure a verified endpoint/command or choose another selector.

`/v1/models` is the source of truth for model ids. If a model is absent, do not guess an id or route directly to another backend's id.

## Automatic-routing recovery

`auto` is the pinned Kilo model. There is no second-model retry.

```sh
# Stop the existing foreground Dani-Free process with Ctrl-C.
dani-free start
```

Then verify the repair with:

```sh
curl -fsS http://127.0.0.1:4190/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Reply with exactly AUTO_ACK"}]}'
```

Expected result: a `200` response containing `AUTO_ACK`. If it fails, use the exact model id returned by `/v1/models` to isolate the backend.

## Failure interpretation

1. `401`/`403`: client API key or upstream backend credential is missing/invalid. Redact credentials before sharing output.
2. `404`: wrong route, explicit backend, or model selector. Check the exact selector; do not append guessed paths or silently switch providers.
3. `429`/`5xx`: upstream throttling or failure with its status preserved. Do not switch models.
4. Network/timeout errors: verify the process is reachable, then verify the Kilo endpoint. A `504` can mean discovery or the request reached its deadline.
5. `400`/`422`: request is not compatible with the OpenAI chat shape or selected model. Compare against the deterministic fixtures in `test/fixtures/`.
6. Cancellation: an aborted incoming request is terminal. Do not retry after cancellation or after a stream has begun.
## Safe troubleshooting sequence

1. Confirm the process is listening on the expected host and port.
2. Check `/health` without printing `.env`.
3. Check `/v1/models` and copy an exact returned model id.
4. Confirm requested capabilities match the candidate before sending the request.
5. Send a minimal non-streaming request with `temperature: 0` and a short `max_tokens` value.
6. If the request fails, isolate the explicit selector (`kilo/<id>` or `mimo/<id>`; `opencode/<id>` only for a deliberately supplied legacy adapter) before trying `auto`.
7. Redact `Authorization`, API keys, cookies, prompts containing secrets, and full upstream response bodies in reports.

Do not mark an unavailable backend healthy by adding static model entries or by replacing its endpoint with an unverified provider. Do not treat installation of the Dani-Free skill in an OpenCode skill directory as an OpenCode ACP bridge or automatic enrollment.
