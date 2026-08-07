#!/usr/bin/env bun

import packageJson from "../package.json"

/** The CLI package version, sourced from canonical package metadata. */
export const VERSION = packageJson.version

const HELP = `minimal-agent-cli scaffold

Usage: minimal-agent [options]

Options:
  -h, --help     Show this help
  -V, --version  Show the version
`

/** A text destination used by the CLI entry point. */
export interface TextWriter {
  write(text: string): unknown
}

/** The process services used by the CLI entry point. */
export interface CliHost {
  stdout: TextWriter
  stderr: TextWriter
}

const processHost: CliHost = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Run the CLI scaffold and return its intended process exit code. */
export function main(
  argv: readonly string[] = process.argv.slice(2),
  host: CliHost = processHost,
): number {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    host.stdout.write(HELP)
    return 0
  }

  if (argv[0] === "--version" || argv[0] === "-V") {
    host.stdout.write(`minimal-agent-cli ${VERSION}\n`)
    return 0
  }

  host.stderr.write(
    `minimal-agent-cli: unknown argument '${argv[0]}'\nTry 'minimal-agent --help'.\n`,
  )
  return 2
}

if (import.meta.main) process.exitCode = main()
