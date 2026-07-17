// `skia-canvas`'s own `install` script (`node lib/prebuild.mjs download`) fetches
// a native binary matching *this* machine on every `npm install`. If it's still
// present when `ncc build` runs, ncc bundles that one platform's binary into
// `dist/`, which then fails on any other OS/arch the workflow runs on.
//
// Deleting it here lets ncc fall back to a plain runtime `require("../skia.node")`
// for just that one file, while still bundling the rest of `skia-canvas` (and
// its JS dependencies) directly into the output. The action fetches the binary
// matching the actual runner at runtime instead (see `ensureSkiaCanvasBinary`
// in `src/statCollector.ts`). `postpackage` restores it afterwards for local
// development.
const fs = require('fs')
const path = require('path')

const binaryPath = path.join(
  __dirname,
  '..',
  'node_modules',
  'skia-canvas',
  'lib',
  'skia.node'
)
fs.rmSync(binaryPath, { force: true })
