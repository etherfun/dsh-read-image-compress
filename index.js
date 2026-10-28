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

import path from 'node:path'
import { stat } from 'node:fs/promises'
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

function targetFor(image, options) {
  const longEdge = Math.max(image.width, image.height)
  const desired = Math.max(1, Math.min(options.maxEdge, Math.round(longEdge * options.resolutionScale)))
  const scale = desired / longEdge
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
  const raster = (width, height) => `${width}×${height}`

  if (options.summaryMode === 'compact') {
    const left = `${raster(source.width, source.height)}${sourceSize === undefined ? '' : ` ${sourceSize}`}`
    const right = `${raster(replacement.width, replacement.height)}${compressedSize === undefined ? '' : ` ${compressedSize}`}`
    return multiplier === undefined ? `${left} → ${right}` : `${left} → ${right} · ${multiplier}`
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
    return `原图: ${sourceParts.join(' · ')} | 压缩后: ${compressedParts.join(' · ')}${ratio === undefined ? '' : ` | 压缩比: ${ratio}`}`
  }
  return `Original: ${sourceParts.join(' · ')} | Compressed: ${compressedParts.join(' · ')}${ratio === undefined ? '' : ` | Ratio: ${ratio}`}`
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
}
