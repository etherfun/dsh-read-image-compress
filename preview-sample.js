/**
 * Where the settings preview's sample photo comes from.
 *
 * The photo is not packaged: the published tarball carries code only, and the
 * sample lives in the GitHub repository that hosts the plugin. Both GitHub
 * routes — the jsDelivr CDN (fast from mainland China) and
 * `raw.githubusercontent.com` (direct, and reachable where a CDN is not) — are
 * requested at the same time and the first image that arrives wins, so a route
 * that hangs cannot delay the other. When neither GitHub route answers inside
 * the window, Bing's daily wallpaper for today stands in, so the preview still
 * shows a real photograph instead of an empty frame.
 *
 * Everything here is a pure function of its options: the fetch implementation,
 * the timeouts, and the clock all come from the caller, so every route can be
 * tested without a network.
 */

/** Repository-relative path of the sample photo. */
export const SAMPLE_PATH = 'preview/sample.png'

/** How long the two GitHub routes get, together and in parallel. */
export const DEFAULT_GITHUB_TIMEOUT_MS = 3500
/** How long Bing gets for the archive lookup plus the wallpaper itself. */
export const DEFAULT_BING_TIMEOUT_MS = 6000

const MAX_BYTES = 32 * 1024 * 1024
const MIN_BYTES = 8 * 1024
const BING_ARCHIVE = 'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1'
const BING_RESOLUTIONS = ['UHD', '1920x1080']
/** The archive JSON is tiny; a slow lookup means a blocked lookup. */
const BING_ARCHIVE_TIMEOUT_MS = 2500

/** Raised when no source produced a photo; `code` is what the route reports. */
export class SampleUnavailableError extends Error {
  /**
   * @param message - Human-readable summary.
   * @param options - Per-source failures, for the log line.
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'SampleUnavailableError'
    this.code = 'sample-unavailable'
    this.attempts = options.attempts ?? []
  }
}

/**
 * Owner and repository from a `repository` value in any shape npm accepts.
 * @param value - URL, `owner/repo`, `github:owner/repo`, or `git+https://…`.
 * @returns The pair, or undefined when the value names no GitHub repository.
 */
export function parseRepository(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim().replace(/^git\+/, '')
  if (text === '') return undefined
  if (text.startsWith('github:')) return parseRepository(`https://github.com/${text.slice('github:'.length)}`)
  const url = /^(?:git\+)?(?:ssh:\/\/)?(?:git@)?(?:https?:\/\/)?(?:www\.)?github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i.exec(text)
  if (url !== null) return { owner: url[1], repo: url[2] }
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(text)
  if (short !== null) return { owner: short[1], repo: short[2] }
  return undefined
}

/**
 * The GitHub routes for the sample, in preference order.
 * @param repository - A `repository` value.
 * @param branch - Branch or tag to read; a tag pins the photo to a release.
 * @returns Route objects, empty without a GitHub repository.
 */
export function githubSampleRoutes(repository, branch = 'main') {
  const parsed = parseRepository(repository)
  if (parsed === undefined) return []
  return [
    { id: 'jsdelivr', url: `https://cdn.jsdelivr.net/gh/${parsed.owner}/${parsed.repo}@${branch}/${SAMPLE_PATH}` },
    { id: 'github', url: `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${branch}/${SAMPLE_PATH}` },
  ]
}

/**
 * Today's wallpaper URL from a Bing archive payload.
 * @param payload - Parsed `HPImageArchive.aspx?format=js` response.
 * @param resolution - Bing's size suffix: `UHD`, `1920x1080`, …
 * @returns The image URL, or undefined when the payload carries no wallpaper.
 */
export function bingImageUrl(payload, resolution = 'UHD') {
  const image = Array.isArray(payload?.images) ? payload.images[0] : undefined
  if (image === null || typeof image !== 'object') return undefined
  if (typeof image.urlbase === 'string' && image.urlbase !== '') return `https://www.bing.com${image.urlbase}_${resolution}.jpg`
  if (typeof image.url === 'string' && image.url !== '') {
    try {
      return new URL(image.url, 'https://www.bing.com').href
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Per-source failure text; never throws on a non-Error rejection. */
const describe = (error) => (error instanceof Error ? error.message : String(error))

/** Remaining milliseconds, floored at zero. */
const remaining = (deadline, now) => Math.max(0, deadline - now())

/**
 * A signal that aborts on the caller's signal or the attempt timeout.
 * @param timeoutMs - Attempt budget.
 * @param signal - Optional caller signal (the request's own abort).
 */
function attemptSignal(timeoutMs, signal) {
  const timed = AbortSignal.timeout(Math.max(1, Math.round(timeoutMs)))
  if (signal === undefined || signal === null) return timed
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([timed, signal]) : timed
}

/**
 * Fetch bytes that must actually be an image of a plausible size.
 * @param url - Absolute image URL.
 * @param options - Timeout, signal, and fetch implementation.
 * @returns Buffer plus its media type.
 */
async function fetchImageBytes(url, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')
  const response = await fetchImpl(url, {
    signal: attemptSignal(options.timeoutMs, options.signal),
    redirect: 'follow',
    headers: { accept: 'image/*,*/*;q=0.8' },
  })
  if (response?.ok !== true) throw new Error(`HTTP ${response?.status ?? 'unknown'}`)
  const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error(`image is too large (${declared} bytes)`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length < MIN_BYTES) throw new Error(`response is too small to be a photo (${buffer.length} bytes)`)
  if (buffer.length > MAX_BYTES) throw new Error(`image is too large (${buffer.length} bytes)`)
  const type = (response.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!type.startsWith('image/')) throw new Error(`not an image (${type === '' ? 'no content type' : type})`)
  return { buffer, mediaType: type }
}

/**
 * Fetch and parse JSON with the same timeout rules.
 * @param url - Absolute URL.
 * @param options - Timeout, signal, and fetch implementation.
 */
async function fetchJson(url, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')
  const response = await fetchImpl(url, {
    signal: attemptSignal(options.timeoutMs, options.signal),
    redirect: 'follow',
    headers: { accept: 'application/json' },
  })
  if (response?.ok !== true) throw new Error(`HTTP ${response?.status ?? 'unknown'}`)
  return response.json()
}

/**
 * Request every route at once and take the first image that lands.
 *
 * A route that hangs is aborted as soon as another one succeeds, so the slow
 * route costs bandwidth for a moment and never latency.
 *
 * @param routes - `{ id, url }` pairs to race.
 * @param options - Window, caller signal, fetch implementation.
 * @returns Either the winning photo or the attempts that failed.
 */
async function raceRoutes(routes, options) {
  const controller = new AbortController()
  const attempts = []
  const signals = [AbortSignal.timeout(Math.max(1, Math.round(options.budgetMs))), controller.signal]
  if (options.signal !== undefined && options.signal !== null) signals.push(options.signal)
  const signal = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0]
  const tasks = routes.map((route) => (async () => {
    try {
      const image = await fetchImageBytes(route.url, { timeoutMs: options.budgetMs, signal, fetchImpl: options.fetchImpl })
      controller.abort()
      return { ...image, source: route.id, url: route.url }
    } catch (error) {
      attempts.push({ source: route.id, url: route.url, reason: describe(error) })
      throw error
    }
  })())
  try {
    const photo = await Promise.any(tasks)
    return { photo, attempts }
  } catch {
    return { attempts }
  }
}

/**
 * Load the sample photo from the best source that answers in time.
 *
 * The GitHub routes race first. When none of them answers, Bing's daily
 * wallpaper is used — the archive lookup for `zh-CN`, then the market-less
 * endpoint, because the archive call is the only part that can be regionally
 * blocked while the image CDN itself stays reachable.
 *
 * @param options - Repository, branch, timeouts, fetch implementation, signal, logger.
 * @returns The photo bytes plus the source id and URL they came from.
 * @throws SampleUnavailableError when every source failed or the budget ran out.
 */
export async function loadSamplePhoto(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const now = typeof options.now === 'function' ? options.now : Date.now
  const attempts = []
  const githubWindowMs = options.githubTimeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS
  const bingWindowMs = options.bingTimeoutMs ?? DEFAULT_BING_TIMEOUT_MS

  const githubRoutes = options.github === false ? [] : githubSampleRoutes(options.repository, options.branch)
  if (githubRoutes.length > 0 && githubWindowMs > 0) {
    const raced = await raceRoutes(githubRoutes, {
      budgetMs: githubWindowMs,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    })
    if (raced.photo !== undefined) return raced.photo
    attempts.push(...raced.attempts)
    for (const attempt of raced.attempts) {
      log(`sample photo: ${attempt.source} unavailable (${attempt.reason}); falling back to Bing's daily wallpaper`)
    }
  }

  const deadline = now() + bingWindowMs
  const budgetFor = (attemptTimeout) => Math.min(attemptTimeout, remaining(deadline, now))

  for (const market of ['zh-CN', '']) {
    const archiveUrl = market === '' ? BING_ARCHIVE : `${BING_ARCHIVE}&mkt=${market}`
    const archiveTimeout = budgetFor(BING_ARCHIVE_TIMEOUT_MS)
    if (archiveTimeout <= 0) {
      attempts.push({ source: `bing:${market || 'default'}`, url: archiveUrl, reason: 'the time budget ran out' })
      continue
    }
    let payload
    try {
      payload = await fetchJson(archiveUrl, { timeoutMs: archiveTimeout, signal: options.signal, fetchImpl: options.fetchImpl })
    } catch (error) {
      attempts.push({ source: `bing:${market || 'default'}`, url: archiveUrl, reason: describe(error) })
      log(`sample photo: Bing archive unavailable for ${market || 'the default market'} (${describe(error)})`)
      continue
    }
    for (const resolution of BING_RESOLUTIONS) {
      const url = bingImageUrl(payload, resolution)
      if (url === undefined) continue
      const imageTimeout = budgetFor(remaining(deadline, now))
      if (imageTimeout <= 0) break
      try {
        const image = await fetchImageBytes(url, { timeoutMs: imageTimeout, signal: options.signal, fetchImpl: options.fetchImpl })
        return { ...image, source: 'bing', url }
      } catch (error) {
        attempts.push({ source: 'bing', url, reason: describe(error) })
        log(`sample photo: Bing wallpaper ${resolution} unavailable (${describe(error)})`)
      }
    }
  }

  throw new SampleUnavailableError('no sample photo source answered', { attempts })
}
