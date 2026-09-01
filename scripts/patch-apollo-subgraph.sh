#!/bin/sh
# Workaround for a broken @apollo/subgraph in the switchboard image.
#
# @apollo/subgraph 2.15.0 ships this in dist/resolvers.js:
#
#   function modulesFromSDL(modulesOrSDL) {
#     if (Array.isArray(modulesOrSDL)) {
#       return modulesOrSDL.map((m) => isDocumentNode(m) ? { typeDefs: m } : m);
#     }
#     return [{ typeDefs: modulesOrSDL }];   // <-- missing the isDocumentNode guard
#   }
#
# reactor-api calls the non-array form, buildSubgraphSchema({ typeDefs }), so the
# module object gets double-wrapped into { typeDefs: { typeDefs: doc } }.
# concatAST then spreads `.definitions` on a plain object and throws
# "doc.definitions is not iterable". reactor-api's filterComposableSubgraphs
# catches that per subgraph and EXCLUDES it -- and since the probe fails for
# every subgraph, all of them are dropped. The supergraph ends up with no query
# root, Apollo never mounts /graphql, and bootstrap.py dies on HTTP 404 while
# /health still answers and the container looks healthy.
#
# reactor-api ^2.13.2 let subgraph float from 2.14.x to 2.15.0, which is why this
# appeared with no code change on the Powerhouse side.
#
# This adds the missing guard, which fixes every caller at once. Verified: the
# single-object form works after patching, and the array / bare-DocumentNode
# forms are unaffected.
#
# REMOVE THIS (script + the entrypoint override and mount in docker-compose.yml)
# once the image ships the upstream fixes -- "fix(reactor-api): pass modules
# array to buildSubgraphSchema" and the exact apollo pins -- i.e. any tag newer
# than v6.2.2-dev.68. The patch is idempotent and no-ops when the pattern is
# gone, so it is safe to leave in place in the meantime.
set -eu

TAG="[patch-apollo-subgraph]"
BROKEN="return [{ typeDefs: modulesOrSDL }];"
FIXED="return [isDocumentNode(modulesOrSDL) ? { typeDefs: modulesOrSDL } : modulesOrSDL];"

found=0
for f in /app/node_modules/.pnpm/@apollo+subgraph@*/node_modules/@apollo/subgraph/dist/resolvers.js; do
  [ -f "$f" ] || continue
  found=1
  BROKEN="$BROKEN" FIXED="$FIXED" TAG="$TAG" node -e '
    const fs = require("fs");
    const f = process.argv[1];
    const { BROKEN, FIXED, TAG } = process.env;
    const before = fs.readFileSync(f, "utf8");
    if (before.includes(FIXED)) { console.log(TAG, "already patched:", f); process.exit(0); }
    if (!before.includes(BROKEN)) { console.log(TAG, "pattern absent (upstream fixed?) - skipping:", f); process.exit(0); }
    fs.writeFileSync(f, before.split(BROKEN).join(FIXED));
    if (!fs.readFileSync(f, "utf8").includes(FIXED)) { console.error(TAG, "VERIFY FAILED:", f); process.exit(1); }
    console.log(TAG, "patched:", f);
  ' "$f" || echo "$TAG WARNING: could not patch $f -- starting anyway"
done
[ "$found" = 1 ] || echo "$TAG no @apollo/subgraph found -- nothing to do"

exec /app/entrypoint.sh "$@"
