// Vendors `skia-canvas` (and its dependency tree) into `dist/node_modules` so
// the ncc-bundled `dist/main`, `dist/post`, and `dist/sc` outputs (which mark
// `skia-canvas` as an ncc `--external`, since its native addon can't be baked
// into a bundle built once but run on any OS/arch) can resolve it at runtime.
//
// The platform-specific `lib/skia.node` binary is deliberately left out: it is
// fetched on demand at Action runtime (via `skia-canvas`'s own
// `lib/prebuild.mjs` installer script) so it always matches the OS/arch that
// is actually running the workflow, rather than whichever machine built this
// package.
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const projectRoot = path.join(__dirname, '..')
const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
)
const skiaCanvasVersion = packageJson.dependencies['skia-canvas']

const vendorDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'workflow-telemetry-action-vendor-')
)

try {
  execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    [
      'install',
      `skia-canvas@${skiaCanvasVersion}`,
      '--omit=dev',
      '--no-save',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      '--loglevel=error'
    ],
    { cwd: vendorDir, stdio: 'inherit' }
  )

  const distNodeModules = path.join(projectRoot, 'dist', 'node_modules')
  fs.rmSync(distNodeModules, { recursive: true, force: true })
  fs.mkdirSync(distNodeModules, { recursive: true })
  fs.cpSync(path.join(vendorDir, 'node_modules'), distNodeModules, {
    recursive: true
  })

  const nativeBinary = path.join(
    distNodeModules,
    'skia-canvas',
    'lib',
    'skia.node'
  )
  fs.rmSync(nativeBinary, { force: true })

  console.log(`Vendored skia-canvas@${skiaCanvasVersion} into ${distNodeModules}`)
} finally {
  fs.rmSync(vendorDir, { recursive: true, force: true })
}
