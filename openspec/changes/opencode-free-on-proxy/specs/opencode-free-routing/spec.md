# Spec: OpenCode free routing

## Requirements

- The standard listener SHALL include the OpenCode HTTP adapter.
- `/v1/models` SHALL list at most the Kilo primary and the three OpenCode free ids in the design.
- `auto` SHALL resolve to `kilo/nex-agi/nex-n2.5-pro:free`.
- An explicit OpenCode id outside that set SHALL return 404.
- A 429/503/timeout on one model SHALL NOT select another model.
