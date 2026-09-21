# Proposal: OpenCode free models on Dani-Free

## Why

`:4190` currently advertises only `kilo/nex-agi/nex-n2.5-pro:free`. OpenCode free models are available on the local `:4187` proxy and are missing from Dani-Free. That is why `opencode/...` selectors fail after the pin.

## What

Standard `dani-free start` must load Kilo and the existing OpenCode HTTP adapter. Advertise only:

- `opencode/muse-spark-1.3-contributor-free`
- `opencode/muse-spark-1.2-contributor-free`
- `opencode/mimo-v2.5-free`
- `kilo/nex-agi/nex-n2.5-pro:free` (below OpenCode)

`auto` is Muse Spark 1.3. A failure on one id does not call another.

## Non-goals

- OpenCode ACP
- Zen paid models
- Ranking or fallback
- Changing `:4290` kilo-only into OpenCode
