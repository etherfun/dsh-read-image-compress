# @local/dsh-read-image-compress

A DSH bundle that post-processes the built-in `read_image` tool. The host half
listens on `tools/post-execute`; the browser half adds a configuration page to
the row on the **Plugins** sidebar page.

For a successful `read_image` result it:

1. reads the stored attachment and encodes it with the installation's own
   `sharp`/libvips (`quality`, `format`, `resolutionScale`, byte target);
2. commits the derived bytes with `ctx.attachments.saveImage()`;
3. replaces the result **content** — the recognized image envelope, the image
   block pointing at the smaller attachment, and a trailing footer text block —
   so the conversation card, the next model request, and the session history all
   use the smaller object, and the expanded card ends with a one-line comparison.

If Sharp cannot be resolved from the running installation, it falls back to
`ctx.attachments.readImageRequest()`; the plugin still compresses, but the
`quality` and `format` settings are ignored in that mode.

## The footer line

Expanding a `read_image` row shows the path, the built-in size line, and then
the footer the plugin appends below the gallery:

```text
原图: 4096×2600 · 3.90 MB · PNG | 压缩后: 1568×996 · 255 KB · WebP | 压缩比: 15.7×（体积 ↓93.7%，分辨率 ↓61.7%） | ≈938 tokens
```

- **原图** is the file as read: `originalDimensions` when the attachment store
  normalized a larger source, otherwise the attachment raster; the byte count is
  the on-disk file size recovered with a best-effort `stat` of the display path,
  and the format label comes from the file extension because admission may have
  re-encoded the source (a PNG can be committed as JPEG).
- **压缩后** is the committed attachment the gallery displays.
- **压缩比** is `original bytes / compressed bytes`, followed by the byte delta
  and how much resolution was shed (1 − compressed long edge ÷ original long
  edge), so both the byte saving and the visible detail loss are explicit.
- **≈N tokens** reproduces DeepSeek's official image-token calculator: 14 px
  patches downsampled 3×, one image capped at **1024** tokens, rasters below
  544² upscaled first. The number shown is the *uncapped* estimate, so an
  oversized raster shows how far past the cap it is, and the note says the
  server may recompress it (`（大于 … 1024 tokens 上限，服务端可能二次压缩）`).
  This is DeepSeek's
  model — other providers cap or scale differently, so treat it as a reference,
  not a portable price. Reference values from the same algorithm: 1568×980 →
  938, 1300×1300 → 994, 1920×1080 → 968 charged (1224 uncapped), 3200×2000 →
  962 charged (3746 uncapped).

### Preview

The settings card renders the plugin's bundled sample photo through three real
pipelines, side by side, on every draft change (debounced):

| Variant | What it is |
|---|---|
| 原图 / Original | the sample as read: 3200×2000, JPEG q92 |
| 原生压缩 / Native | what the harness alone delivers — fit inside 2048², JPEG quality ladder down to 1 MiB |
| 插件压缩 / This plugin | the same photo encoded with the current `maxEdge` / `maxPixels` / `resolutionScale` / `format` / `quality` |

Each column shows a 560 px thumbnail, the true raster and byte size, and the
estimated token cost. The numbers come from the Host, not the browser: the
plugin registers `POST /api/read-image-compress/preview`, which runs the same
`sharp` build as the hook, so the sizes match what `read_image` would commit.
The route caches the last six drafts.

Click a thumbnail to open a full-screen viewer: the **actual bytes** of that
variant are served by `GET /api/read-image-compress/preview/image`. It opens
fit-to-window — every variant is scaled to the same viewport box, and because
fit also enlarges, a 900 px output and a 3200 px original compare at the same
size instead of one looking small. The wheel zooms around that fit scale
(0.2×–8×), `−`/`+` step it, **1:1** shows native pixels where compression
artifacts are clearest, and the left mouse button drags the enlarged image
around. Switching variants keeps the current zoom, so the comparison stays at
the same magnification; Escape closes.

**Bring your own photo.** `POST /api/read-image-compress/source` accepts raw
image bytes and returns an id; the card then sends that id with each preview
request. Four uploads stay in memory; the file input and **Use the bundled
sample** button sit above the grid. Uploads are decoded with a 64 MP ceiling and
a 16 MiB body limit.

`summaryMode: off` is called out under the grid; `values` that are mid-edit
(an emptied number field) simply keep the previous preview until they parse.

### Why the pixel budget

The provider tokenizes every image by its pixels, not by its file size: a small
image is upscaled toward roughly 544×544 and a large one is downscaled toward
roughly 1300×1300 before it is billed, with a cap of about 1024 tokens per
image. A long-edge-only cap therefore still lets a square image cost the full
budget (1568×1568 is 2.4 MP), while anything above ~1.69 MP buys no extra tokens.

`maxPixels` defaults to `1690000` (1300×1300), so the committed image already
sits at or below the provider's own target: same tokens, fewer bytes, less
decode time. Raise it when small details matter more than tokens; lower it with
`resolutionScale` or a smaller budget when they do not.

`summaryMode: compact` produces `4096×2600 3.90 MB → 1568×996 255 KB · 15.7×`;
`summaryMode: off` removes the footer entirely. `summaryLanguage` switches the
labels between Chinese and English. Skipped images (already small, GIFs) get no
footer because nothing was re-encoded.

The same text also stays in the model-facing content as a plain text block, so
the model sees the compressed raster beside the file facts. The envelope DSH
produced (`<path>`, `<type>`, `<content>`, `</content>`) is passed through
untouched; only the image block is repointed at the committed attachment, which
keeps the conversation card recognizing the block and keeps the model-facing
text exactly as the tool reported it.

## Settings

Open **Plugins** in the sidebar and click the `@local/dsh-read-image-compress`
bundle. The settings card sits directly under the package description — no
second-level **Configure** page — and saves as one atomic mutation; the next
`read_image` call uses the new values. The same fields are valid in
`cordis.patch.yml`:

```yaml
- id: read-image-compress
  config:
    enabled: true
    quality: 85
    resolutionScale: 1
    format: auto
    maxEdge: 1568
    maxPixels: 1690000
    maxBytes: 524288
    minBytes: 131072
    minResizeScale: 0.9
    webpEffort: 4
    jpegBackground: '#ffffff'
    cacheEntries: 128
    downscaleWebp: true
    skipGif: true
    summaryMode: detailed
    summaryLanguage: zh
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Stop post-processing without removing the plugin. |
| `quality` | `85` | 1–100 for JPEG/WebP. Lower is smaller. PNG ignores it. |
| `resolutionScale` | `1` | Extra long-edge scale relative to the source, 0.1–1. Combined with `maxEdge` via the smaller target. |
| `format` | `auto` | `auto` (WebP for alpha, JPEG otherwise), `jpeg`, `webp`, or `png`. |
| `maxEdge` | `1568` | Absolute long-edge cap in pixels. |
| `maxPixels` | `1690000` | Total-pixel budget, about 1300×1300. Together with `maxEdge` and `resolutionScale` it is an upper bound; the smallest wins. |
| `maxBytes` | `524288` | Byte target. JPEG/WebP quality steps down from `quality` toward 40 until the output fits; PNG cannot be constrained this way. |
| `minBytes` | `131072` | Skip images that need no resize and are already smaller than this. |
| `minResizeScale` | `0.9` | Only resize when the target long edge is at most 90% of the source; avoids marginal downscales that can increase bytes. |
| `webpEffort` | `4` | WebP encoder effort, 0–6. Higher is smaller/slower. |
| `jpegBackground` | `#ffffff` | Background used when `format: jpeg` flattens an alpha image. |
| `cacheEntries` | `128` | In-memory LRU of derived references keyed by source + settings; `0` disables it. |
| `downscaleWebp` | `true` | Allow WebP inputs to be resized when they exceed the target. |
| `skipGif` | `true` | Leave GIFs alone; setting it to `false` encodes the first frame only. |
| `summaryMode` | `detailed` | Footer detail: `detailed`, `compact`, or `off`. |
| `summaryLanguage` | `zh` | Footer labels: `zh` or `en`. |

All fields are `.volatile()`, so changing them from the page updates the running
plugin on the next `read_image` call without a reload.

## Behaviour and limits

- PNG is the main target: a 714 KB opaque screenshot becomes a ~100 KB JPEG at
  the default settings; a 3.97 MB alpha screenshot becomes a 1568×996 WebP at
  roughly 255–287 KB depending on the encoder.
- `format: jpeg` flattens alpha onto `jpegBackground` and loses transparency.
  `auto` keeps WebP for alpha.
- `format: png` is lossless; `maxBytes` and `quality` do not shrink it. It is
  useful only when lossless output is required.
- Only new `read_image` calls are affected; existing attachments and history are
  immutable.
- The hook adds one decode+encode pass per compressed read. The in-memory cache
  avoids repeating that work for the same source and settings within one host
  process.
- With Sharp, the encoder does not create a `request-images` cache entry; the
  derived attachment (≤ the request target) passes through the provider request
  projection. The fallback path does create the store's source variant cache.
- The plugin defers to other `tools/post-execute` policies: it never replaces a
  result another listener blocked or replaced.
- Replacing content (not the canonical value) is what allows the footer text:
  `tools/post-execute` forbids one decision from replacing both. The value keeps
  the original reference; everything rendered and sent uses the content.

## Layout

```text
index.js            host half: tools/post-execute hook, Sharp encoder, footer
client.js           browser half: bundle-page settings card (plugins.bundle.config)
cordis.patch.yml    bundle insert row and default config
locale/{en,zh}.json bundle metadata strings
preview/sample.png  the real photo behind the settings preview
                    (uploads are in-memory only, never written)
docs/design.md      architecture, contracts, and the hook rationale
docs/benchmark.md   measured compression ratio, quality loss, and cache results
```

## Install in this profile

```powershell
dsh plugin --profile web add "link:F:\dev\github\dsh-read-image-compress"
```

The package declares `dsh.bundle.patch`, so DSH also adds it to
`dsh.profile.bundles`; the bundle's `cordis.patch.yml` inserts the row. A
profile override under the same `read-image-compress` id is the writable config
layer used by the settings page.
