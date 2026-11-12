/**
 * GitHub Releases client for `minimal-agent update`.
 *
 * The binaries are published on the CLI repo's own Releases, and that repo
 * is PRIVATE. So every call carries a bearer token, and an asset downloads
 * through its API URL (`/releases/assets/<id>`) with
 * `Accept: application/octet-stream`: a private asset has no public URL.
 * GitHub answers that with a 302 to a short-lived signed storage URL. The
 * redirect is followed by hand WITHOUT the token, since the storage host
 * rejects a second auth mechanism and must never see the token.
 *
 * `fetch` is injected. The token never appears in an error message.
 *
 * @module update/github
 */

import { parseLabel } from "./version.ts"

/** The repo that publishes the binaries. */
export const RELEASE_REPO = "gastonmorixe/minimal-agent-cli"

/** The API base. `MINIMAL_AGENT_UPDATE_API` overrides it (tests, mirrors). */
export const DEFAULT_API_BASE = "https://api.github.com"

/** One release asset, the fields the updater reads. */
export interface ReleaseAsset {
  readonly id: number
  readonly name: string
  readonly size: number
  /** The API URL: `<api>/repos/<repo>/releases/assets/<id>`. */
  readonly url: string
}

/** One release, the fields the updater reads. */
export interface Release {
  readonly tag_name: string
  readonly name?: string | null
  readonly draft: boolean
  readonly prerelease: boolean
  readonly published_at?: string | null
  readonly html_url?: string
  readonly assets: readonly ReleaseAsset[]
}

/** The `fetch` slice the client uses. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/** Why a GitHub call failed. `kind` picks the message and the exit code. */
export class GithubError extends Error {
  /**
   * A failed GitHub call.
   *
   * @param kind - `auth` (401, 403 without rate limit), `not-found` (404),
   *   `rate-limit`, `network`, or `http` (any other status)
   * @param message - the text for the user, never the token
   * @param status - the HTTP status, when there was a response
   */
  constructor(
    readonly kind: "auth" | "not-found" | "rate-limit" | "network" | "http",
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/** Client options. */
export interface GithubClientOptions {
  readonly token: string
  readonly fetch?: FetchFn
  readonly apiBase?: string
  readonly repo?: string
  /** Per-request timeout for API calls in ms (not downloads). Default 15000. */
  readonly timeoutMs?: number
}

/** The private-repo hint for a 404 or a 401. */
export function privateRepoHint(repo: string): string {
  return (
    `${repo} is a private repo: the token needs read access to it ` +
    "(a fine-grained token with Contents: read, or a classic token with the repo scope)"
  )
}

/** A small GitHub Releases client. */
export class GithubReleases {
  private readonly token: string
  private readonly fetchFn: FetchFn
  readonly apiBase: string
  readonly repo: string
  private readonly timeoutMs: number

  /**
   * A client for one repo.
   *
   * @param opts - the token, and optional fetch, API base, repo, timeout
   */
  constructor(opts: GithubClientOptions) {
    this.token = opts.token
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init))
    this.apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/u, "")
    this.repo = opts.repo ?? RELEASE_REPO
    this.timeoutMs = opts.timeoutMs ?? 15_000
  }

  private headers(accept: string): Record<string, string> {
    return {
      Accept: accept,
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "minimal-agent-update",
    }
  }

  /** GET an API path and parse JSON. A 404 returns undefined. */
  private async getJson<T>(path: string): Promise<T | undefined> {
    const url = `${this.apiBase}/repos/${this.repo}${path}`
    let res: Response
    try {
      res = await this.fetchFn(url, {
        headers: this.headers("application/vnd.github+json"),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      throw new GithubError("network", `cannot reach ${this.apiBase}: ${errText(e)}`)
    }
    if (res.status === 404) return undefined
    if (!res.ok) throw await statusError(res, this.repo)
    return (await res.json()) as T
  }

  /** The latest stable release (`/releases/latest`), or undefined when none. */
  async latestStable(): Promise<Release | undefined> {
    return await this.getJson<Release>("/releases/latest")
  }

  /** Published releases, newest first, up to `pages` pages of 100. */
  async list(pages = 1): Promise<Release[]> {
    const out: Release[] = []
    for (let page = 1; page <= pages; page++) {
      const batch = (await this.getJson<Release[]>(`/releases?per_page=100&page=${page}`)) ?? []
      out.push(...batch)
      if (batch.length < 100) break
    }
    return out
  }

  /** The release of one tag, or undefined. */
  async byTag(tag: string): Promise<Release | undefined> {
    return await this.getJson<Release>(`/releases/tags/${encodeURIComponent(tag)}`)
  }

  /** Probe the repo itself: false on 404 (no access or no repo). */
  async repoVisible(): Promise<boolean> {
    return (await this.getJson<unknown>("")) !== undefined
  }

  /**
   * Download one asset's bytes. Follows GitHub's redirect to the storage
   * URL without the token.
   */
  async download(asset: ReleaseAsset): Promise<Uint8Array> {
    let res: Response
    try {
      res = await this.fetchFn(asset.url, {
        headers: this.headers("application/octet-stream"),
        redirect: "manual",
      })
      const location = res.headers.get("location")
      if (res.status >= 300 && res.status < 400 && location) {
        res = await this.fetchFn(location, {
          headers: { "User-Agent": "minimal-agent-update" },
        })
      }
    } catch (e) {
      throw new GithubError("network", `download of ${asset.name} failed: ${errText(e)}`)
    }
    if (!res.ok) {
      const err = await statusError(res, this.repo)
      throw new GithubError(err.kind, `download of ${asset.name}: ${err.message}`, err.status)
    }
    return new Uint8Array(await res.arrayBuffer())
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Map a failed response to a {@link GithubError}. */
async function statusError(res: Response, repo: string): Promise<GithubError> {
  const remaining = res.headers.get("x-ratelimit-remaining")
  if ((res.status === 403 || res.status === 429) && remaining === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"))
    const when =
      Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : "later"
    return new GithubError(
      "rate-limit",
      `GitHub API rate limit hit, retry after ${when}`,
      res.status,
    )
  }
  if (res.status === 401) {
    return new GithubError(
      "auth",
      `GitHub rejected the token (401): it is invalid or expired. ${privateRepoHint(repo)}`,
      401,
    )
  }
  if (res.status === 403) {
    return new GithubError("auth", `GitHub denied access (403). ${privateRepoHint(repo)}`, 403)
  }
  if (res.status === 404) {
    return new GithubError("not-found", `not found (404). ${privateRepoHint(repo)}`, 404)
  }
  let detail = ""
  try {
    const body = (await res.json()) as { message?: unknown }
    if (typeof body.message === "string") detail = `: ${body.message}`
  } catch {
    // not JSON
  }
  return new GithubError("http", `GitHub API error ${res.status}${detail}`, res.status)
}

/** True for a published nightly release (`v<x.y.z>-nightly.<stamp>`, pre-release). */
export function isNightlyRelease(r: Release): boolean {
  return !r.draft && r.prerelease && parseLabel(r.tag_name)?.channel === "nightly"
}

/**
 * The newest published nightly: highest stamp first (not semver, since a
 * nightly of an older version can be newer than one of a later version only
 * if the version went backwards, which the release flow never does), then
 * the publish time.
 */
export function newestNightly(releases: readonly Release[]): Release | undefined {
  let best: { r: Release; t: number } | undefined
  for (const r of releases) {
    if (!isNightlyRelease(r)) continue
    const t = parseLabel(r.tag_name)?.stamp?.getTime() ?? 0
    if (best === undefined || t > best.t) best = { r, t }
  }
  return best?.r
}

/** True for a published stable release (no pre-release part, not a draft). */
export function isStableRelease(r: Release): boolean {
  return !r.draft && !r.prerelease && parseLabel(r.tag_name)?.channel === "stable"
}
