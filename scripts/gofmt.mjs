/**
 * NEPHRO-SPECTRA — gofmt gate.
 *
 * There is no Go toolchain in every environment that touches this repo, so the
 * formatter is the real gofmt compiled to WebAssembly. `--check` exits non-zero
 * if any file is not gofmt-clean; without it, files are rewritten in place.
 *
 *   node scripts/gofmt.mjs          # format
 *   node scripts/gofmt.mjs --check  # verify (used by CI and `npm test`)
 */
import { format } from '@wasm-fmt/gofmt'
import fs from 'node:fs'
import path from 'node:path'

const DIRS = ['api', 'go_nephro']
const check = process.argv.includes('--check')

const files = DIRS.flatMap((dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.go')).map((f) => path.join(dir, f)) : []
)

if (files.length === 0) {
  console.error('::error::no Go sources found')
  process.exit(1)
}

let dirty = 0
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  let out
  try {
    out = format(src, file)
  } catch (err) {
    console.error(`::error file=${file}::does not parse: ${String(err.message).split('\n')[0]}`)
    dirty++
    continue
  }
  if (out === src) {
    console.log(`  ok   ${file}`)
    continue
  }
  dirty++
  if (check) {
    console.error(`::error file=${file}::not gofmt-clean — run \`npm run fmt:go\``)
  } else {
    fs.writeFileSync(file, out)
    console.log(`  fmt  ${file}`)
  }
}

if (check && dirty > 0) {
  console.error(`\n${dirty} of ${files.length} Go source(s) are not gofmt-clean`)
  process.exit(1)
}
console.log(`\n${files.length} Go source(s) ${check ? 'gofmt-clean' : 'formatted'}`)
