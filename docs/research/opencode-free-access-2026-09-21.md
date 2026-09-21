# OpenCode free-model access and Dani-Free

## Decision

**No compliant direct-inference route can make all three requested OpenCode IDs work as Dani-Free slots 1–3 today.** The controlling maintainer statement says: “You cannot use the free tier in other harnesses.” [The maintainer comment](https://github.com/anomalyco/opencode/issues/49621#issuecomment-5723383322) was posted in response to a report that third-party clients received `403 FreeTierError` while the genuine OpenCode client worked. The statement explicitly limits that restriction to the free tier.

Dani-Free therefore MUST NOT treat a free model’s catalogue presence, a local proxy’s response, or an OpenCode API-shaped endpoint as authorization to send OMP-owned model turns. An OpenCode failure MUST be returned as that model’s failure; it MUST NOT select a Kilo model or a paid model as a fallback.

## Requested slots and official model evidence

| Slot | Dani-Free ID | What the official Zen documentation proves | Direct external free inference through Dani-Free |
| --- | --- | --- | --- |
| 1 | `opencode/muse-spark-1.3-contributor-free` | The [Zen model table](https://opencode.ai/docs/zen#endpoints) lists `muse-spark-1.3-contributor-free`, maps it to `https://opencode.ai/zen/v1/responses`, and the [pricing table](https://opencode.ai/docs/zen#pricing) marks it Free. | **Not authorized.** Its documented wire format is Responses, not Chat Completions, and the maintainer’s free-tier restriction independently prohibits use from Dani-Free’s external harness. |
| 2 | `opencode/muse-spark-1.2-contributor-free` | The current [Zen endpoint table](https://opencode.ai/docs/zen#endpoints) lists the paid ID `muse-spark-1.2` but does **not** list `muse-spark-1.2-contributor-free`; the current [pricing table](https://opencode.ai/docs/zen#pricing) likewise contains no such free ID. An [official-repository issue report](https://github.com/anomalyco/opencode/issues/44847) claims that the exact ID was returned by `/zen/v1/models` and used `/responses`; that is reporter evidence, not a documented or maintainer-verified contract. | **Not established and not authorized.** There is no current first-party endpoint, price, or direct-external-access contract for this exact ID. |
| 3 | `opencode/mimo-v2.5-free` | The [Zen endpoint table](https://opencode.ai/docs/zen#endpoints) lists `mimo-v2.5-free`, maps it to `https://opencode.ai/zen/v1/chat/completions`, and the [pricing table](https://opencode.ai/docs/zen#pricing) marks it Free. | **Not authorized.** A documented Chat Completions shape does not override the maintainer’s free-tier restriction on other harnesses. |

The first column is the requested product configuration, not a claim that OpenCode currently offers every ID. The official documentation uses `opencode/<model-id>` for an OpenCode-configured Zen model ID, as documented in the [Zen model-ID section](https://opencode.ai/docs/zen#endpoints).

## Verified facts

### OpenCode’s documented external API and pricing

- OpenCode Zen documents API endpoints, but its setup instructs users to sign in, add billing details, and use an API key; it also says requests are charged per request. See [Zen: How it works](https://opencode.ai/docs/zen#how-it-works). Its zero-priced rows prove the listed token price, **not** permission for a separate agent harness to invoke the free tier.
- Zen’s endpoints are model-specific: the table assigns the 1.3 contributor-free model to `/responses` and MiMo-V2.5 Free to `/chat/completions`. See the [official endpoint table](https://opencode.ai/docs/zen#endpoints). Those protocols are not interchangeable merely because both are OpenAI-family APIs.
- The public maintainer statement is an explicit policy answer for the free tier: “We’ve been tightening our logic to fight abuse You cannot use the free tier in other harnesses (this is only a limitation for the free tier nothing else).” [Source](https://github.com/anomalyco/opencode/issues/49621#issuecomment-5723383322).

### Official ACP path

- OpenCode officially supports Agent Client Protocol (ACP) and tells compatible editor/IDE integrations to launch `opencode acp`; it is a subprocess communicating with the editor over JSON-RPC on stdio. [OpenCode ACP documentation](https://opencode.ai/docs/acp).
- ACP is an **agent** integration: OpenCode says ACP supports its built-in tools, custom tools and slash commands, configured MCP servers, project rules, formatters/linters, agents, and permissions. [OpenCode ACP documentation](https://opencode.ai/docs/acp#support).
- The OpenCode repository’s ACP command creates an OpenCode server and SDK client, initializes an ACP agent, and attaches it to an `AgentSideConnection`. [First-party source: `acp.ts`](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/cli/cmd/acp.ts). This corroborates that ACP is an agent-server connection, not a raw OpenAI Chat Completions endpoint.
- The separately documented `opencode serve` HTTP API exposes OpenCode sessions, messages, aborts, permissions, files, tools, and events. [OpenCode server API documentation](https://opencode.ai/docs/server#apis). It is an API for interacting with the OpenCode agent/server, not documentation of a direct free-inference service for an unrelated model router.

### Existing Dani-Free adapter

The current Dani-Free `OpenCodeAdapter` has no default endpoint. It discovers `GET /models` and sends `POST /chat/completions` only to an explicitly configured `DANI_FREE_OPENCODE_BASE_URL`, removing the `opencode/` prefix before the request. The standard policy reserves the three requested IDs before three Kilo IDs, but `/v1/models` publishes only IDs that the configured backend actually returns. This is repository-local source evidence in `src/adapters/opencode.ts`, `src/server.ts`, and `src/router.ts`, not OpenCode authorization.

**Authorization conclusion:** Configuring an OpenAI-compatible endpoint does not authorize OpenCode free-tier inference. A configured endpoint must be both provider-authorized and compatible with the adapter’s direct Chat Completions protocol. Neither localhost placement nor a generic API-shaped endpoint turns a request into the documented OpenCode ACP client or grants an exception.

Consequently, the adapter’s direct-request ownership differs from ACP’s documented agent ownership. It cannot faithfully invoke slot 1 with the current official Zen contract because that model is documented for `/responses`, not `/chat/completions`; it has no current official contract for slot 2; and slot 3’s matching wire shape remains blocked by the free-tier policy.

## Inferences and resulting boundary

The following are conclusions from the verified facts above, not quotations from OpenCode:

1. An OMP request routed by Dani-Free to the local OpenAI-compatible adapter is use in an “other harness”: Dani-Free/OMP, rather than the genuine OpenCode agent, owns the model turn and its tool-loop semantics. Under the maintainer statement, free-tier direct inference on that path is not authorized.
2. Replacing the adapter’s URL, replaying OpenCode-client details, or using `opencode serve` as a disguised completion proxy would not change the product boundary. The first two would conflict with the explicit restriction; the last would make OpenCode the agent and would not preserve OMP as the model/tool-loop owner.
3. ACP is a technically supported integration option only when presented honestly as an **OpenCode-agent execution mode**. It is not a compliant way to advertise the same three IDs as raw OpenAI-compatible Dani-Free slots, and it does not itself prove that every free model is available to a particular account, region, or client.

## Required next step

For the requested slots-as-inference-router design, the exact missing prerequisite is **written, first-party authorization for direct external free-tier inference from Dani-Free/OMP for each exact requested model ID**, including the supported endpoint and authentication conditions. Current maintainer guidance says the opposite, so the design is blocked rather than awaiting an adapter change.

A compliant alternative is to implement OpenCode ACP as a separately selected OpenCode-agent mode: start `opencode acp`, speak ACP over stdio, surface its own permissions/tool events/cancellation, and report entitlement or quota errors without fallback. That option must not be represented as OpenAI-compatible free inference for slots 1–3, and it still requires a real entitlement check for the selected model before it can be offered as working.

Kilo may remain in slots 4–6 only as its own independently authorized backend. It MUST NOT be an automatic rescue path for an OpenCode request or a means of concealing an OpenCode policy, capability, quota, or authentication failure.
