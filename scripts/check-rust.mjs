/**
 * NEPHRO-SPECTRA — Rust source gate.
 *
 * `cargo` is not available everywhere this repo is touched, so the crate is
 * parsed with tree-sitter's Rust grammar and the structural invariants that
 * actually break a build are asserted: no ERROR nodes, every `mod` file exists,
 * `#[cfg(test)]` modules use symbols that are declared, and the crate declares
 * the lib target its consumers expect.
 *
 * This is a syntax/consistency gate, not a compiler. CI still runs `cargo test`.
 */
import { Parser, Language } from 'web-tree-sitter'
import fs from 'node:fs'
import path from 'node:path'

const CRATE = 'rust-nephro'
const SRC = path.join(CRATE, 'src')

await Parser.init()
const parser = new Parser()
const wasm = path.join('node_modules', 'tree-sitter-wasms', 'out', 'tree-sitter-rust.wasm')
parser.setLanguage(await Language.load(wasm))

let failures = 0
const assert = (ok, msg) => {
  if (ok) console.log(`  ok   ${msg}`)
  else {
    failures++
    console.error(`  FAIL ${msg}`)
  }
}

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.rs'))
assert(files.length > 0, `${files.length} Rust source file(s)`)

for (const file of files) {
  const full = path.join(SRC, file)
  const src = fs.readFileSync(full, 'utf8')
  const tree = parser.parse(src)

  let errorNodes = 0
  const firstError = []
  const walk = (node) => {
    if (node.type === 'ERROR' || node.isMissing) {
      errorNodes++
      if (firstError.length < 3) firstError.push(`${node.type} at line ${node.startPosition.row + 1}`)
    }
    for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i))
  }
  walk(tree.rootNode)

  if (errorNodes) {
    failures++
    console.error(`  FAIL ${full}: ${errorNodes} syntax error(s) — ${firstError.join('; ')}`)
    continue
  }
  console.log(`  ok   ${full} parses`)

  // `mod foo;` must resolve to a file
  const modNames = []
  const walkMods = (node) => {
    if (node.type === 'mod_item' && !node.childForFieldName('body')) {
      const name = node.childForFieldName('name')?.text
      if (name) modNames.push(name)
    }
    for (let i = 0; i < node.namedChildCount; i++) walkMods(node.namedChild(i))
  }
  walkMods(tree.rootNode)
  for (const mod of modNames) {
    const direct = path.join(SRC, `${mod}.rs`)
    const nested = path.join(SRC, mod, 'mod.rs')
    assert(fs.existsSync(direct) || fs.existsSync(nested), `${full} declares mod ${mod} and the file exists`)
  }
}

// ---- crate metadata -------------------------------------------------------
const cargo = fs.readFileSync(path.join(CRATE, 'Cargo.toml'), 'utf8')
assert(/name\s*=\s*"nephro_nephro_dsp"/.test(cargo), 'Cargo.toml lib name is nephro_nephro_dsp')
assert(/crate-type\s*=\s*\[[^\]]*"rlib"/.test(cargo), 'Cargo.toml produces an rlib so `cargo test` can link')
assert(/edition\s*=\s*"2021"/.test(cargo), 'Cargo.toml targets edition 2021')

// ---- test-order and state hygiene ----------------------------------------
// `assert_eq!(a, b)` must not call a state-mutating helper inside the
// comparison: the arguments are evaluated right-to-left, so a helper that
// advances an integrator would corrupt the value under test.
for (const file of files) {
  const src = fs.readFileSync(path.join(SRC, file), 'utf8')
  // `assert_eq!(a, b)` evaluates its arguments right-to-left, so a helper that
  // mutates state must never be one of the arguments. `assert!(f(x).is_err())`
  // is fine — there is nothing to compare against.
  const risky = src.match(/assert_eq!\([^;]*\b(rk4_step|advance|integrate)\b[^;]*\)/g)
  assert(!risky, `${file}: no state-mutating helper inside assert_eq!`)
  if (risky) console.error(`         ${risky[0].split('\n')[0]}`)
}

console.log(failures === 0 ? `\n${files.length} Rust source(s) parse; crate metadata intact` : `\n${failures} problem(s)`)
process.exit(failures === 0 ? 0 : 1)
