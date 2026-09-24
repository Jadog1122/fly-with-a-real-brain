#!/bin/sh
# Build the game's scenery, end to end:
#   textures -> refine (Blender) -> optimise -> web/public/models/nature/
# From Quaternius's Stylized Nature MegaKit (CC0), whose originals are kept untouched in
# art/src/nature, plus four fallen leaves made here. Needs Python 3 with numpy, scipy and
# Pillow, Blender 5.x and Node 22. Takes a couple of minutes.
set -eu
cd "$(dirname "$0")/../.."
WORK=art/.cache
BLENDER=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
rm -rf "$WORK/kit_tex" "$WORK/kit_out" "$WORK/kit_ship"

python3 art/kit/textures.py "$WORK/kit_tex" 2>&1 | grep -vE 'Warning|Image.fromarray' || true
test -s "$WORK/kit_tex/Litter.json"
"$BLENDER" --background --python art/kit/refine_kit.py -- art/src/nature "$WORK/kit_tex" "$WORK/kit_out" 2>&1 \
  | grep -E '^\[refine_kit\]|Error|Traceback' || true
(cd art && [ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null)
node art/kit/optimize.mjs "$WORK/kit_out" "$WORK/kit_ship" 2>&1 \
  | grep -vE 'ExperimentalWarning|trace-warnings|objc\['

# the folder ships exactly what optimise wrote, and nothing it did not
rm -f web/public/models/nature/*.gltf web/public/models/nature/*.bin web/public/models/nature/*.webp
cp "$WORK/kit_ship"/*.gltf "$WORK/kit_ship"/*.bin "$WORK/kit_ship"/*.webp web/public/models/nature/
