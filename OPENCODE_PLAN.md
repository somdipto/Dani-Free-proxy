# OpenCode access plan

## Goal and decision

Give developers a useful coding environment without requiring a paid subscription. Both Kilo and OpenCode remain required. Only public/non-sensitive material may leave the machine. This is a plan, not a verified integration or authorization to change running services.

The user's latest clarification permits considering an official bridge. That opens a different product architecture: one front end with two execution modes, not one interchangeable inference proxy.

- **Kilo mode:** OMP owns the agent loop; Dani-Free supplies authorized free inference.
- **OpenCode mode:** the genuine local OpenCode agent owns its loop, reached through its documented ACP interface. The application displays progress, asks for permissions, and controls cancellation.
- **Direct OpenCode free inference under OMP:** remains blocked by the provider's explicit external-harness restriction. A bridge must not be used merely to disguise OMP inference traffic as OpenCode traffic.

No identity spoofing, session replay, account/IP rotation, paid fallback, or removal of upstream access checks belongs in this plan.

## Research: questions and findings

Research used three perspectives: access policy, protocol/adapter architecture, and verification/rollout, followed by the user's product-priority clarification.

| Question | Finding |
| --- | --- |
| Can third-party applications use OpenCode itself? | Yes. Official ACP documentation describes editor integrations running `opencode acp`, with built-in tools, MCP, rules, agents, and permissions. [1] |
| Is that a raw model API? | No. ACP connects a client to an agent. The HTTP server likewise exposes sessions, messages, permissions, files, and abort operations. [1][2] |
| Does a free model in the catalogue authorize external inference? | No. An OpenCode collaborator explicitly states that the free tier cannot be used in other harnesses. [3] |
| Is free-model availability through our proposed ACP application proven? | No. The documented agent integration is a credible path to investigate, not proof that every model, account, region, or distribution arrangement is supported. |
| Are paid alternatives available? | Zen documents paid external endpoints; Go documents paid access for other coding agents. Neither meets the user's zero-payment requirement and neither should be silently enabled. [4][5] |
| Can we promise Claude/Codex-equivalent results? | No. Comparable developer value is a benchmark target, not a property supplied by a proxy. |

## Implementation sequence

### 1. Prove the official-agent path before building a proxy around it

Use an unmodified supported OpenCode release as a local ACP subprocess, a disposable home, and a synthetic public project. Do not read existing credentials, inherit the user's full configuration, or change OMP settings.

First inspect the installed release's ACP capabilities and configuration isolation behavior. Then exercise initialization, session creation, model discovery/selection, prompt, streamed progress, permission requests, cancellation, and a second turn. Select a currently available free OpenCode model explicitly. Paid credentials and automatic paid model selection must be absent; auxiliary title/summary requests must also stay within the free policy.

Success requires an actual public-fixture coding task: inspect a file, propose/edit it with the expected permission flow, run its harmless verification command, and report the result. Capture the model identity and agent/tool events without secrets. A greeting alone is insufficient.

If the genuine agent receives an entitlement or policy denial, preserve the error and stop that route. Ask OpenCode for clarification covering a local third-party ACP client and the exact free models. Do not transform the denial into a fingerprint-spoofing project.

### 2. Make the ownership boundary explicit

Proposed flow:

```text
Developer application
  |-- Kilo / OMP mode --> OMP agent --> Dani-Free --> Kilo inference
  |-- OpenCode mode ---> ACP client --> local OpenCode agent --> permitted models
```

The application is an ACP client in OpenCode mode, not a second agent issuing raw model turns. OpenCode owns planning, model context, tool invocation, and continuation. The host may provide supported file/terminal facilities and permission UI, but there must be one owner for each tool invocation.

Show the active engine. Do not expose the OpenCode agent as a falsely equivalent `/v1/chat/completions` backend. Do not silently switch engines mid-task: their sessions, permissions, context, and tool semantics differ.

If OMP must remain the sole agent harness for every mode, this design does not meet that requirement; explicit upstream authorization for direct free inference is then necessary.

### 3. Integrate ACP as a separate execution path

Before editing, inspect the existing application engine/ACP contracts and the existing `OpenMausBot/server/drivers/acp/opencode-free.ts` driver. Reuse the repository's established driver and permission patterns rather than creating a competing engine abstraction. Run LSP references before modifying exported contracts.

Implement real session lifetime, streaming updates, permission decisions, cancellation, process exit handling, model discovery, and multi-turn continuation. Replace static model assumptions and no-op cancellation where confirmed in the chosen path. Keep OpenCode's own tools native; do not flatten tool events into assistant prose or execute them a second time in OMP.

Scope the workspace to an explicitly selected public project. Do not expose private home files, secrets, inherited MCP servers, or arbitrary external directories. Prompt labels and secret scanners alone cannot guarantee non-sensitive context: tool results and project instructions also enter model requests.

Start with a user-local installation. A centrally hosted multi-user gateway has different quota, isolation, redistribution, and authorization requirements; local ACP support is not evidence that pooling the free service is permitted.

### 4. Repair the inference-router defects independently

These remain necessary for the Kilo/OMP mode; they are not a workaround for OpenCode access:

- `src/adapters/kilo.ts`: enforce current zero-price admission and the real catalogue capability schema; prevent BYOK or paid fallback.
- `src/types.ts`: represent the admission metadata actually needed by routing.
- `src/router.ts`: capability-aware selection, incoming cancellation, deadlines through body EOF, bounded discovery, and preservation of HTTP failure classes.
- `src/adapters/opencode.ts`: do not relabel the current localhost Chat Completions adapter as official ACP or direct Zen. Its fixed `/chat/completions` and guessed health paths are not either contract.
- `src/server.ts`, configuration, and integration docs: accurately distinguish inference backends from agent engines and remove unsupported readiness claims during the eventual cutover.

An authorized future direct Zen path would additionally need exact per-model endpoint/protocol admission. Chat Completions, Responses, and Messages are not interchangeable payloads. Unsupported models must be rejected rather than silently translated incompletely.

### 5. Verify behavior and developer value

First use a deterministic fake ACP peer to prove session isolation, permission denial, cancellation, process failure, and multi-turn state. Use fake HTTP upstreams for the router's price, capability, error, and full-stream deadline regressions.

For Dani Bot server/conversation changes, follow `docs/verification/README.md`: launch an isolated fixture, pass its printed URL explicitly, and retain action plus resulting-state evidence. The default fake-engine fixture does not itself prove OpenCode inference; use a separately isolated native OpenCode canary for that claim.

Run the genuine OpenCode ACP task from step 1 through the actual application integration. Check that denial prevents execution, cancellation stops further work, another session remains unaffected, and the next turn continues correctly. No user live app/data, legacy service restart, or persistent harness change is allowed during verification.

Evaluate both modes on the same public bug-fix, feature, refactoring, and test-repair tasks. Measure successful checks, correctness review, elapsed time, failed tool calls, interventions, and quota exhaustion. Compare against recorded Claude/Codex baselines only where those baselines actually exist. Report results rather than promising parity.

### 6. Release gate and rollback

Both providers must pass their own end-to-end checks; Kilo-only is not completion. The OpenCode release claim must say **official OpenCode agent integration**, not **OpenCode free inference under OMP**.

Required evidence: supported free model in the genuine client, working tool loop, accurate permissions, bounded cancellation, no paid/auxiliary billing, public-only context isolation, and explicit engine selection. Confirm distribution conditions with OpenCode before offering a shared hosted service.

Use a separate loopback canary/process and disposable configuration. Leave existing listeners and launch services unchanged. Activation requires explicit approval. Rollback stops only the owned canary and restores only the approved client selection; it must not replay interrupted tool actions or quietly fall back to a paid engine.

## Current status

An isolated feasibility check exercised the installed unmodified OpenCode 1.18.31 through `opencode acp --pure`. It ran with an empty inherited environment apart from an explicit PATH, disposable HOME/XDG directories, and isolation flags. No user credentials, installed harness configuration, Kilo configuration, or live services were changed.

- ACP initialization and session creation succeeded; seven free models were advertised.
- The default `opencode/big-pickle` prompt produced `AI_APICallError: Rate limit exceeded. Please try again later.` in the agent log, including its auxiliary title request. No answer was received.
- A `session/cancel` notification returned the outstanding prompt as `end_turn` with zero input/output tokens. This is cancellation evidence, not a successful completion.
- `session/set_config_option` selected `opencode/ling-3.0-flash-fin-free`. Its subsequent synthetic prompt produced the same rate-limit error. No answer was received.
- A separate official `opencode run --pure --format json -m opencode/ling-3.0-flash-fin-free` probe in the disposable home was killed at its 90-second deadline with no stdout/stderr; its log stopped during initialization. That probe does not establish a CLI inference result.
- The owned ACP process was stopped after the checks. No paid route, altered client identity, or proxy bypass was attempted.

Evidence log retained at `/var/folders/nq/193tn3ds45lbjh8nr6_pfx700000gp/T/dani-opencode-check-VON5me/data/opencode/log/opencode.log`. The fixture contains only synthetic prompts and disposable OpenCode state.

**Current blocker:** actual free inference capacity through the genuine client. Two advertised models were rate-limited. Catalogue discovery and ACP transport work, but tool execution, coding quality, and successful model completion are not proven. No application integration repair or launch is claimed. The scope/reset time of the upstream limit is not established by the observed error; do not assume changing an adapter can remove it.

## Sources

1. Official ACP integration: https://opencode.ai/docs/acp
2. Official headless server/session API: https://opencode.ai/docs/server
3. Free-tier restriction, collaborator response: https://github.com/anomalyco/opencode/issues/49621#issuecomment-5723383322
4. Zen endpoints, billing, and privacy: https://opencode.ai/docs/zen
5. Go external-client contract and paid limits: https://opencode.ai/docs/go
6. Existing repository evidence: `EXTERNAL_ACCESS_RESEARCH.md`
7. Isolated verification contract: `../docs/verification/README.md`
