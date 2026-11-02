/**
 * Browser-half render tests.
 *
 * `client.js` is the settings card the Plugins page mounts: it registers one
 * `plugins.bundle.config` slot under the package name and pulls every label
 * from its own locale table. A wrong slot key makes the card vanish, and a
 * missing locale key prints the raw key, so both are asserted here.
 *
 * The test loads the file the way the module loader does and renders it with a
 * minimal hook runtime — state, effects and re-renders included — rather than a
 * DOM, so it runs in `node --test` without a browser or a bundled copy.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')

// --- minimal hook runtime ---------------------------------------------------
let hooks = []
let hookIndex = 0
let dirty = false
const effectQueue = []

const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState(initial) {
    const index = hookIndex++
    if (hooks[index] === undefined) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    const slot = hooks[index]
    return [slot.value, (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (value !== slot.value) {
        slot.value = value
        dirty = true
      }
    }]
  },
  useEffect(fn) {
    const key = `effect:${hookIndex++}`
    if (hooks[key] === undefined) {
      hooks[key] = true
      effectQueue.push(fn)
    }
  },
  useRef(value) {
    const key = `ref:${hookIndex++}`
    if (hooks[key] === undefined) hooks[key] = { current: value }
    return hooks[key]
  },
}

const captured = []
globalThis.window = {
  __ModuleLoader__: { load: (spec) => captured.push(spec) },
  addEventListener: () => {},
  removeEventListener: () => {},
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 1,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
}

await import(pathToFileURL(clientPath).href)
assert.equal(captured.length, 1, 'client.js should register exactly one module')

const requireFromBundle = (id) => {
  if (id === 'react') return React
  throw new Error(`the bundle should only require react, not ${id}`)
}
const plugin = captured[0].factory(requireFromBundle)

/** Collect every string the tree renders, expanding function components. */
const textOf = (node, out = [], depth = 0) => {
  if (node === null || node === undefined || node === false || depth > 60) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out, depth + 1)
    return out
  }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') {
      textOf(node.type(node.props), out, depth + 1)
      return out
    }
    for (const child of node.children ?? []) textOf(child, out, depth + 1)
  }
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Render a component until its state settles, running queued effects once.
 * @param Component - Function component to render.
 * @param props - Props for it.
 * @param settleMs - How long to wait for the effect's debounced work.
 */
async function render(Component, props, settleMs = 0) {
  hooks = []
  let text = ''
  for (let pass = 0; pass < 6; pass += 1) {
    hookIndex = 0
    dirty = false
    text = textOf(Component(props)).join(' ').replace(/\s+/g, ' ')
    if (pass === 0) {
      for (const fn of effectQueue.splice(0)) fn()
      if (settleMs > 0) await sleep(settleMs)
    }
    if (!dirty) break
  }
  return text
}

/** The settings document the host hands the card. */
const form = {
  getSnapshot: () => ({
    status: 'ready',
    writable: true,
    revision: 1,
    value: {
      enabled: true,
      compressResolution: true,
      compressBitrate: true,
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
      cacheEntries: 64,
      downscaleWebp: true,
      skipGif: true,
      summaryMode: 'detailed',
      summaryLanguage: 'zh',
    },
  }),
  subscribe: () => () => {},
  mutate: () => {},
}

const registered = []
let localeTable
let localeNamespace

plugin.apply({
  effect: (fn) => fn(),
  locale: {
    register: (namespace, table) => {
      localeNamespace = namespace
      localeTable = table
    },
  },
  configForms: { get: () => form, whileServed: (_namespaces, fn) => fn() },
  slots: { inject: (_name, fn) => fn(), register: (slotSpec, component) => registered.push({ slotSpec, component }) },
})

/** A preview payload with the shape the host returns. */
const payload = (source) => ({
  ok: true,
  cap: 1024,
  viewKey: 'key',
  passthrough: false,
  sample: { width: 3200, height: 2000, bytes: 1081752, source },
  variants: [
    { id: 'original', width: 3200, height: 2000, bytes: 1081752, tokens: 3746, capped: true, thumbnail: 'data:,', viewUrl: '/a' },
    { id: 'native', width: 2048, height: 1280, bytes: 416800, tokens: 1552, capped: true, thumbnail: 'data:,', viewUrl: '/b' },
    { id: 'plugin', width: 1568, height: 980, bytes: 287156, tokens: 938, capped: false, thumbnail: 'data:,', viewUrl: '/c' },
  ],
})

/** Point the card's preview request at a canned answer. */
function servePreview(body) {
  globalThis.fetch = async () => ({
    status: body.ok === true ? 200 : 503,
    ok: body.ok === true,
    json: async () => body,
  })
}

/** Render the card in one language and fail on any undefined locale key. */
async function cardText(language) {
  const table = localeTable[language]
  const t = (key) => table?.[key] ?? `@@MISSING:${key}`
  const text = await render(registered[0].component, { t }, 420)
  const missing = text.match(/@@MISSING:[\w.]+/g)
  assert.equal(missing, null, `undefined locale keys in ${language}: ${missing?.join(', ')}`)
  return text
}

test('registers one bundle-page card under the package name', () => {
  assert.equal(captured[0].id, 'dsh-read-image-compress')
  assert.equal(registered.length, 1)
  const { slotSpec } = registered[0]
  assert.equal(slotSpec.name, 'plugins.bundle.config')
  assert.equal(slotSpec.key, 'dsh-read-image-compress')
  assert.equal(slotSpec.id, 'dsh-read-image-compress')
  assert.equal(slotSpec.locale, localeNamespace)
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms'])
})

test('names the GitHub repository as the sample source', async () => {
  servePreview(payload('github'))
  assert.match(await cardText('en'), /Sample photo · GitHub repository/)
  assert.match(await cardText('zh'), /示例照片 · GitHub 仓库/)
})

test('names jsDelivr as the GitHub repository too', async () => {
  servePreview(payload('jsdelivr'))
  assert.match(await cardText('en'), /Sample photo · GitHub repository/)
  assert.match(await cardText('zh'), /示例照片 · GitHub 仓库/)
})

test('names the Bing daily wallpaper fallback', async () => {
  servePreview(payload('bing'))
  assert.match(await cardText('en'), /Sample photo · Bing daily wallpaper/)
  assert.match(await cardText('zh'), /示例照片 · Bing 每日壁纸/)
})

test('asks for an upload when no sample source answers', async () => {
  servePreview({ ok: false, error: 'sample-unavailable' })
  assert.match(await cardText('en'), /The sample photo could not be loaded/)
  assert.match(await cardText('zh'), /示例照片加载失败/)
})

test('keeps the endpoint error for every other failure', async () => {
  servePreview({ ok: false, error: 'preview unavailable' })
  assert.match(await cardText('en'), /The preview endpoint is unavailable/)
  assert.match(await cardText('zh'), /预览接口不可用/)
})

test('renders the three variants with real numbers in both languages', async () => {
  servePreview(payload('github'))
  for (const language of ['en', 'zh']) {
    const table = localeTable[language]
    const t = (key) => table?.[key] ?? `@@MISSING:${key}`
    const text = textOf(plugin.__components.PreviewGrid({ t, data: payload('github'), onOpen: () => {} }))
      .join(' ').replace(/\s+/g, ' ')
    assert.equal(text.match(/@@MISSING:[\w.]+/g), null)
    for (const token of ['3200×2000', '2048×1280', '1568×980', '3746', '1552', '938']) {
      assert.ok(text.includes(token), `${language} grid should show ${token}`)
    }
  }
})
