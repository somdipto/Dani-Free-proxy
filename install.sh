#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIN_DIR=${DANI_FREE_BIN_DIR:-"$HOME/.local/bin"}
OMP_SKILLS_DIR=${DANI_FREE_OMP_SKILLS_DIR:-"$HOME/.omp/agent/skills"}
OPENCODE_SKILLS_DIR=${DANI_FREE_OPENCODE_SKILLS_DIR:-"$HOME/.config/opencode/skills"}

command -v bun >/dev/null 2>&1 || {
  printf '%s\n' 'Dani-Free requires Bun 1.1 or newer.' >&2
  exit 1
}

(
  cd "$ROOT"
  bun install --frozen-lockfile
)
mkdir -p "$BIN_DIR" "$OMP_SKILLS_DIR" "$OPENCODE_SKILLS_DIR"

cat > "$BIN_DIR/dani-free" <<EOF
#!/bin/sh
exec bun "$ROOT/src/cli.ts" "\$@"
EOF
chmod 755 "$BIN_DIR/dani-free"

rm -rf "$OMP_SKILLS_DIR/dani-free" "$OPENCODE_SKILLS_DIR/dani-free"
cp -R "$ROOT/skills/dani-free" "$OMP_SKILLS_DIR/dani-free"
cp -R "$ROOT/skills/dani-free" "$OPENCODE_SKILLS_DIR/dani-free"

printf '%s\n' "Installed Dani-Free from $ROOT"
printf '%s\n' "Command: $BIN_DIR/dani-free"
printf '%s\n' 'Endpoint: http://127.0.0.1:4190/v1'
printf '%s\n' 'Next: dani-free start'
