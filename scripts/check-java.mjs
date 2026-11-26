/**
 * NEPHRO-SPECTRA — Java source gate.
 *
 * There is no JDK in every environment that touches this repo, so the native
 * sources are parsed with a real Java grammar (java-parser), and three things
 * the grammar alone cannot catch are asserted:
 *
 *   · the declared package matches the directory (Gradle compiles by path)
 *   · the public type name matches the file name (javac requires it)
 *   · the plugins are registered by MainActivity and the manifest is patched
 *
 * Run with `npm run test:java`.
 */
import { parse } from 'java-parser'
import fs from 'node:fs'
import path from 'node:path'

const ROOTS = ['android/app/src/main/java', 'android/app/src/test/java']

function collect(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.java'))
    .map((f) => path.join(dir, f))
}

const files = ROOTS.flatMap(collect)
let failures = 0

if (files.length === 0) {
  console.error('::error::no Java sources found — is the android/ project present?')
  process.exit(1)
}

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  try {
    parse(src)
    const declared = src.match(/^package\s+([\w.]+)\s*;/m)?.[1]
    const expected = path.dirname(file).split(/src\/(?:main|test)\/java\//)[1].replace(/\//g, '.')
    if (declared !== expected) throw new Error(`package ${declared} does not match directory ${expected}`)

    const typeName = src.match(/(?:^|\n)\s*(?:public\s+)?(?:final\s+)?(?:abstract\s+)?(?:class|interface|enum|record)\s+(\w+)/)?.[1]
    if (typeName !== path.basename(file, '.java')) {
      throw new Error(`type "${typeName}" does not match file name "${path.basename(file, '.java')}"`)
    }
    console.log(`  ok   ${file}`)
  } catch (err) {
    failures++
    console.error(`  FAIL ${file}\n       ${String(err.message).split('\n')[0]}`)
  }
}

// ---- host wiring ---------------------------------------------------------
const main = 'android/app/src/main/java/com/nephrospectra/clinical/MainActivity.java'
const manifest = 'android/app/src/main/AndroidManifest.xml'

function assert(condition, message) {
  if (condition) console.log(`  ok   ${message}`)
  else {
    failures++
    console.error(`  FAIL ${message}`)
  }
}

assert(fs.existsSync(main), 'MainActivity exists')
if (fs.existsSync(main)) {
  const m = fs.readFileSync(main, 'utf8')
  assert(/registerPlugin\(NephroAcousticFlowPlugin\.class\)/.test(m), 'MainActivity registers NephroAcousticFlow')
  assert(/registerPlugin\(NephroDipstickCameraPlugin\.class\)/.test(m), 'MainActivity registers NephroDipstickCamera')
}
assert(fs.existsSync(manifest), 'AndroidManifest exists')
if (fs.existsSync(manifest)) {
  const mf = fs.readFileSync(manifest, 'utf8')
  for (const perm of ['RECORD_AUDIO', 'CAMERA']) {
    assert(mf.includes(`android.permission.${perm}`), `manifest grants ${perm}`)
  }
  assert(mf.includes('networkSecurityConfig'), 'manifest is TLS-only via networkSecurityConfig')
}
assert(fs.existsSync('android/app/src/main/res/xml/network_security_config.xml'), 'network security config present')

console.log(
  failures === 0
    ? `\n${files.length} Java sources parse; host wiring intact`
    : `\n${failures} check(s) failed`
)
process.exit(failures === 0 ? 0 : 1)
