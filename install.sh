#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Error: Node.js 22.15 or newer is required.' >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_dir/scripts/install.mjs" "$@"
