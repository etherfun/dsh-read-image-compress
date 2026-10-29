/**
 * `read_image` post-processing: downscale and re-encode image results before
 * they are committed to the session.
 *
 * The plugin reads the stored attachment, encodes it with the deployment's own
 * Sharp/libvips (resolved from the running DSH installation), and commits the
 * derived bytes through the attachment store. A fallback to the store's
 * request-image encoder keeps the plugin working when Sharp cannot be loaded,
 * at the cost of ignoring the quality/format settings.
 *
 * The compressed image is installed as the result's model-facing content, which
 * also feeds the conversation card: the gallery renders the new attachment and
 * the trailing text block becomes the row's footer (`imageExtra`) describing the
 * original and compressed dimensions, byte sizes, and the compression ratio.
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'

export const name = 'read-image-compress'

/** The attachment store is optional; without it this plugin stays inactive. */
export const inject = ['attachments']

const requireFromPlugin = createRequire(import.meta.url)

function loadFirst(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    try {
      return requireFromPlugin(candidate)
    } catch {
      // Try the next installation layout.
    }
  }
  return undefined
}

function loadSharp() {
  const candidates = []
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', 'sharp'))
    candidates.push(path.join(process.resourcesPath, 'app.asar', 'node_modules', 'sharp'))
  }
  if (process.execPath) {
    const dir = path.dirname(process.execPath)
    candidates.push(path.join(dir, 'resources', 'app.asar', 'dsh', 'node_modules', 'sharp'))
    candidates.push(path.join(dir, 'resources', 'app.asar', 'node_modules', 'sharp'))
  }
  return loadFirst(candidates)
}

function loadSchema() {
  const candidates = []
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery'))
  }
  if (process.env.DSH_PROFILE_DIR) {
    candidates.push(path.join(process.env.DSH_PROFILE_DIR, 'node_modules', '@deepseek-ai', 'schemastery'))
  }
  if (process.env.DSH_HOME) {
    for (const profile of [process.env.DSH_PROFILE, 'web', 'desktop']) {
      if (profile) candidates.push(path.join(process.env.DSH_HOME, 'profiles', profile, 'node_modules', '@deepseek-ai', 'schemastery'))
    }
  }
  const loaded = loadFirst(candidates)
  return loaded?.default ?? loaded
}

const sharp = loadSharp()
const Schema = loadSchema()

/** The settings schema the Plugins page renders for this row. */
export const Config = Schema === undefined ? undefined : Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  quality: Schema.number().min(1).max(100).default(85).volatile(),
  resolutionScale: Schema.number().min(0.1).max(1).default(1).volatile(),
  format: Schema.string().default('auto').volatile(),
  maxEdge: Schema.number().min(64).max(8192).default(1568).volatile(),
  maxPixels: Schema.number().min(10000).max(268435456).default(1690000).volatile(),
  maxBytes: Schema.number().min(1024).default(524288).volatile(),
  minBytes: Schema.number().min(0).default(131072).volatile(),
  minResizeScale: Schema.number().min(0.1).max(1).default(0.9).volatile(),
  webpEffort: Schema.number().min(0).max(6).default(4).volatile(),
  jpegBackground: Schema.string().default('#ffffff').volatile(),
  cacheEntries: Schema.number().min(0).max(4096).default(128).volatile(),
  downscaleWebp: Schema.boolean().default(true).volatile(),
  skipGif: Schema.boolean().default(true).volatile(),
  summaryMode: Schema.string().default('detailed').volatile(),
  summaryLanguage: Schema.string().default('zh').volatile(),
})

const FORMATS = new Set(['auto', 'jpeg', 'webp', 'png'])
const SUMMARY_MODES = new Set(['detailed', 'compact', 'off'])
const SUMMARY_LANGUAGES = new Set(['zh', 'en'])

const DEFAULTS = Object.freeze({
  enabled: true,
  quality: 85,
  resolutionScale: 1,
  format: 'auto',
  maxEdge: 1568,
  maxPixels: 1690000,
  maxBytes: 524288,
  minBytes: 131072,
  minResizeScale: 0.9,
  webpEffort: 4,
  jpegBackground: '#ffffff',
  cacheEntries: 128,
  downscaleWebp: true,
  skipGif: true,
  summaryMode: 'detailed',
  summaryLanguage: 'zh',
})

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`read-image-compress: ${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function numberInRange(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`read-image-compress: ${name} must be a number between ${min} and ${max}`)
  }
  return value
}

function readValue(value, fallback) {
  if (value === undefined) return fallback
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      const current = value.get()
      return current === undefined ? fallback : current
    } catch {
      return fallback
    }
  }
  return value
}

function normalizeConfig(raw) {
  const config = raw ?? {}
  const enabled = readValue(config.enabled, DEFAULTS.enabled)
  if (typeof enabled !== 'boolean') throw new Error('read-image-compress: enabled must be a boolean')

  const quality = integer(readValue(config.quality, DEFAULTS.quality), 'quality', 1, 100)
  const resolutionScale = numberInRange(readValue(config.resolutionScale, DEFAULTS.resolutionScale), 'resolutionScale', 0.1, 1)
  const maxEdge = integer(readValue(config.maxEdge, DEFAULTS.maxEdge), 'maxEdge', 64, 8192)
  const maxPixels = integer(readValue(config.maxPixels, DEFAULTS.maxPixels), 'maxPixels', 10000, 268435456)
  const maxBytes = integer(readValue(config.maxBytes, DEFAULTS.maxBytes), 'maxBytes', 1024, Number.MAX_SAFE_INTEGER)
  const minBytes = integer(readValue(config.minBytes, DEFAULTS.minBytes), 'minBytes', 0, Number.MAX_SAFE_INTEGER)
  const minResizeScale = numberInRange(readValue(config.minResizeScale, DEFAULTS.minResizeScale), 'minResizeScale', 0.1, 1)
  const webpEffort = integer(readValue(config.webpEffort, DEFAULTS.webpEffort), 'webpEffort', 0, 6)
  const cacheEntries = integer(readValue(config.cacheEntries, DEFAULTS.cacheEntries), 'cacheEntries', 0, 4096)

  const format = String(readValue(config.format, DEFAULTS.format)).toLowerCase()
  if (!FORMATS.has(format)) throw new Error(`read-image-compress: format must be one of ${[...FORMATS].join(', ')}`)

  const jpegBackground = String(readValue(config.jpegBackground, DEFAULTS.jpegBackground))
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(jpegBackground)) {
    throw new Error('read-image-compress: jpegBackground must be a hex colour such as #ffffff')
  }

  const summaryMode = String(readValue(config.summaryMode, DEFAULTS.summaryMode)).toLowerCase()
  if (!SUMMARY_MODES.has(summaryMode)) {
    throw new Error(`read-image-compress: summaryMode must be one of ${[...SUMMARY_MODES].join(', ')}`)
  }
  const summaryLanguage = String(readValue(config.summaryLanguage, DEFAULTS.summaryLanguage)).toLowerCase()
  if (!SUMMARY_LANGUAGES.has(summaryLanguage)) {
    throw new Error(`read-image-compress: summaryLanguage must be one of ${[...SUMMARY_LANGUAGES].join(', ')}`)
  }

  const downscaleWebp = readValue(config.downscaleWebp, DEFAULTS.downscaleWebp)
  const skipGif = readValue(config.skipGif, DEFAULTS.skipGif)
  if (typeof downscaleWebp !== 'boolean') throw new Error('read-image-compress: downscaleWebp must be a boolean')
  if (typeof skipGif !== 'boolean') throw new Error('read-image-compress: skipGif must be a boolean')

  return {
    enabled,
    quality,
    resolutionScale,
    format,
    maxEdge,
    maxPixels,
    maxBytes,
    minBytes,
    minResizeScale,
    webpEffort,
    jpegBackground,
    cacheEntries,
    downscaleWebp,
    skipGif,
    summaryMode,
    summaryLanguage,
  }
}

const warned = new Set()
function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`read-image-compress: ${message}`)
  } catch {
    // Logging must never change the tool outcome.
  }
}
function warnOnce(ctx, key, message) {
  if (warned.has(key)) return
  warned.add(key)
  warn(ctx, message)
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function mediaTypeOf(format) {
  return format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png'
}

function formatFor(hasAlpha, options) {
  if (options.format !== 'auto') return options.format
  return hasAlpha ? 'webp' : 'jpeg'
}

/**
 * Pick the raster to encode. The long-edge cap, the total-pixel budget, and the
 * user's extra scale are all upper bounds; the smallest one wins. The pixel
 * budget matters because a model bills an image by its pixels after its own
 * downscale, so a square image capped only by a long edge can still cost more
 * tokens than the ~1300×1300 budget we target by default.
 */
function targetFor(image, options) {
  const longEdge = Math.max(image.width, image.height)
  const area = image.width * image.height
  const edgeScale = Math.min(1, options.maxEdge / longEdge)
  const pixelScale = area > options.maxPixels ? Math.sqrt(options.maxPixels / area) : 1
  const scale = Math.min(1, options.resolutionScale, edgeScale, pixelScale)
  const resize = scale < 1 && scale <= options.minResizeScale
  return resize
    ? {
        width: Math.max(1, Math.round(image.width * scale)),
        height: Math.max(1, Math.round(image.height * scale)),
        scale,
        resize,
      }
    : { width: image.width, height: image.height, scale: 1, resize: false }
}

function shouldSkip(image, target, hasAlpha, options) {
  if (image.mediaType === 'image/gif' && options.skipGif) return true
  if (image.mediaType === 'image/gif' && !options.skipGif) {
    // Sharp decodes the first frame; the caller explicitly opted in.
  } else if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mediaType)) {
    return true
  }
  if (!target.resize && image.bytes < options.minBytes) return true
  if (image.mediaType === 'image/webp' && !options.downscaleWebp && !target.resize) return true

  const desiredType = mediaTypeOf(formatFor(hasAlpha, options))
  if (!target.resize && image.mediaType === desiredType && image.bytes <= options.maxBytes) return true
  return false
}

function qualitySteps(quality) {
  const steps = []
  for (let value = quality; value >= 40; value -= 10) steps.push(value)
  if (steps.length === 0) steps.push(quality)
  return [...new Set(steps)]
}

async function encodeSharp(ctx, image, options, signal) {
  const stored = await ctx.attachments.readImage(image, signal)
  if (stored?.data === undefined) return { skipped: true }
  const metadata = await sharp(stored.data).metadata()
  const hasAlpha = metadata.hasAlpha === true
  const target = targetFor(image, options)
  if (shouldSkip(image, target, hasAlpha, options)) return { skipped: true }

  const format = formatFor(hasAlpha, options)
  let base = sharp(stored.data, { failOn: 'error', limitInputPixels: false })
    .rotate()
    .toColourspace('srgb')
  if (target.resize) {
    base = base.resize({ width: target.width, height: target.height, fit: 'inside', withoutEnlargement: true })
  }
  if (format === 'jpeg') base = base.flatten({ background: options.jpegBackground })

  let best
  for (const quality of format === 'png' ? [null] : qualitySteps(options.quality)) {
    let pipeline = base.clone()
    if (format === 'jpeg') pipeline = pipeline.jpeg({ quality })
    else if (format === 'webp') pipeline = pipeline.webp({ quality, effort: options.webpEffort })
    else pipeline = pipeline.png({ compressionLevel: 9, bitdepth: 8 })
    const output = await pipeline.toBuffer({ resolveWithObject: true })
    const candidate = {
      data: output.data,
      mediaType: mediaTypeOf(format),
      bytes: output.data.length,
      width: output.info.width,
      height: output.info.height,
      quality,
    }
    if (best === undefined || candidate.bytes < best.bytes) best = candidate
    if (format === 'png' || candidate.bytes <= options.maxBytes) break
  }
  return best === undefined ? { skipped: true } : { encoded: best }
}

async function encodeFallback(ctx, image, options, signal) {
  const target = targetFor(image, options)
  const maxBytes = Math.min(options.maxBytes, Math.max(1, image.bytes - 1))
  const version = await ctx.attachments.readImageRequest(image, { width: target.width, height: target.height, maxBytes }, signal)
  if (version === undefined || !isPositiveInteger(version.bytes)) return undefined
  return {
    data: version.data,
    mediaType: version.mediaType,
    bytes: version.bytes,
    width: version.width,
    height: version.height,
    quality: 85,
  }
}

const cache = new Map()
function cacheKey(image, options) {
  return [
    image.attachmentId,
    options.quality,
    options.resolutionScale,
    options.format,
    options.maxEdge,
    options.maxPixels,
    options.maxBytes,
    options.minBytes,
    options.minResizeScale,
    options.webpEffort,
    options.jpegBackground,
    options.downscaleWebp,
  ].join('|')
}
function cacheGet(key, options) {
  if (options.cacheEntries <= 0) return undefined
  const value = cache.get(key)
  if (value === undefined) return undefined
  cache.delete(key)
  cache.set(key, value)
  return value
}
function cacheSet(key, value, options) {
  if (options.cacheEntries <= 0) return
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > options.cacheEntries) cache.delete(cache.keys().next().value)
}
function withName(entry, image) {
  const result = { ...entry }
  if (image.name === undefined) delete result.name
  else result.name = image.name
  return result
}

/**
 * The attachment reference installed as the result content. `originalDimensions`
 * is deliberately omitted: the footer text block already reports the original
 * raster and byte size, so the built-in size line stays a single clean fact.
 */
function replacementFrom(saved, image) {
  const replacement = {
    attachmentId: saved.attachmentId,
    mediaType: saved.mediaType,
    bytes: saved.bytes,
    width: saved.width,
    height: saved.height,
  }
  const name = saved.name ?? image.name
  if (name !== undefined) replacement.name = name
  return replacement
}

async function commit(ctx, image, encoded) {
  const saved = await ctx.attachments.saveImage({
    data: encoded.data,
    mediaType: encoded.mediaType,
    ...(image.name === undefined ? {} : { name: image.name }),
  })
  if (saved === undefined || saved.attachmentId === image.attachmentId) return undefined
  return replacementFrom(saved, image)
}

async function compressImage(ctx, image, options, signal) {
  if (!isPositiveInteger(image.width) || !isPositiveInteger(image.height)) return undefined
  if (!isPositiveInteger(image.bytes)) return undefined
  if (typeof image.mediaType !== 'string') return undefined
  if (image.mediaType === 'image/gif' && options.skipGif) return undefined

  const key = cacheKey(image, options)
  const cached = cacheGet(key, options)
  if (cached !== undefined) return withName(cached, image)

  let encoded
  let sharpFailed = false
  if (sharp !== undefined) {
    try {
      const result = await encodeSharp(ctx, image, options, signal)
      if (result.skipped === true) return undefined
      encoded = result.encoded
    } catch (error) {
      if (signal?.aborted === true) throw error
      sharpFailed = true
      warnOnce(ctx, 'sharp', `Sharp encoding failed; using the attachment encoder: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (encoded === undefined) {
    if (sharp === undefined || sharpFailed) {
      warnOnce(ctx, 'fallback', 'Sharp is unavailable; format/quality settings are ignored and the attachment encoder is used')
    }
    encoded = await encodeFallback(ctx, image, options, signal)
  }
  if (encoded === undefined) return undefined

  const fewerPixels = encoded.width < image.width || encoded.height < image.height
  const fewerBytes = encoded.bytes < image.bytes
  const changedFormat = encoded.mediaType !== image.mediaType
  if (!fewerPixels && !fewerBytes && !(options.format !== 'auto' && changedFormat)) return undefined

  const replacement = await commit(ctx, image, encoded)
  if (replacement === undefined) return undefined
  cacheSet(key, { ...replacement, name: undefined }, options)
  return replacement
}

//#region Result footer text

const MEDIA_LABELS = new Map([
  ['image/png', 'PNG'],
  ['image/jpeg', 'JPEG'],
  ['image/webp', 'WebP'],
  ['image/gif', 'GIF'],
])

/** Short human label for an image media type. */
function mediaLabel(mediaType) {
  return MEDIA_LABELS.get(mediaType) ?? String(mediaType).replace(/^image\//u, '').toUpperCase()
}

/**
 * The format the file on disk had, read from its extension. The attachment
 * store may re-encode a large source (a PNG can be committed as JPEG), so the
 * attachment's media type is only a fallback for extension-less reads.
 */
function mediaLabelForPath(displayPath, fallback) {
  const match = typeof displayPath === 'string' ? /\.([a-z0-9]+)$/iu.exec(displayPath) : undefined
  const extension = match?.[1]?.toLowerCase()
  if (extension === 'png') return 'PNG'
  if (extension === 'jpg' || extension === 'jpeg') return 'JPEG'
  if (extension === 'webp') return 'WebP'
  if (extension === 'gif') return 'GIF'
  return mediaLabel(fallback)
}

/** Adaptive B/KB/MB/GB size text; undefined for a missing measure. */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return undefined
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}

/** Multiplier text such as `15.7×`, or undefined without a byte measure. */
function formatMultiplier(sourceBytes, compressedBytes) {
  if (!(sourceBytes > 0) || !(compressedBytes > 0)) return undefined
  const ratio = sourceBytes / compressedBytes
  return `${ratio >= 10 ? ratio.toFixed(1) : ratio.toFixed(2)}×`
}

/** One-decimal percentage of `to` relative to `from`, or undefined. */
function percentOf(from, to) {
  if (!(from > 0) || !(to > 0)) return undefined
  return Math.round((to / from) * 1000) / 10
}

/** The provider normalizes an image to 544²..1300² before billing it and caps one image at 1024 tokens. */
const MIN_BILLED_PIXELS = 544 * 544
const MAX_BILLED_PIXELS = 1300 * 1300
const IMAGE_TOKEN_CAP = 1024

/**
 * Estimate the per-image token cost implied by the provider's stated rule: the
 * upscale floor applies, but the ceiling does not — an image above 1300² keeps
 * a proportional (over-cap) estimate so the footer can say by how much it would
 * exceed DeepSeek's 1024-token cap. An estimate for display, not a tokenizer.
 */
function estimateTokens(width, height) {
  const area = width * height
  if (!(area > 0)) return 0
  const billed = Math.max(MIN_BILLED_PIXELS, area)
  return Math.max(1, Math.round((billed / MAX_BILLED_PIXELS) * IMAGE_TOKEN_CAP))
}

/**
 * The original file facts behind one read. `originalDimensions`, when present,
 * is the pre-normalization raster; the on-disk byte size is recovered with a
 * best-effort stat of the recorded display path (the attachment ref only counts
 * normalized bytes once the store re-encoded the source).
 */
async function sourceFacts(meta, image, fallbackPath) {
  const recorded = typeof meta?.path === 'string' && meta.path !== '' ? meta.path : undefined
  const displayPath = recorded ?? (typeof fallbackPath === 'string' && fallbackPath !== '' ? fallbackPath : undefined)
  const width = image.originalDimensions?.width ?? image.width
  const height = image.originalDimensions?.height ?? image.height
  let bytes
  if (displayPath !== undefined) {
    try {
      const info = await stat(displayPath)
      if (info.isFile() && info.size > 0) bytes = info.size
    } catch {
      // A non-local, renamed, or already-removed source keeps attachment facts.
    }
  }
  if (bytes === undefined && image.originalDimensions === undefined) bytes = image.bytes
  return { path: displayPath, width, height, bytes }
}

/**
 * The row footer shown under the gallery: original raster and size, compressed
 * raster and size, and the byte multiplier with pixel and format context.
 */
function summaryLine(image, replacement, source, options) {
  if (options.summaryMode === 'off') return undefined
  const zh = options.summaryLanguage !== 'en'
  const sourceSize = formatBytes(source.bytes)
  const compressedSize = formatBytes(replacement.bytes)
  const multiplier = formatMultiplier(source.bytes, replacement.bytes)
  const bytesDelta = source.bytes > 0 ? (1 - replacement.bytes / source.bytes) * 100 : undefined
  const resolutionDelta = percentOf(Math.max(source.width, source.height), Math.max(replacement.width, replacement.height)) === undefined
    ? undefined
    : (1 - Math.max(replacement.width, replacement.height) / Math.max(source.width, source.height)) * 100
  const sourceFormat = mediaLabelForPath(source.path, image.mediaType)
  const compressedFormat = mediaLabel(replacement.mediaType)
  const tokens = estimateTokens(replacement.width, replacement.height)
  const capNote = tokens > IMAGE_TOKEN_CAP
    ? zh ? '（大于 DeepSeek 单张 1024 tokens 上限，服务端可能二次压缩）' : ' (over the DeepSeek 1024-token cap; the server may recompress it)'
    : tokens === IMAGE_TOKEN_CAP
      ? zh ? '（已达 DeepSeek 单张 1024 tokens 上限）' : ' (at the DeepSeek 1024-token cap)'
      : ''
  const raster = (width, height) => `${width}×${height}`

  if (options.summaryMode === 'compact') {
    const left = `${raster(source.width, source.height)}${sourceSize === undefined ? '' : ` ${sourceSize}`}`
    const right = `${raster(replacement.width, replacement.height)}${compressedSize === undefined ? '' : ` ${compressedSize}`}`
    const arrowLine = multiplier === undefined ? `${left} → ${right}` : `${left} → ${right} · ${multiplier}`
    return `${arrowLine} · ≈${tokens} tokens${capNote}`
  }

  const sourceParts = [raster(source.width, source.height)]
  if (sourceSize !== undefined) sourceParts.push(sourceSize)
  if (sourceFormat !== '') sourceParts.push(sourceFormat)
  const compressedParts = [raster(replacement.width, replacement.height)]
  if (compressedSize !== undefined) compressedParts.push(compressedSize)
  if (compressedFormat !== sourceFormat && compressedFormat !== '') compressedParts.push(compressedFormat)

  const details = []
  if (bytesDelta !== undefined && Number.isFinite(bytesDelta)) {
    const arrow = bytesDelta >= 0 ? '↓' : '↑'
    details.push(zh ? `体积 ${arrow}${Math.abs(bytesDelta).toFixed(1)}%` : `bytes ${arrow}${Math.abs(bytesDelta).toFixed(1)}%`)
  }
  if (resolutionDelta !== undefined && Number.isFinite(resolutionDelta)) {
    const arrow = resolutionDelta >= 0 ? '↓' : '↑'
    details.push(zh ? `分辨率 ${arrow}${Math.abs(resolutionDelta).toFixed(1)}%` : `resolution ${arrow}${Math.abs(resolutionDelta).toFixed(1)}%`)
  }

  const ratio = multiplier === undefined
    ? details.length === 0 ? undefined : details[0]
    : `${multiplier}${details.length === 0 ? '' : zh ? `（${details.join('，')}）` : ` (${details.join(', ')})`}`

  if (zh) {
    return `原图: ${sourceParts.join(' · ')} | 压缩后: ${compressedParts.join(' · ')}${ratio === undefined ? '' : ` | 压缩比: ${ratio}`} | ≈${tokens} tokens${capNote}`
  }
  return `Original: ${sourceParts.join(' · ')} | Compressed: ${compressedParts.join(' · ')}${ratio === undefined ? '' : ` | Ratio: ${ratio}`} | ≈${tokens} tokens${capNote}`
}

/**
 * Rebuild the model-facing content for a compressed result: swap the image block
 * for the committed attachment and append the footer text block. Every other
 * block — including the envelope DSH wrote (`<path>`, `<type>`, `<content>`,
 * `</content>`) — is passed through untouched, so the conversation card keeps
 * recognizing it and the file facts stay exactly as the tool reported them.
 */
function compressedContent(result, value, replacement, options, source) {
  const content = Array.isArray(result.content) ? result.content : undefined
  if (content === undefined) return undefined
  let imageIndex = -1
  for (let index = 0; index < content.length; index += 1) {
    if (content[index]?.type === 'image') {
      imageIndex = index
      break
    }
  }
  if (imageIndex < 0) return undefined
  const summary = summaryLine(value.image, replacement, source, options)
  const rebuilt = content.map((part, index) => index === imageIndex ? { type: 'image', attachment: replacement } : part)
  if (summary !== undefined) rebuilt.push({ type: 'text', text: summary })
  return rebuilt
}

//#endregion

//#region Preview endpoint

/**
 * Browser preview: three real renderings of one photo — as read, as the harness
 * alone would deliver it, and as this plugin would commit it — encoded by the
 * same sharp build the hook uses. The card may upload its own photo instead of
 * the bundled sample; uploaded bytes live in a small in-memory store.
 */
const PREVIEW_ROUTE = '/api/read-image-compress/preview'
const PREVIEW_SOURCE_ROUTE = '/api/read-image-compress/source'
const PREVIEW_IMAGE_ROUTE = '/api/read-image-compress/preview/image'
const PREVIEW_SAMPLE = new URL('./preview/sample.png', import.meta.url)
const PREVIEW_WIDTH = 3200
const PREVIEW_HEIGHT = 2000
const PREVIEW_NATIVE_MAX_EDGE = 2048
const PREVIEW_NATIVE_MAX_BYTES = 1048576
const PREVIEW_NATIVE_LADDER = [85, 75, 60]
const PREVIEW_THUMB_WIDTH = 560
const PREVIEW_BODY_LIMIT = 32768
const PREVIEW_UPLOAD_LIMIT = 16 * 1024 * 1024
const PREVIEW_CACHE_ENTRIES = 6
const PREVIEW_VIEW_ENTRIES = 6
const PREVIEW_UPLOAD_ENTRIES = 4
const PREVIEW_MAX_PIXELS = 64e6

let previewSamplePromise
let previewSample
const previewCache = new Map()
const previewUploads = new Map()
const previewViews = new Map()

/** The 3200×2000 JPEG the bundled sample becomes, encoded once per process. */
async function previewSampleBuffer() {
  if (previewSample !== undefined) return previewSample
  if (previewSamplePromise === undefined) {
    previewSamplePromise = (async () => {
      const raw = await readFile(PREVIEW_SAMPLE)
      const { data, info } = await sharp(raw)
        .resize({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, fit: 'cover', position: 'centre' })
        .jpeg({ quality: 92 })
        .toBuffer({ resolveWithObject: true })
      previewSample = { buffer: data, width: info.width, height: info.height, bytes: data.length, hasAlpha: false }
      return previewSample
    })().catch((error) => {
      previewSamplePromise = undefined
      throw error
    })
  }
  return previewSamplePromise
}

/** An uploaded source when its id is still cached, else the bundled sample. */
async function resolvePreviewSource(sourceId) {
  if (typeof sourceId === 'string' && previewUploads.has(sourceId)) return previewUploads.get(sourceId)
  return previewSampleBuffer()
}

/** Encode the plugin's variant of a source with the draft settings (never skipped). */
async function encodePluginVariant(source, options) {
  const facts = { width: source.width, height: source.height, bytes: source.bytes, mediaType: 'image/jpeg' }
  const target = targetFor(facts, options)
  const format = formatFor(source.hasAlpha === true, options)
  let base = sharp(source.buffer, { failOn: 'error', limitInputPixels: PREVIEW_MAX_PIXELS })
    .rotate()
    .toColourspace('srgb')
  if (target.resize) {
    base = base.resize({ width: target.width, height: target.height, fit: 'inside', withoutEnlargement: true })
  }
  if (format === 'jpeg') base = base.flatten({ background: options.jpegBackground })

  let best
  for (const quality of format === 'png' ? [null] : qualitySteps(options.quality)) {
    let pipeline = base.clone()
    if (format === 'jpeg') pipeline = pipeline.jpeg({ quality })
    else if (format === 'webp') pipeline = pipeline.webp({ quality, effort: options.webpEffort })
    else pipeline = pipeline.png({ compressionLevel: 9, bitdepth: 8 })
    const output = await pipeline.toBuffer({ resolveWithObject: true })
    const candidate = {
      data: output.data,
      bytes: output.data.length,
      width: output.info.width,
      height: output.info.height,
    }
    if (best === undefined || candidate.bytes < best.bytes) best = candidate
    if (format === 'png' || candidate.bytes <= options.maxBytes) break
  }
  return best
}

/** What the harness alone delivers: fit inside 2048², JPEG ladder to 1 MiB. */
async function encodeNativeVariant(source) {
  const longEdge = Math.max(source.width, source.height)
  const scale = Math.min(1, PREVIEW_NATIVE_MAX_EDGE / longEdge)
  let base = sharp(source.buffer, { failOn: 'error', limitInputPixels: PREVIEW_MAX_PIXELS })
    .rotate()
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
  if (scale < 1) {
    base = base.resize({
      width: Math.max(1, Math.round(source.width * scale)),
      height: Math.max(1, Math.round(source.height * scale)),
      fit: 'inside',
      withoutEnlargement: true,
    })
  }
  let best
  for (const quality of PREVIEW_NATIVE_LADDER) {
    const output = await base.clone().jpeg({ quality }).toBuffer({ resolveWithObject: true })
    const candidate = {
      data: output.data,
      bytes: output.data.length,
      width: output.info.width,
      height: output.info.height,
    }
    if (best === undefined || candidate.bytes < best.bytes) best = candidate
    if (candidate.bytes <= PREVIEW_NATIVE_MAX_BYTES) break
  }
  return best
}

/** A JPEG data URL at one display width; the reported facts stay those of the variant. */
async function previewThumbnail(buffer, width, quality) {
  const output = await sharp(buffer, { limitInputPixels: PREVIEW_MAX_PIXELS })
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer()
  return `data:image/jpeg;base64,${output.toString('base64')}`
}

/** Encode the three variants and pair each with its facts and thumbnail. */
async function previewPayload(settings, sourceId) {
  const options = normalizeConfig(settings)
  const source = await resolvePreviewSource(sourceId)
  const [native, plugin] = await Promise.all([
    encodeNativeVariant(source),
    encodePluginVariant(source, options),
  ])
  const variants = [
    { id: 'original', width: source.width, height: source.height, bytes: source.bytes, buffer: source.buffer },
    { id: 'native', width: native.width, height: native.height, bytes: native.bytes, buffer: native.data },
    { id: 'plugin', width: plugin.width, height: plugin.height, bytes: plugin.bytes, buffer: plugin.data },
  ]
  const thumbnails = await Promise.all(variants.map((variant) => previewThumbnail(variant.buffer, PREVIEW_THUMB_WIDTH, 78)))
  const viewKey = randomUUID()
  previewViews.set(viewKey, {
    original: { buffer: source.buffer, mediaType: source.mediaType ?? 'image/png' },
    native: { buffer: native.data, mediaType: 'image/jpeg' },
    plugin: { buffer: plugin.data, mediaType: plugin.mediaType ?? 'image/jpeg' },
  })
  while (previewViews.size > PREVIEW_VIEW_ENTRIES) previewViews.delete(previewViews.keys().next().value)
  return {
    ok: true,
    cap: IMAGE_TOKEN_CAP,
    viewKey,
    sample: { width: source.width, height: source.height, bytes: source.bytes },
    variants: variants.map((variant, index) => {
      const tokens = estimateTokens(variant.width, variant.height)
      return {
        id: variant.id,
        width: variant.width,
        height: variant.height,
        bytes: variant.bytes,
        tokens,
        capped: tokens >= IMAGE_TOKEN_CAP,
        thumbnail: thumbnails[index],
        viewUrl: `${PREVIEW_IMAGE_ROUTE}?key=${viewKey}&variant=${variant.id}`,
      }
    }),
  }
}

function previewJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

async function previewBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Register the preview and upload routes once the web server is available. */
function installPreview(ctx, rawConfig) {
  if (sharp === undefined) {
    warnOnce(ctx, 'preview', 'Preview routes are not registered because sharp is unavailable')
    return
  }

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (typeof webServer?.register !== 'function') {
      warnOnce(ctx, 'preview', 'Preview routes are not registered because webServer.register is unavailable')
      return
    }

    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: PREVIEW_ROUTE,
      handler: async (req, res) => {
        try {
          const raw = await previewBody(req, PREVIEW_BODY_LIMIT)
          const parsed = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'))
          const settings = parsed !== null && typeof parsed === 'object' && parsed.settings !== undefined ? parsed.settings : parsed
          const sourceId = parsed !== null && typeof parsed === 'object' && typeof parsed.sourceId === 'string' ? parsed.sourceId : undefined
          if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings must be an object')
          const key = JSON.stringify({ sourceId: sourceId ?? null, settings })
          const cached = previewCache.get(key)
          if (cached !== undefined) {
            previewCache.delete(key)
            previewCache.set(key, cached)
            return previewJson(res, 200, cached)
          }
          const payload = await previewPayload({ ...rawConfig, ...settings }, sourceId)
          previewCache.set(key, payload)
          while (previewCache.size > PREVIEW_CACHE_ENTRIES) previewCache.delete(previewCache.keys().next().value)
          return previewJson(res, 200, payload)
        } catch (error) {
          warn(ctx, `preview failed: ${error instanceof Error ? error.message : String(error)}`)
          return previewJson(res, 500, { ok: false, error: 'preview unavailable' })
        }
      },
    }), 'read-image-compress: preview route')

    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: PREVIEW_IMAGE_ROUTE,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const key = url.searchParams.get('key') ?? ''
          const variant = url.searchParams.get('variant') ?? ''
          const entry = previewViews.get(key)
          const selected = entry?.[variant]
          if (selected === undefined) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            return res.end('preview view not found')
          }
          res.writeHead(200, {
            'content-type': selected.mediaType,
            'content-length': String(selected.buffer.length),
            'cache-control': 'private, max-age=300',
          })
          return res.end(selected.buffer)
        } catch (error) {
          warn(ctx, `preview image failed: ${error instanceof Error ? error.message : String(error)}`)
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          return res.end('preview image unavailable')
        }
      },
    }), 'read-image-compress: preview image route')

    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: PREVIEW_SOURCE_ROUTE,
      handler: async (req, res) => {
        try {
          const buffer = await previewBody(req, PREVIEW_UPLOAD_LIMIT)
          if (buffer.length === 0) throw new Error('empty upload')
          const meta = await sharp(buffer, { failOn: 'error', limitInputPixels: PREVIEW_MAX_PIXELS }).metadata()
          const width = meta.width
          const height = meta.height
          if (!isPositiveInteger(width) || !isPositiveInteger(height)) throw new Error('not a decodable image')
          const id = randomUUID()
          previewUploads.set(id, { buffer, width, height, bytes: buffer.length, hasAlpha: meta.hasAlpha === true, mediaType: `image/${meta.format === 'jpg' ? 'jpeg' : meta.format ?? 'png'}` })
          while (previewUploads.size > PREVIEW_UPLOAD_ENTRIES) previewUploads.delete(previewUploads.keys().next().value)
          return previewJson(res, 200, { ok: true, id, width, height, bytes: buffer.length })
        } catch (error) {
          warn(ctx, `preview upload rejected: ${error instanceof Error ? error.message : String(error)}`)
          return previewJson(res, 400, { ok: false, error: 'image rejected' })
        }
      },
    }), 'read-image-compress: preview source route')
  })
}

//#endregion

export function apply(ctx, rawConfig) {
  // Validate once so a broken profile row fails loudly at activation. The
  // listener re-reads the volatile fields per call so settings changes apply
  // without waiting for a module reload.
  normalizeConfig(rawConfig)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.name !== 'read_image' || result?.isError === true) return next()

    let options
    try {
      options = normalizeConfig(rawConfig)
    } catch (error) {
      warnOnce(ctx, 'config', `invalid configuration: ${error instanceof Error ? error.message : String(error)}`)
      return next()
    }
    if (!options.enabled) return next()

    const value = result?.value
    const image = value?.image
    if (image === null || typeof image !== 'object') return next()

    let replacement
    try {
      replacement = await compressImage(ctx, image, options, exec.signal)
    } catch (error) {
      if (exec.signal?.aborted === true) throw error
      warn(ctx, `compression skipped: ${error instanceof Error ? error.message : String(error)}`)
      return next()
    }

    // Let other post-execute policies decide first; never fight a block or a
    // content/value replacement owned by someone else.
    const downstream = await next()
    if (replacement === undefined || downstream?.kind === 'block') return downstream
    if (Object.hasOwn(downstream ?? {}, 'content') || Object.hasOwn(downstream ?? {}, 'value')) return downstream

    const source = await sourceFacts(result?.meta, image, value.path)
    const content = compressedContent(result, value, replacement, options, source)
    if (content !== undefined) return { ...downstream, content }
    // The card could not be rebuilt without dropping an unknown content shape;
    // fall back to replacing only the canonical value.
    return { ...downstream, value: { path: value.path, image: replacement } }
  })

  installPreview(ctx, rawConfig)
}
