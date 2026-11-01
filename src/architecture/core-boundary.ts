#!/usr/bin/env node

import { ChildProcess } from "node:child_process"
import { readdir } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNamedExports,
  isNamedImports,
  isNamespaceImport,
  isObjectBindingPattern,
  isStringLiteralLikeNode,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast"
import { API, type Project } from "typescript/unstable/sync"

import { LEGACY_CORE_TRANSPORT_CONTRACTS } from "./core-public-contract.ts"

export interface CoreBoundaryViolation {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly rule: "computed-loader" | "core-source-import" | "legacy-transport-contract"
  readonly detail: string
}

const LEGACY_CONTRACTS = new Set<string>(LEGACY_CORE_TRANSPORT_CONTRACTS)

function isCorePackagePath(specifier: string): boolean {
  return /^(?:@minimal-agent\/core|minimal-agent-core)(?:\/|$)/u.test(specifier)
}

function isForbiddenCoreSource(specifier: string): boolean {
  let path = specifier
  if (specifier.startsWith("file:")) {
    try {
      path = fileURLToPath(specifier)
    } catch {
      return false
    }
  }
  const normalized = path.replaceAll("\\", "/")
  return (
    /(?:^|\/)minimal-agent-core\/src(?:\/|$)/u.test(normalized) ||
    /^(?:@minimal-agent\/core|minimal-agent-core)\/src(?:\/|$)/u.test(normalized)
  )
}

function exposesCoreNamespace(node: Node): boolean {
  if (isImportEqualsDeclaration(node)) return true
  if (isImportDeclaration(node)) {
    const clause = node.importClause
    return Boolean(
      clause?.name || (clause?.namedBindings && isNamespaceImport(clause.namedBindings)),
    )
  }
  return isExportDeclaration(node) && (!node.exportClause || !isNamedExports(node.exportClause))
}

function importedNames(node: Node): readonly string[] {
  if (isImportDeclaration(node)) {
    const clause = node.importClause
    if (!clause?.namedBindings || !isNamedImports(clause.namedBindings)) return []
    return clause.namedBindings.elements.map(
      (element) => element.propertyName?.text ?? element.name.text,
    )
  }
  if (isExportDeclaration(node) && node.exportClause && isNamedExports(node.exportClause)) {
    return node.exportClause.elements.map(
      (element) => element.propertyName?.text ?? element.name.text,
    )
  }
  return []
}

function loaderArgument(node: Node): Node | undefined {
  if (isImportDeclaration(node) || isExportDeclaration(node)) return node.moduleSpecifier
  if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression
  }
  if (
    isCallExpression(node) &&
    (node.expression.kind === SyntaxKind.ImportKeyword ||
      (isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    return node.arguments[0]
  }
  return undefined
}

function requiredNames(node: Node): readonly string[] {
  if (!isCallExpression(node)) return []
  let declaration: Node = node.parent
  if (declaration.kind === SyntaxKind.AwaitExpression) declaration = declaration.parent
  if (!isVariableDeclaration(declaration) || !isObjectBindingPattern(declaration.name)) return []
  return declaration.name.elements.map((element) => {
    const property = element.propertyName
    return property && isIdentifier(property) ? property.text : (element.name?.getText() ?? "")
  })
}

function inspectSourceFile(sourceFile: SourceFile): CoreBoundaryViolation[] {
  const violations: CoreBoundaryViolation[] = []

  function report(node: Node, rule: CoreBoundaryViolation["rule"], detail: string): void {
    const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    violations.push({
      file: sourceFile.fileName,
      line: point.line + 1,
      column: point.character + 1,
      rule,
      detail,
    })
  }

  function visit(node: Node): void {
    const argument = loaderArgument(node)
    if (argument) {
      if (!isStringLiteralLikeNode(argument)) {
        if (isCallExpression(node)) {
          report(node, "computed-loader", "import() and require() must use a string literal")
        }
      } else {
        const specifier = argument.text
        if (isForbiddenCoreSource(specifier)) {
          report(node, "core-source-import", `forbidden core source path: ${specifier}`)
        }
        if (isCorePackagePath(specifier)) {
          if (exposesCoreNamespace(node)) {
            report(
              node,
              "legacy-transport-contract",
              "default and namespace access to core packages is forbidden",
            )
          }
          for (const name of [...importedNames(node), ...requiredNames(node)]) {
            if (LEGACY_CONTRACTS.has(name)) {
              report(node, "legacy-transport-contract", `forbidden legacy contract: ${name}`)
            }
          }
        }
      }
    }
    node.forEachChild(visit)
  }

  visit(sourceFile)
  return violations
}

const NON_PRODUCTION_DIRECTORY_NAMES = new Set([
  "__fixtures__",
  "build",
  "coverage",
  "dist",
  "fixture",
  "fixtures",
  "generated",
  "node_modules",
  "vendor",
])

function isProductionSourceDirectory(name: string): boolean {
  return !name.startsWith(".") && !NON_PRODUCTION_DIRECTORY_NAMES.has(name)
}

/** Enumerate production TypeScript files under a source root. */
export async function productionTypeScriptFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (isProductionSourceDirectory(entry.name)) await walk(path)
        continue
      }
      if (entry.name.endsWith(".ts") && !/\.(?:test|spec)\.ts$/u.test(entry.name)) {
        files.push(path)
      }
    }
  }
  await walk(root)
  return files.sort()
}

/**
 * CLI files (relative to the scanned root) that may import by a computed
 * path. They load plugin code, which is not core, so the computed-loader
 * rule does not apply to them. Every other rule still applies. Keep the
 * list exact: one file per loader.
 */
export const PLUGIN_CODE_LOADER_FILES: readonly string[] = ["plugins-ui/plugin-module.ts"]

/** Check production sources for forbidden core-boundary dependencies. */
export async function checkCoreBoundary(
  project: Project,
  root: string,
): Promise<CoreBoundaryViolation[]> {
  const files = new Set((await productionTypeScriptFiles(root)).map((file) => resolve(file)))
  const violations: CoreBoundaryViolation[] = []
  for (const file of files) {
    const sourceFile = project.program.getSourceFile(file)
    if (!sourceFile) throw new Error(`TypeScript project does not include production file: ${file}`)
    const exempt = PLUGIN_CODE_LOADER_FILES.includes(relative(root, file).replaceAll("\\", "/"))
    for (const v of inspectSourceFile(sourceFile)) {
      if (exempt && v.rule === "computed-loader") continue
      violations.push(v)
    }
  }
  return violations
}

/** The longest time to wait for the TypeScript server to exit on its own. */
const SERVER_EXIT_TIMEOUT_MS = 5000

/** Read `key` of `value`, or `undefined` when `value` is not an object. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
}

/**
 * Close the TypeScript API with no stderr output.
 *
 * `api.close()` closes the server's stdin and sends SIGTERM at the same
 * time. Sometimes (more often under machine load) the server gets the
 * signal while it shuts down after the end of stdin. It then writes
 * "context canceled" to the stderr that this process shares with it. The
 * boundary test requires an empty stderr, so that line fails it.
 *
 * This function first closes stdin and waits for the server to exit with
 * code 0. Then `api.close()` sends a signal to no process. The server
 * process is internal to TypeScript 7.0.2 (exact pin). If its shape
 * changes, this function only calls `api.close()`.
 */
async function closeApi(api: API): Promise<void> {
  const child = field(field(field(api, "client"), "channel"), "child")
  if (child instanceof ChildProcess && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve())
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SERVER_EXIT_TIMEOUT_MS)
    })
    child.stdin?.end()
    await Promise.race([exited, timeout])
    clearTimeout(timer)
  }
  api.close()
}

async function main(argv: readonly string[]): Promise<number> {
  const rootArg = argv[argv.indexOf("--root") + 1] ?? "src"
  const configArg = argv[argv.indexOf("--config") + 1] ?? "tsconfig.json"
  const root = resolve(rootArg)
  const config = resolve(configArg)
  const api = new API()
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] })
    try {
      const project = snapshot.getProject(config)
      if (!project) throw new Error(`TypeScript could not open project: ${config}`)
      const violations = await checkCoreBoundary(project, root)
      for (const violation of violations) {
        const file = isAbsolute(violation.file)
          ? relative(process.cwd(), violation.file)
          : violation.file
        console.error(
          `${file}:${violation.line}:${violation.column} ${violation.rule}: ${violation.detail}`,
        )
      }
      return violations.length === 0 ? 0 : 1
    } finally {
      snapshot.dispose()
    }
  } finally {
    await closeApi(api)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2))
}
