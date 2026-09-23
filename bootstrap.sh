#!/bin/sh
set -eu

REPO="https://github.com/somdipto/Dani-Free-proxy.git"
DEST="${DANI_FREE_DIR:-$HOME/workspace/Dani-Free-proxy}"

command -v git >/dev/null 2>&1 || {
  printf '%s\n' 'git is required but not installed.' >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || {
  printf '%s\n' 'curl is required but not installed.' >&2
  exit 1
}

command -v bun >/dev/null 2>&1 || {
  printf '%s\n' 'Installing Bun...'
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
}

if [ ! -d "$DEST" ]; then
  git clone "$REPO" "$DEST"
else
  (cd "$DEST" && git pull --ff-only)
fi

cd "$DEST"
sh ./install.sh

printf '\n%s\n' '✓ Done. Start the proxy with:'
printf '%s\n' "  dani-free start"
printf '%s\n' 'Then point your agent at: http://127.0.0.1:4190/v1'

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *)
    printf '\n%s\n' "Note: $HOME/.local/bin is not on PATH. Add it:"
    printf '%s\n' "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac