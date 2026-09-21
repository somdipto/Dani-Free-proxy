# Dani-Free v2: the boundary before the fix

**2026-09-20 launch decision:** both providers are required; public/non-sensitive data only. Launch is blocked on authorized external OpenCode free access. Read [the primary-source research and current-code audit](EXTERNAL_ACCESS_RESEARCH.md) before using the earlier design narrative below as an implementation claim.

The failure looked like delegation: an OMP turn sat on “Working…” for minutes, and it was tempting to blame the model for spawning work or to make another provider responsible for finishing it. The evidence says those are different jobs. **OMP is the agent harness**: it owns the conversation, tools, files, approvals, and any child tasks. **An inference provider** returns one model response. When a provider is allowed to become a second agent harness, the system has two owners for the same work—and neither latency nor correctness can be measured cleanly.

That distinction makes the current delay legible. A request can wait in a two-slot OpenCode bridge, generate slowly against a large prompt, return to OMP, and then trigger another OMP model or tool step. One long `Working…` timer is therefore not proof that a provider spawned a subagent. It is only proof that the boundary is opaque. Dani-Free v2 begins by making that boundary explicit: OMP keeps agency; `:4290` supplies inference only; every crossing receives a trace.
