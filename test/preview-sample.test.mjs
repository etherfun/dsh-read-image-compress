import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SampleUnavailableError,
  bingImageUrl,
  githubSampleRoutes,
  loadSamplePhoto,
  parseRepository,
} from '../preview-sample.js'

const REPO = 'git+https://github.com/etherfun/dsh-read-image-compress.git'

/** A response shaped like the one `fetch` returns, without a network. */
const imageResponse = (bytes = 9000) => new Response(Buffer.alloc(bytes, 7), {
  status: 200,
  headers: { 'content-type': 'image/jpeg' },
})

const jsonResponse = (payload) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

/** A fetch stub that answers per URL prefix and records every call. */
function stubFetch(routes) {
  const calls = []
  const impl = async (url, init) => {
    calls.push(url)
    for (const [match, answer] of routes) {
      if (url.includes(match)) {
        const value = typeof answer === 'function' ? answer(url, init) : answer
        if (value instanceof Error) throw value
        return value
      }
    }
    throw new Error(`unexpected request: ${url}`)
  }
  return { impl, calls }
}

/** A route that never answers on its own and rejects only when aborted. */
const hangsUntilAborted = (url, init) => new Promise((resolve, reject) => {
  if (init?.signal?.aborted === true) {
    reject(new Error('aborted'))
    return
  }
  init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
})

test('parseRepository accepts every shape npm allows', () => {
  for (const value of [
    'git+https://github.com/etherfun/dsh-read-image-compress.git',
    'https://github.com/etherfun/dsh-read-image-compress',
    'http://github.com/etherfun/dsh-read-image-compress/',
    'git@github.com:etherfun/dsh-read-image-compress.git',
    'github:etherfun/dsh-read-image-compress',
    'etherfun/dsh-read-image-compress',
  ]) {
    assert.deepEqual(parseRepository(value), { owner: 'etherfun', repo: 'dsh-read-image-compress' }, value)
  }
})

test('parseRepository rejects values that name no GitHub repository', () => {
  for (const value of [undefined, null, '', '   ', 'https://gitlab.com/a/b', 'not a repository']) {
    assert.equal(parseRepository(value), undefined, String(value))
  }
})

test('githubSampleRoutes prefers the jsDelivr CDN, then raw GitHub', () => {
  const routes = githubSampleRoutes(REPO, 'v1')
  assert.equal(routes.length, 2)
  assert.equal(routes[0].id, 'jsdelivr')
  assert.ok(routes[0].url.startsWith('https://cdn.jsdelivr.net/gh/etherfun/dsh-read-image-compress@v1/'))
  assert.equal(routes[1].id, 'github')
  assert.ok(routes[1].url.startsWith('https://raw.githubusercontent.com/etherfun/dsh-read-image-compress/v1/'))
  for (const route of routes) assert.ok(route.url.endsWith('preview/sample.png'))
  assert.deepEqual(githubSampleRoutes(undefined), [])
})

test('bingImageUrl reads urlbase first and an absolute url second', () => {
  assert.equal(
    bingImageUrl({ images: [{ urlbase: '/th?id=OHR.Somewhere_ZH-CN123' }] }, 'UHD'),
    'https://www.bing.com/th?id=OHR.Somewhere_ZH-CN123_UHD.jpg',
  )
  assert.equal(
    bingImageUrl({ images: [{ url: '/th?id=OHR.Other_ZH-CN456&w=1920' }] }, 'UHD'),
    'https://www.bing.com/th?id=OHR.Other_ZH-CN456&w=1920',
  )
  assert.equal(bingImageUrl({ images: [] }), undefined)
  assert.equal(bingImageUrl({}), undefined)
  assert.equal(bingImageUrl(undefined), undefined)
})

test('loadSamplePhoto returns the GitHub sample from jsDelivr', async () => {
  const { impl, calls } = stubFetch([
    ['cdn.jsdelivr.net', imageResponse()],
    ['raw.githubusercontent.com', new Response('', { status: 404 })],
  ])
  const photo = await loadSamplePhoto({ repository: REPO, fetchImpl: impl, log: () => {} })
  assert.equal(photo.source, 'jsdelivr')
  assert.equal(photo.mediaType, 'image/jpeg')
  assert.equal(photo.buffer.length, 9000)
  assert.equal(calls.length, 2, 'both GitHub routes race for the same photo')
})

test('a failed CDN falls through to raw GitHub', async () => {
  const { impl, calls } = stubFetch([
    ['cdn.jsdelivr.net', new Response('', { status: 503 })],
    ['raw.githubusercontent.com', imageResponse()],
  ])
  const photo = await loadSamplePhoto({ repository: REPO, fetchImpl: impl, log: () => {} })
  assert.equal(photo.source, 'github')
  assert.equal(calls.length, 2)
})

test('a hanging CDN cannot delay the raw GitHub route', async () => {
  const { impl, calls } = stubFetch([
    ['cdn.jsdelivr.net', hangsUntilAborted],
    ['raw.githubusercontent.com', imageResponse()],
  ])
  const started = Date.now()
  const photo = await loadSamplePhoto({ repository: REPO, fetchImpl: impl, log: () => {} })
  assert.equal(photo.source, 'github')
  assert.ok(calls.some((url) => url.includes('cdn.jsdelivr.net')), 'both routes are requested in parallel')
  assert.ok(calls.some((url) => url.includes('raw.githubusercontent.com')))
  assert.ok(Date.now() - started < 1000, 'the hanging route must not hold the winner back')
})

test('Bing answers when both GitHub routes are down', async () => {
  const { impl, calls } = stubFetch([
    ['cdn.jsdelivr.net', new Error('socket hang up')],
    ['raw.githubusercontent.com', new Response('', { status: 404 })],
    ['HPImageArchive', jsonResponse({ images: [{ urlbase: '/th?id=OHR.Daily_ZH-CN1' }] })],
    ['_UHD.jpg', imageResponse(12000)],
  ])
  const photo = await loadSamplePhoto({ repository: REPO, fetchImpl: impl, log: () => {} })
  assert.equal(photo.source, 'bing')
  assert.equal(photo.url, 'https://www.bing.com/th?id=OHR.Daily_ZH-CN1_UHD.jpg')
  assert.equal(photo.buffer.length, 12000)
  assert.ok(calls.some((url) => url.includes('mkt=zh-CN')))
})

test('the UHD image falling back to 1920x1080 keeps the Bing route alive', async () => {
  const { impl } = stubFetch([
    ['cdn.jsdelivr.net', new Error('blocked')],
    ['raw.githubusercontent.com', new Error('blocked')],
    ['HPImageArchive', jsonResponse({ images: [{ urlbase: '/th?id=OHR.Fallback_EN-US9' }] })],
    ['_UHD.jpg', new Response('', { status: 403 })],
    ['_1920x1080.jpg', imageResponse()],
  ])
  const photo = await loadSamplePhoto({ repository: REPO, fetchImpl: impl, log: () => {} })
  assert.equal(photo.source, 'bing')
  assert.ok(photo.url.endsWith('_1920x1080.jpg'))
})

test('without a repository the loader goes straight to Bing', async () => {
  const { impl, calls } = stubFetch([
    ['HPImageArchive', jsonResponse({ images: [{ urlbase: '/th?id=OHR.Only_ZH-CN2' }] })],
    ['_UHD.jpg', imageResponse()],
  ])
  const photo = await loadSamplePhoto({ fetchImpl: impl })
  assert.equal(photo.source, 'bing')
  assert.equal(calls.length, 2)
  assert.ok(calls[0].includes('HPImageArchive'))
})

test('every source failing raises a coded error carrying the attempts', async () => {
  const { impl } = stubFetch([
    ['cdn.jsdelivr.net', new Error('timeout')],
    ['raw.githubusercontent.com', new Error('timeout')],
    ['HPImageArchive', new Error('blocked')],
  ])
  await assert.rejects(
    () => loadSamplePhoto({ repository: REPO, fetchImpl: impl, log: () => {} }),
    (error) => {
      assert.ok(error instanceof SampleUnavailableError)
      assert.equal(error.code, 'sample-unavailable')
      assert.ok(error.attempts.length >= 4, `expected every source in attempts, got ${error.attempts.length}`)
      return true
    },
  )
})

test('an exhausted budget never issues a request', async () => {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    throw new Error('must not be called')
  }
  await assert.rejects(
    () => loadSamplePhoto({ repository: REPO, fetchImpl: impl, githubTimeoutMs: 0, bingTimeoutMs: 0, log: () => {} }),
    (error) => {
      assert.ok(error instanceof SampleUnavailableError)
      for (const attempt of error.attempts) assert.match(attempt.reason, /budget ran out/)
      return true
    },
  )
  assert.equal(calls.length, 0)
})

test('a non-image answer is rejected rather than shown', async () => {
  const html = `<html>${'x'.repeat(9000)}</html>`
  const { impl } = stubFetch([
    ['cdn.jsdelivr.net', new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })],
    ['raw.githubusercontent.com', new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })],
    ['HPImageArchive', new Error('blocked')],
  ])
  await assert.rejects(
    () => loadSamplePhoto({ repository: REPO, fetchImpl: impl, log: () => {} }),
    (error) => error instanceof SampleUnavailableError
      && error.attempts.some((attempt) => /not an image/.test(attempt.reason)),
  )
})
