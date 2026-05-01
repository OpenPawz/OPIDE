/**
 * vscode.d.ts → api-shim stubs generator
 *
 * Parses the canonical VS Code API declarations
 * (`@codingame/monaco-vscode-api/vscode-dts/vscode.d.ts`) and emits
 * JavaScript stubs for everything we don't already implement in
 * `src/api-shim.ts`. Goal: any extension can `require('vscode')` at
 * activation time and find every documented enum / class / namespace
 * / constant — no more "Cannot read properties of undefined (reading
 * 'X')" failures.
 *
 * Strategy
 *   1. Walk the `declare module 'vscode'` AST.
 *   2. For each top-level export:
 *      - enum  → real enum (extracted as JS object)
 *      - class → stub class with methods returning sensible defaults
 *      - namespace → stub object with sub-stubs
 *      - function → no-op returning undefined / Promise.resolve()
 *      - const  → string/number literal pulled from JSDoc or empty
 *   3. Read api-shim.ts to find what we ALREADY have.
 *   4. Emit only the missing stuff to api-shim-generated.ts.
 *   5. api-shim.ts spreads the generated module on top of its real
 *      implementations (real wins because spread order: real last).
 *
 * Run:
 *   node -r ts-node/register scripts/gen-api-stubs.ts
 *   (or compile + run)
 */

import * as ts from 'typescript'
import * as fs from 'fs'
import * as path from 'path'

// ─── Paths ───────────────────────────────────────────────────────────────
// __dirname is scripts/ when run via ts-node, scripts/dist/ when compiled.
// Walk up until we find node-extension-host/, then resolve from there.
function findRepoRoot(): string {
  let dir = __dirname
  while (dir !== '/' && dir !== '.') {
    if (path.basename(dir) === 'node-extension-host') return path.resolve(dir, '..')
    if (fs.existsSync(path.join(dir, 'node-extension-host'))) return dir
    dir = path.dirname(dir)
  }
  throw new Error('could not locate repo root from ' + __dirname)
}
const REPO = findRepoRoot()
const VSCODE_DTS = path.join(REPO, 'node_modules/@codingame/monaco-vscode-api/vscode-dts/vscode.d.ts')
const API_SHIM_SRC = path.join(REPO, 'node-extension-host/src/api-shim.ts')
const OUT = path.join(REPO, 'node-extension-host/src/api-shim-generated.ts')

// ─── Parse API shim to find existing implementations ─────────────────────
function findExisting(): Set<string> {
  const src = fs.readFileSync(API_SHIM_SRC, 'utf-8')
  const names = new Set<string>()

  // Top-level class declarations: `class Foo {`, `class Foo extends`
  for (const m of src.matchAll(/^class\s+(\w+)/gm)) names.add(m[1])
  // Top-level enum declarations
  for (const m of src.matchAll(/^enum\s+(\w+)/gm)) names.add(m[1])
  // Properties on the returned api object (best-effort: pick lines like
  // `    Foo,` or `    Foo: ...,` at indent 4 inside the api object)
  for (const m of src.matchAll(/^    (\w+)[,:]/gm)) names.add(m[1])
  // Aliased exports: `Disposable: VsCodeDisposable,`
  for (const m of src.matchAll(/^\s+(\w+):\s*\w/gm)) names.add(m[1])

  return names
}

// ─── Walk vscode.d.ts ────────────────────────────────────────────────────
interface EnumMember { name: string; value: string | number }
interface EnumDef { name: string; members: EnumMember[] }
interface ClassDef { name: string; ctorParams: number }
interface FuncDef { name: string; returnsPromise: boolean }
interface NamespaceDef {
  name: string
  enums: EnumDef[]
  classes: ClassDef[]
  functions: FuncDef[]
  constants: string[]
}

const program = ts.createProgram([VSCODE_DTS], { allowJs: false })
const sourceFile = program.getSourceFile(VSCODE_DTS)
if (!sourceFile) {
  process.stderr.write(`Could not load ${VSCODE_DTS}\n`)
  process.exit(1)
}

const topEnums: EnumDef[] = []
const topClasses: ClassDef[] = []
const topFunctions: FuncDef[] = []
const topConstants: string[] = []
const namespaces: NamespaceDef[] = []

function extractEnum(node: ts.EnumDeclaration): EnumDef {
  const members: EnumMember[] = []
  let next = 0
  for (const m of node.members) {
    let name = ''
    if (ts.isIdentifier(m.name)) name = m.name.text
    else if (ts.isStringLiteral(m.name)) name = m.name.text
    if (!name) continue
    let value: string | number = next++
    if (m.initializer) {
      if (ts.isNumericLiteral(m.initializer)) {
        value = Number(m.initializer.text)
        next = value + 1
      } else if (ts.isStringLiteral(m.initializer)) {
        value = m.initializer.text
      } else if (
        ts.isPrefixUnaryExpression(m.initializer) &&
        m.initializer.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(m.initializer.operand)
      ) {
        value = -Number(m.initializer.operand.text)
        next = value + 1
      }
    }
    members.push({ name, value })
  }
  return { name: node.name.text, members }
}

function returnsPromise(node: ts.SignatureDeclaration): boolean {
  if (!node.type) return false
  const text = node.type.getText(sourceFile)
  return /^(Promise|Thenable)\b/.test(text.trim())
}

function visitTopLevel(node: ts.Node): void {
  // Module body of `declare module 'vscode'` contains the real exports
  if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
    for (const stmt of node.body.statements) visitMember(stmt)
  }
}

function visitMember(node: ts.Node, parentNs?: NamespaceDef): void {
  const target = parentNs
  if (ts.isEnumDeclaration(node)) {
    const def = extractEnum(node)
    if (target) target.enums.push(def)
    else topEnums.push(def)
    return
  }
  if (ts.isClassDeclaration(node) && node.name) {
    let ctorParams = 0
    for (const m of node.members) {
      if (ts.isConstructorDeclaration(m)) {
        ctorParams = m.parameters.length
        break
      }
    }
    const def: ClassDef = { name: node.name.text, ctorParams }
    if (target) target.classes.push(def)
    else topClasses.push(def)
    return
  }
  if (ts.isFunctionDeclaration(node) && node.name) {
    const def: FuncDef = {
      name: node.name.text,
      returnsPromise: returnsPromise(node),
    }
    if (target) target.functions.push(def)
    else topFunctions.push(def)
    return
  }
  if (ts.isVariableStatement(node)) {
    for (const d of node.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) {
        if (target) target.constants.push(d.name.text)
        else topConstants.push(d.name.text)
      }
    }
    return
  }
  if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
    // Nested namespace (e.g. `namespace window { ... }` inside vscode)
    const ns: NamespaceDef = {
      name: node.name.getText(sourceFile),
      enums: [],
      classes: [],
      functions: [],
      constants: [],
    }
    namespaces.push(ns)
    for (const stmt of node.body.statements) visitMember(stmt, ns)
  }
}

ts.forEachChild(sourceFile, visitTopLevel)

// ─── Emit ────────────────────────────────────────────────────────────────
const existing = findExisting()
const has = (n: string) => existing.has(n)

let out = ''
out += '// AUTO-GENERATED by scripts/gen-api-stubs.ts — DO NOT EDIT BY HAND.\n'
out += '// Source: @codingame/monaco-vscode-api/vscode-dts/vscode.d.ts\n'
out += '//\n'
out += '// This file emits stubs for every documented vscode API surface\n'
out += '// that api-shim.ts does NOT already implement. Real implementations\n'
out += '// in api-shim.ts win because we spread `vscodeStubs` BEFORE the\n'
out += '// real api object — last-write wins.\n'
out += '//\n'
out += '// Re-generate after vscode.d.ts updates:\n'
out += '//   npx tsc scripts/gen-api-stubs.ts --target es2020 --module commonjs --outDir scripts/dist && node scripts/dist/gen-api-stubs.js\n'
out += '/* eslint-disable @typescript-eslint/no-explicit-any */\n\n'
out += '/** No-op marker — extensions calling auto-stubbed methods get this back\n'
out += ' * instead of crashing. We log on first call to surface what we still\n'
out += ' * need to implement for real. */\n'
out += 'const _autoStubReported = new Set<string>();\n'
out += 'function autoStub(name: string): any {\n'
out += '  return (...args: any[]) => {\n'
out += '    if (!_autoStubReported.has(name)) {\n'
out += '      _autoStubReported.add(name);\n'
out += '      try { process.stderr.write(`[api-shim] auto-stub called: ${name} (${args.length} arg${args.length === 1 ? \'\' : \'s\'})\\n`); } catch {}\n'
out += '    }\n'
out += '    return undefined;\n'
out += '  };\n'
out += '}\n'
out += 'function autoStubAsync(name: string): any {\n'
out += '  const sync = autoStub(name);\n'
out += '  return (...args: any[]) => Promise.resolve(sync(...args));\n'
out += '}\n\n'

// ── Top-level enums ────────────────────────────────────────────────────
for (const e of topEnums) {
  if (has(e.name)) continue
  out += `export const ${e.name} = Object.freeze({\n`
  for (const m of e.members) {
    if (typeof m.value === 'string') out += `  ${m.name}: ${JSON.stringify(m.value)},\n`
    else out += `  ${m.name}: ${m.value},\n`
  }
  out += '});\n\n'
}

// ── Top-level classes ──────────────────────────────────────────────────
for (const c of topClasses) {
  if (has(c.name)) continue
  const params = Array.from({ length: c.ctorParams }, (_, i) => `arg${i}: any`).join(', ')
  out += `export class ${c.name} {\n`
  out += `  constructor(${params}) {\n`
  for (let i = 0; i < c.ctorParams; i++) {
    out += `    (this as any)[\`_arg${i}\`] = arg${i};\n`
  }
  out += '  }\n'
  out += '}\n\n'
}

// ── Namespaces (window, workspace, commands, etc.) ─────────────────────
const namespacesObj: string[] = []
for (const ns of namespaces) {
  // Build a mostly-stubbed namespace. Spec says: real api-shim's
  // namespace object will spread on top, replacing stubs we filled in.
  // Dedupe: vscode.d.ts has many function overloads; we only want one
  // entry per name. Same for events repeated in multiple `interface`
  // declarations within the same namespace.
  const emitted = new Set<string>()
  out += `export const _ns_${ns.name} = {\n`
  for (const e of ns.enums) {
    if (emitted.has(e.name)) continue
    emitted.add(e.name)
    out += `  ${e.name}: Object.freeze({ `
    out += e.members.map((m) => `${m.name}: ${typeof m.value === 'string' ? JSON.stringify(m.value) : m.value}`).join(', ')
    out += ' }),\n'
  }
  for (const c of ns.classes) {
    if (emitted.has(c.name)) continue
    emitted.add(c.name)
    const params = Array.from({ length: c.ctorParams }, (_, i) => `a${i}: any`).join(', ')
    out += `  ${c.name}: class ${c.name} { constructor(${params}) { ${
      Array.from({ length: c.ctorParams }, (_, i) => `(this as any)._a${i} = a${i};`).join(' ')
    } } },\n`
  }
  for (const f of ns.functions) {
    if (emitted.has(f.name)) continue
    emitted.add(f.name)
    out += `  ${f.name}: ${f.returnsPromise ? 'autoStubAsync' : 'autoStub'}(${JSON.stringify(`vscode.${ns.name}.${f.name}`)}),\n`
  }
  for (const c of ns.constants) {
    if (emitted.has(c)) continue
    emitted.add(c)
    out += `  ${c}: undefined as any,\n`
  }
  out += '};\n\n'
  namespacesObj.push(ns.name)
}

// Roll-up — emits a single object the api-shim can spread/merge.
out += '/** Roll-up of every auto-stubbed namespace.  api-shim.ts merges\n'
out += ' * its REAL namespace objects on top so real implementations win. */\n'
out += 'export const _autoStubNamespaces = {\n'
for (const n of namespacesObj) out += `  ${n}: _ns_${n},\n`
out += '};\n'

fs.writeFileSync(OUT, out, 'utf-8')

// Print a tiny report.
const totalEnums = topEnums.length + namespaces.reduce((a, n) => a + n.enums.length, 0)
const totalClasses = topClasses.length + namespaces.reduce((a, n) => a + n.classes.length, 0)
const totalFns = namespaces.reduce((a, n) => a + n.functions.length, 0)
const newEnums = topEnums.filter((e) => !has(e.name)).length
const newClasses = topClasses.filter((c) => !has(c.name)).length
process.stdout.write(
  `[gen-api-stubs] vscode.d.ts: ${totalEnums} enums, ${totalClasses} classes, ${totalFns} functions across ${namespaces.length} namespaces\n` +
  `[gen-api-stubs] new in this run: ${newEnums} top-level enums, ${newClasses} top-level classes\n` +
  `[gen-api-stubs] wrote ${OUT}\n`,
)
