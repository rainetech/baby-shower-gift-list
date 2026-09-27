#!/bin/sh
# Assemble the single self-contained index.html: src/00-head.html, then every src/*.js in file-name order,
# then src/99-tail.html; syntax-check the script.
# Copies that must stay byte-identical to their source (the build refuses otherwise):
#   src/05-canon.js = the shared CANON (../../canon.js; never edit CANON here)
#   src/21a-songs.js, 21b-solver.js, 21c-demo-data.js, 22-songbook.js = the song solver's files (../solver/)
cd "$(dirname "$0")"
check_copy() {
  if [ -f "$1" ] && ! cmp -s "$1" "$2"; then echo "$2 differs from $1: copy it again (edit the original)" >&2; exit 1; fi
}
check_copy ../../canon.js src/05-canon.js
check_copy ../solver/songs.js src/21a-songs.js
check_copy ../solver/solver.js src/21b-solver.js
check_copy ../solver/demo-data.js src/21c-demo-data.js
check_copy ../solver/songbook-plugin.js src/22-songbook.js
cat src/00-head.html $(ls src/*.js | LC_ALL=C sort) src/99-tail.html > index.html
sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > .check.js
node --check .check.js && echo "syntax ok" && wc -c index.html
