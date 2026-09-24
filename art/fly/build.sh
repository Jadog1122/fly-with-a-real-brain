#!/bin/sh
# Build the game's fly from flybody's Drosophila, end to end:
#   fetch -> lod -> bake -> rig -> clips -> export -> optimise -> web/public/models/fly/
# Needs Blender 5.x and Node 22. Takes about two minutes, most of it the Cycles bake.
set -eu
cd "$(dirname "$0")/../.."
WORK=art/.cache
BLENDER=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
mkdir -p "$WORK"

# flybody's own Blender source, pinned to the commit it was last changed in
SRC_URL=https://raw.githubusercontent.com/TuragaLab/flybody/6c50cdc8adcf6b3688f33520f3cec83185455e23/flybody/fruitfly/assets/blender_model/drosophila.blend
SRC_SHA=88c13449572924557ee77e3da2a318643b8a987ac1c7a60b77ed164faa29bead
if [ ! -f "$WORK/drosophila.blend" ]; then
  curl -fsSL -o "$WORK/drosophila.blend" "$SRC_URL"
fi
echo "$SRC_SHA  $WORK/drosophila.blend" | shasum -a 256 -c -

for stage in lod bake rig clips export; do
  "$BLENDER" --background --python art/fly/build_fly.py -- "$stage" "$WORK" 2>&1 \
    | grep -E '^\[build_fly\]|Error|Traceback' || true
done
test -s "$WORK/drosophila_raw.glb"
(cd art && [ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null)
node art/fly/optimize.mjs "$WORK/drosophila_raw.glb" web/public/models/fly/drosophila.glb 2>&1 \
  | grep -vE 'ExperimentalWarning|trace-warnings|objc\['
