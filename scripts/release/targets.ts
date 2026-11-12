/**
 * The release target table: every macOS and Linux target Bun 1.4.4 can
 * compile for. `scripts/compile.ts` reads it for `--all` and `--target`
 * validation, and `.github/workflows/release.yml` builds its matrix from it
 * (`bun run scripts/release/targets.ts --matrix`).
 *
 * Asset names follow `minimal-agent-<version>-<id>.tar.gz`, so `id` is
 * `<os>-<arch>[-baseline|-musl]`. Windows is out of scope.
 *
 * @module scripts/release/targets
 */

/** One compile target of a release. */
export interface ReleaseTarget {
  /** Asset id: `<os>-<arch>[-baseline|-musl]`. */
  readonly id: string
  /** The Bun compile target string (`Bun.Build.CompileTarget`). */
  readonly bun: string
  readonly os: "darwin" | "linux"
  readonly arch: "x64" | "arm64"
  /** Linux only: which C library the binary links. */
  readonly libc?: "glibc" | "musl"
  /** `baseline` runs on x64 CPUs without AVX2 (pre-2013 hosts, generic VM CPU models). */
  readonly cpu?: "baseline"
  /** First-class targets: built and fully smoke-tested natively on every release. */
  readonly priority: boolean
  /**
   * The GitHub-hosted runner that builds it. A target whose os and arch
   * match the runner is a native build: `compile.ts` runs smoke and e2e.
   */
  readonly runner: string
}

/** The runner that builds darwin-x64 natively when the opt-in is on. */
export const DARWIN_X64_NATIVE_RUNNER = "macos-15-intel"

/** Every release target, priority targets first. */
export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  {
    id: "darwin-arm64",
    bun: "bun-darwin-arm64",
    os: "darwin",
    arch: "arm64",
    priority: true,
    runner: "macos-latest",
  },
  {
    id: "linux-x64",
    bun: "bun-linux-x64",
    os: "linux",
    arch: "x64",
    libc: "glibc",
    priority: true,
    runner: "ubuntu-latest",
  },
  {
    id: "darwin-x64",
    bun: "bun-darwin-x64",
    os: "darwin",
    arch: "x64",
    priority: false,
    runner: "macos-latest",
  },
  {
    id: "linux-x64-baseline",
    bun: "bun-linux-x64-baseline",
    os: "linux",
    arch: "x64",
    libc: "glibc",
    cpu: "baseline",
    priority: false,
    runner: "ubuntu-latest",
  },
  {
    id: "linux-x64-musl",
    bun: "bun-linux-x64-musl",
    os: "linux",
    arch: "x64",
    libc: "musl",
    priority: false,
    runner: "ubuntu-latest",
  },
  {
    id: "linux-arm64",
    bun: "bun-linux-arm64",
    os: "linux",
    arch: "arm64",
    libc: "glibc",
    priority: false,
    runner: "ubuntu-24.04-arm",
  },
  {
    id: "linux-arm64-musl",
    bun: "bun-linux-arm64-musl",
    os: "linux",
    arch: "arm64",
    libc: "musl",
    priority: false,
    runner: "ubuntu-24.04-arm",
  },
]

/** The asset ids, for messages. */
export const RELEASE_TARGET_IDS: readonly string[] = RELEASE_TARGETS.map((t) => t.id)

/**
 * Find a release target by asset id (`linux-x64-musl`) or by Bun target
 * string (`bun-linux-x64-musl`). `aarch64` is read as `arm64`.
 *
 * @param spec - an asset id or a Bun compile target string
 * @returns the target, or undefined when `spec` names none of them
 */
export function findReleaseTarget(spec: string): ReleaseTarget | undefined {
  const id = spec.replace(/^bun-/, "").replace("-aarch64", "-arm64")
  return RELEASE_TARGETS.find((t) => t.id === id)
}

/** One build leg of the release workflow: a runner and the targets it builds. */
export interface MatrixLeg {
  readonly runner: string
  /** Space-separated target ids. */
  readonly targets: string
}

/**
 * Group the targets by runner, in table order. With `darwinX64Native`,
 * darwin-x64 moves to its own Intel leg so it is smoke-tested natively
 * (macOS minutes cost 10x on a private repo, so this is opt-in).
 *
 * @param darwinX64Native - build darwin-x64 on {@link DARWIN_X64_NATIVE_RUNNER}
 * @returns the legs for `strategy.matrix.include`
 */
export function matrixLegs(darwinX64Native: boolean): MatrixLeg[] {
  const byRunner = new Map<string, string[]>()
  for (const t of RELEASE_TARGETS) {
    const runner = t.id === "darwin-x64" && darwinX64Native ? DARWIN_X64_NATIVE_RUNNER : t.runner
    byRunner.set(runner, [...(byRunner.get(runner) ?? []), t.id])
  }
  return [...byRunner].map(([runner, ids]) => ({ runner, targets: ids.join(" ") }))
}

// CLI: `bun run scripts/release/targets.ts [--json | --matrix [--darwin-x64-native] | --get ID]`.
// Shell steps read the table from here, so there is no second copy.
if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.includes("--json")) {
    console.log(JSON.stringify(RELEASE_TARGETS, null, 2))
  } else if (args.includes("--matrix")) {
    console.log(JSON.stringify({ include: matrixLegs(args.includes("--darwin-x64-native")) }))
  } else if (args[0] === "--get") {
    const t = findReleaseTarget(args[1] ?? "")
    if (t === undefined) {
      console.error(
        `unknown target ${args[1] ?? "(none)"}; one of ${RELEASE_TARGET_IDS.join(", ")}`,
      )
      process.exit(2)
    }
    // Tab-separated for `read` in shell: id bun os arch libc cpu priority ("-" = none).
    console.log([t.id, t.bun, t.os, t.arch, t.libc ?? "-", t.cpu ?? "-", t.priority].join("\t"))
  } else {
    for (const t of RELEASE_TARGETS) console.log(`${t.id}\t${t.bun}\t${t.runner}`)
  }
}
