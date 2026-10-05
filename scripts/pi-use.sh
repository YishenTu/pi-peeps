#!/usr/bin/env bash
# Make your Pi load Peeps from this checkout (the last one run wins).
# Removes every other installed pi-peeps copy so two never load, then installs
# this checkout by path. Run /reload in open Pi sessions afterwards.
set -euo pipefail
target="$(cd "${1:-$(dirname "$0")/..}" && pwd -P)"
installed() { pi list | sed -n 's/^    //p'; }
installed | while IFS= read -r path; do
  [ -f "$path/package.json" ] || continue
  [ "$(node -p "require(process.argv[1]).name" "$path/package.json" 2>/dev/null)" = pi-peeps ] || continue
  # Compare listed paths, not resolved ones: a symlinked entry still loads a second copy.
  [ "$path" = "$target" ] && continue
  pi remove "$path"
done
installed | grep -qxF "$target" || pi install "$target"
echo "Pi loads Peeps from $target. Run /reload in open Pi sessions."
