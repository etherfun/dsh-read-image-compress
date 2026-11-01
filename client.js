/**
 * Browser half of the read-image-compress bundle.
 *
 * The settings live on the bundle page itself (`plugins.bundle.config`), right
 * under the package description, instead of behind the row's Configure page.
 * The card binds the row's Host settings namespace through `ctx.configForms`,
 * so it reads and writes the same document the row form used to, and keeps the
 * staged-draft + revise-fenced save behaviour.
 */

window.__ModuleLoader__.load({
  id: 'dsh-read-image-compress',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'readImageCompress'
    const SETTINGS_NAMESPACE = 'read-image-compress'
    const BUNDLE = 'dsh-read-image-compress'

    const DEFAULTS = Object.freeze({
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
      cacheEntries: 128,
      downscaleWebp: true,
      skipGif: true,
      summaryMode: 'detailed',
      summaryLanguage: 'zh',
    })

    /** Adaptive B/KB/MB text for the preview cards. */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '—'
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

    /** Three side-by-side renderings of one sample photo. */
    const VARIANT_LABEL_KEYS = { original: 'variantOriginal', native: 'variantNative', plugin: 'variantPlugin' }

    /** Where the sample photo on screen came from, as the label under the picker. */
    const SAMPLE_SOURCE_KEYS = {
      local: 'previewSampleLocal',
      jsdelivr: 'previewSampleGithub',
      github: 'previewSampleGithub',
      bing: 'previewSampleBing',
    }

    /** The picker label: the uploaded file, or the sample and its provenance. */
    function sourceLabel(t, source, sample) {
      if (source !== undefined) return `${source.name ?? t('previewUploaded')} · ${source.width}×${source.height}`
      const key = SAMPLE_SOURCE_KEYS[sample?.source]
      return key === undefined ? t('previewUsingSample') : `${t('previewUsingSample')} · ${t(key)}`
    }

    /** The DeepSeek cap note: over, at, or none. */
    function tokenNote(variant, cap, t) {
      const ceiling = Number.isFinite(cap) ? cap : 1024
      if (variant.tokens > ceiling) return `（${t('previewTokenOver')}）`
      if (variant.tokens === ceiling) return `（${t('previewTokenCap')}）`
      return ''
    }

    function PreviewGrid({ t, data, onOpen }) {
      const label = (id) => id === 'plugin' && data.passthrough === true ? t('variantPluginOff') : t(VARIANT_LABEL_KEYS[id])
      return h('div', { style: styles.cards }, data.variants.map((variant) => h('figure', { key: variant.id, style: styles.card },
        h('figcaption', { style: styles.cardTitle }, label(variant.id)),
        h('img', {
          src: variant.thumbnail,
          alt: label(variant.id),
          title: t('previewZoomHint'),
          style: styles.cardImage,
          onClick: () => onOpen?.(variant),
        }),
        h('div', { style: styles.cardMeta }, `${variant.width}×${variant.height} · ${formatBytes(variant.bytes)}`),
        h('div', { style: styles.cardMeta }, `≈${variant.tokens} tokens${tokenNote(variant, data.cap, t)}`))))
    }

    /** Full-size look at one variant; click anywhere or Escape closes it. */
    /** The overlay viewport minus its padding and header; approximate but stable. */
    function viewportBox() {
      const width = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1280
      const height = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 800
      return { width: Math.max(240, width - 24), height: Math.max(180, height - 104) }
    }

    function ZoomOverlay({ t, variants, cap, variant, onClose, onSelect }) {
      const [fit, setFit] = React.useState(true)
      const [zoom, setZoom] = React.useState(1)
      const [box, setBox] = React.useState(viewportBox)
      const [dragging, setDragging] = React.useState(false)
      const bodyRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const movedRef = React.useRef(false)

      React.useEffect(() => {
        const update = () => setBox(viewportBox())
        window.addEventListener('resize', update)
        return () => window.removeEventListener('resize', update)
      }, [])

      React.useEffect(() => {
        if (variant === undefined) return undefined
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [variant, onClose])

      // A native listener, because React's wheel handler is passive and cannot
      // stop the scroll container from panning while the wheel zooms.
      React.useEffect(() => {
        const node = bodyRef.current
        if (node === null || node === undefined) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          setFit(false)
          setZoom((current) => Math.min(8, Math.max(0.2, current * (event.deltaY < 0 ? 1.12 : 1 / 1.12))))
        }
        node.addEventListener('wheel', onWheel, { passive: false })
        return () => node.removeEventListener('wheel', onWheel)
      }, [variant?.id])

      React.useEffect(() => {
        if (!dragging) return undefined
        const onMove = (event) => {
          const state = dragRef.current
          const node = bodyRef.current
          if (state === null || state === undefined || node === null || node === undefined) return
          if (Math.abs(event.clientX - state.x) > 3 || Math.abs(event.clientY - state.y) > 3) movedRef.current = true
          node.scrollLeft = state.left - (event.clientX - state.x)
          node.scrollTop = state.top - (event.clientY - state.y)
        }
        const onUp = () => {
          dragRef.current = null
          setDragging(false)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        return () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
      }, [dragging])

      if (variant === undefined) return null
      // Fit is always relative to the same viewport, so every variant starts at
      // the same on-screen size — a 931 px output and a 3200 px original are
      // directly comparable instead of showing one small and one large.
      const fitScale = Math.min(box.width / variant.width, box.height / variant.height)
      const scale = fit ? fitScale : fitScale * zoom
      const displayWidth = Math.max(1, Math.round(variant.width * scale))

      return h('div', {
        style: styles.overlay,
        onClick: () => {
          if (movedRef.current) {
            movedRef.current = false
            return
          }
          onClose()
        },
      },
        h('div', { style: styles.zoomBox, onClick: (event) => event.stopPropagation() },
          h('div', { style: styles.zoomHead },
            h('strong', null, t(VARIANT_LABEL_KEYS[variant.id])),
            h('span', { style: styles.zoomMeta }, `${variant.width}×${variant.height} · ${formatBytes(variant.bytes)} · ≈${variant.tokens} tokens · ${Math.round(scale * 100)}%${tokenNote(variant, cap, t)}`),
            h('div', { style: styles.zoomActions },
              (variants ?? []).map((entry) => h('button', {
                key: entry.id,
                type: 'button',
                style: entry.id === variant.id ? styles.primary : styles.secondary,
                onClick: () => { onSelect?.(entry) },
              }, t(VARIANT_LABEL_KEYS[entry.id]))),
              h('button', { type: 'button', style: styles.secondary, title: '−', onClick: () => { setFit(false); setZoom((current) => Math.max(0.2, current / 1.25)) } }, '−'),
              h('button', { type: 'button', style: styles.secondary, title: '+', onClick: () => { setFit(false); setZoom((current) => Math.min(8, current * 1.25)) } }, '+'),
              h('button', { type: 'button', style: styles.secondary, onClick: () => { setFit(false); setZoom(1 / (fitScale || 1)) } }, t('previewActualSize')),
              h('button', { type: 'button', style: styles.secondary, onClick: () => { setFit(true); setZoom(1) } }, t('previewFitWindow')),
              h('button', { type: 'button', style: styles.secondary, onClick: onClose }, t('previewClose')))),
          h('div', {
            style: { ...styles.zoomBody, cursor: dragging ? 'grabbing' : 'grab' },
            ref: bodyRef,
            onMouseDown: (event) => {
              if (event.button !== 0) return
              const node = bodyRef.current
              if (node === null || node === undefined) return
              dragRef.current = { x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop }
              movedRef.current = false
              setDragging(true)
              event.preventDefault()
            },
          },
            h('img', {
              src: variant.viewUrl ?? variant.large ?? variant.thumbnail,
              alt: t(VARIANT_LABEL_KEYS[variant.id]),
              draggable: false,
              style: { ...styles.zoomImage, width: `${displayWidth}px` },
            }))))
    }

    const DICT = {
      en: {
        title: 'Read image compression',
        summary: 'Compress read_image results before the session stores them.',
        description: 'Downscale and re-encode images read by read_image.',
        sectionQuick: 'Everyday settings',
        sectionAdvanced: 'Advanced',
        sectionPreview: 'Preview',
        previewHint: 'One real photo through three pipelines: as read, as the harness alone delivers it (2048² / 1 MiB), and as this plugin commits it with the settings below.',
        previewLoading: 'Rendering the preview…',
        previewError: 'The preview endpoint is unavailable',
        previewUsingSample: 'Sample photo',
        previewSampleLocal: 'local file',
        previewSampleGithub: 'GitHub repository',
        previewSampleBing: 'Bing daily wallpaper',
        previewSampleUnavailable: 'The sample photo could not be loaded. Upload a photo to preview the settings.',
        previewUploaded: 'Uploaded image',
        previewUploading: 'Uploading…',
        previewResetSample: 'Use the sample photo',
        previewZoomHint: 'Click to enlarge',
        previewClose: 'Close',
        previewActualSize: '1:1 pixels',
        previewFitWindow: 'Fit window',
        previewTokenCap: 'at the DeepSeek 1024-token cap',
        previewTokenOver: 'over the DeepSeek 1024-token cap; the server may recompress it',
        previewTokenHint: 'Tokens use the DeepSeek profile (1300×1300 ≈ 1024). Above that the estimate keeps growing so you can see how far over the cap an image is, even though DeepSeek bills at most 1024. Other models cap or scale differently.',
        previewOff: 'The footer is off, so this line will not appear when expanded.',
        variantOriginal: 'Original',
        variantNative: 'Native compression',
        variantPlugin: 'This plugin',
        variantPluginOff: 'This plugin (both modes off)',
        enabled: 'Enable compression',
        modeResolution: 'Compress resolution',
        modeBitrate: 'Compress bitrate',
        modeResolutionHint: 'Shrink the raster to the long-edge and pixel budget. Fewer pixels also means fewer image tokens.',
        modeBitrateHint: 'Re-encode down the quality ladder until the image fits the target bytes. Off keeps full fidelity — the source codec at quality 100, PNG lossless — so only the pixel count changes.',
        modeNone: 'Both modes are off: read_image results are stored exactly as read.',
        formatFidelityHint: 'While the bitrate mode is off, Auto keeps the source codec, so a PNG stays lossless.',
        quality: 'Quality (1–100)',
        resolutionScale: 'Resolution scale (0.1–1)',
        format: 'Output format',
        formatAuto: 'Auto (WebP for alpha, JPEG otherwise)',
        formatJpeg: 'JPEG (flattens alpha)',
        formatWebp: 'WebP',
        formatPng: 'PNG (lossless)',
        maxEdge: 'Maximum long edge (px)',
        maxPixels: 'Pixel budget (megapixels)',
        maxBytes: 'Target bytes (KiB)',
        minBytes: 'Skip images below (KiB)',
        minResizeScale: 'Minimum resize ratio',
        webpEffort: 'WebP effort (0–6)',
        jpegBackground: 'JPEG background',
        cacheEntries: 'In-memory cache entries',
        downscaleWebp: 'Downscale WebP results',
        skipGif: 'Skip GIF images',
        saveHint: 'Changes apply to the next read_image call; the expanded image ends with the original/compressed footer.',
        footerExample: 'Example: Original: 3200×2000 · 2.05 MB · PNG | Compressed: 1568×980 · 43.9 KB · JPEG | Ratio: 47.9× (bytes ↓97.9%, resolution ↓51.0%) | ≈938 tokens',
        sectionSummary: 'Result footer',
        summaryMode: 'Footer detail',
        summaryDetailed: 'Detailed — original, compressed, ratio',
        summaryCompact: 'Compact — one arrow line',
        summaryOff: 'Off — no footer text',
        summaryLanguage: 'Footer language',
        languageZh: 'Chinese',
        languageEn: 'English',
        save: 'Save',
        saving: 'Saving…',
        discard: 'Discard',
        saved: 'Saved — the next read_image call uses these settings',
        saveFailed: 'Could not save the settings',
        unavailable: 'The Host does not expose this configuration right now.',
        loading: 'Loading configuration…',
        readOnly: 'This configuration is read-only.',
        dirty: 'Unsaved changes',
      },
      zh: {
        title: '读图压缩',
        summary: '在会话保存前压缩 read_image 的结果。',
        description: '对 read_image 读取的图片降尺寸并重新编码。',
        sectionQuick: '常用设置',
        sectionAdvanced: '高级设置',
        sectionPreview: '预览',
        previewHint: '同一张真实照片的三种结果：原图、DSH 原生压缩（2048² / 1 MiB），以及本插件按下方设置提交的版本。',
        previewLoading: '正在生成预览…',
        previewError: '预览接口不可用',
        previewUsingSample: '示例照片',
        previewSampleLocal: '本地文件',
        previewSampleGithub: 'GitHub 仓库',
        previewSampleBing: 'Bing 每日壁纸',
        previewSampleUnavailable: '示例照片加载失败，可上传一张照片继续预览。',
        previewUploaded: '已上传的图片',
        previewUploading: '上传中…',
        previewResetSample: '恢复示例图',
        previewZoomHint: '点击放大',
        previewClose: '关闭',
        previewActualSize: '1:1 原始像素',
        previewFitWindow: '适应窗口',
        previewTokenCap: '已达 DeepSeek 单张 1024 tokens 上限',
        previewTokenOver: '大于 DeepSeek 单张 1024 tokens 上限，服务端可能二次压缩',
        previewTokenHint: 'token 按 DeepSeek 口径估算（1300×1300 ≈ 1024）；超过后估算仍按像素增长，用来显示超出上限多少（DeepSeek 实际最多按 1024 计费）。其他模型的上限与算法可能不同。',
        previewOff: '底部描述已关闭，展开时不会显示这一行。',
        variantOriginal: '原图',
        variantNative: '原生压缩',
        variantPlugin: '插件压缩',
        variantPluginOff: '插件压缩（两个模式都关闭）',
        enabled: '启用压缩',
        modeResolution: '压缩分辨率',
        modeBitrate: '压缩码率',
        modeResolutionHint: '把长边与总像素降到上限内。像素变少，图片占用的 token 也随之下降。',
        modeBitrateHint: '沿质量阶梯重新编码，直到落入目标字节。关闭后保持最高保真度 —— 沿用源编码、质量 100，PNG 无损 —— 所以只有像素数会变。',
        modeNone: '两个模式都关闭：read_image 的结果会原样保存。',
        formatFidelityHint: '码率压缩关闭时，「自动」沿用源编码，PNG 仍是无损。',
        quality: '质量（1–100）',
        resolutionScale: '分辨率缩放（0.1–1）',
        format: '输出格式',
        formatAuto: '自动（有 alpha 用 WebP，否则 JPEG）',
        formatJpeg: 'JPEG（会压平 alpha）',
        formatWebp: 'WebP',
        formatPng: 'PNG（无损）',
        maxEdge: '最大长边（px）',
        maxPixels: '像素上限（百万）',
        maxBytes: '目标字节（KiB）',
        minBytes: '小于此值跳过（KiB）',
        minResizeScale: '最小缩放比例',
        webpEffort: 'WebP 编码强度（0–6）',
        jpegBackground: 'JPEG 背景色',
        cacheEntries: '内存缓存条数',
        downscaleWebp: '允许缩小 WebP',
        skipGif: '跳过 GIF',
        saveHint: '修改在下一次 read_image 时生效；展开图片底部会显示原图与压缩后的对比。',
        footerExample: '示例：原图: 3200×2000 · 2.05 MB · PNG | 压缩后: 1568×980 · 43.9 KB · JPEG | 压缩比: 47.9×（体积 ↓97.9%，分辨率 ↓51.0%） | ≈938 tokens',
        sectionSummary: '结果描述',
        summaryMode: '底部描述',
        summaryDetailed: '详细 —— 原图、压缩后、压缩比',
        summaryCompact: '简洁 —— 单行箭头',
        summaryOff: '关闭 —— 不显示描述',
        summaryLanguage: '描述语言',
        languageZh: '中文',
        languageEn: 'English',
        save: '保存',
        saving: '保存中…',
        discard: '放弃修改',
        saved: '已保存 —— 下一次 read_image 生效',
        saveFailed: '设置保存失败',
        unavailable: '宿主当前没有提供这个配置。',
        loading: '正在读取配置…',
        readOnly: '此配置为只读。',
        dirty: '有未保存的修改',
      },
    }

    const styles = {
      root: { color: 'var(--dsw-alias-label-primary, #1f2328)', fontSize: '13px' },
      hint: { color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: '12px', margin: '0 0 14px' },
      section: { margin: '0 0 18px' },
      heading: {
        margin: '0 0 10px',
        fontSize: '12px',
        fontWeight: 600,
        letterSpacing: '0.02em',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
      },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'minmax(150px, 210px) minmax(0, 1fr)',
        gap: '9px 16px',
        alignItems: 'center',
      },
      label: { color: 'var(--dsw-alias-label-primary, #1f2328)' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-1, #d0d7de)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        font: 'inherit',
      },
      checkRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      modeLabel: {
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        cursor: 'pointer',
        fontSize: '12.5px',
        letterSpacing: 0,
        color: 'var(--dsw-alias-label-primary, #1f2328)',
      },
      gridOff: { opacity: 0.45 },
      warn: {
        margin: '0 0 12px',
        padding: '7px 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-warning, #9a6700)',
        color: 'var(--dsw-alias-warning, #9a6700)',
        fontSize: '12px',
      },
      actions: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px', flexWrap: 'wrap' },
      primary: {
        padding: '6px 14px',
        borderRadius: '6px',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-accent, #4d6bfe)',
        color: '#fff',
        font: 'inherit',
        cursor: 'pointer',
      },
      secondary: {
        padding: '6px 14px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-1, #d0d7de)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        font: 'inherit',
        cursor: 'pointer',
      },
      error: { color: 'var(--dsw-alias-danger, #d1242f)', marginTop: '8px' },
      notice: { color: 'var(--dsw-alias-label-secondary, #6b7280)', marginTop: '8px' },
      dirty: { color: 'var(--dsw-alias-warning, #9a6700)', marginTop: '8px' },
      example: {
        margin: '0 0 16px',
        padding: '8px 10px',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-layer-2, #f6f8fa)',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
        fontSize: '11.5px',
        lineHeight: 1.5,
        overflowX: 'auto',
      },
      cards: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '12px',
        margin: '0 0 16px',
      },
      card: { margin: 0, minWidth: 0 },
      cardTitle: { fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--dsw-alias-label-primary, #1f2328)' },
      cardImage: {
        display: 'block',
        width: '100%',
        height: 'auto',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-1, #d0d7de)',
        background: 'var(--dsw-alias-bg-layer-2, #f6f8fa)',
        marginBottom: '6px',
        cursor: 'zoom-in',
      },
      cardMeta: { fontSize: '11.5px', lineHeight: 1.45, color: 'var(--dsw-alias-label-secondary, #6b7280)' },
      sourceRow: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', margin: '0 0 12px' },
      fileInput: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #6b7280)' },
      sourceLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #6b7280)' },
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        padding: '12px',
        background: '#0b0d10',
        userSelect: 'none',
      },
      zoomBox: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        color: '#fff',
      },
      zoomHead: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      zoomMeta: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #9aa4b2)' },
      zoomActions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginLeft: 'auto' },
      zoomBody: {
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        textAlign: 'center',
        background: '#111418',
        borderRadius: '8px',
        padding: '8px',
      },
      zoomImage: {
        display: 'inline-block',
        verticalAlign: 'top',
        margin: 0,
        maxWidth: 'none',
        maxHeight: 'none',
        height: 'auto',
        background: '#fff',
      },
    }

    function merge(value) {
      return { ...DEFAULTS, ...(value ?? {}) }
    }

    function Field({ id, label, children }) {
      return h(React.Fragment, null,
        h('label', { htmlFor: id, style: styles.label }, label),
        children)
    }

    function NumberField({ id, label, value, min, max, step, onChange }) {
      return h(Field, { id, label },
        h('input', {
          id, type: 'number', value, min, max, step,
          style: styles.input,
          onChange: (event) => onChange(event.target.value),
        }))
    }

    function SettingsCard(props) {
      const { t, view, form } = props
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
      const [draft, setDraft] = React.useState(() => merge(form.getSnapshot().value))
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')

      React.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form])
      React.useEffect(() => {
        setDraft(merge(form.getSnapshot().value))
        setError('')
        setNotice('')
      }, [form, snapshot.revision])

      const [preview, setPreview] = React.useState({ status: 'loading', data: undefined })
      const [source, setSource] = React.useState(undefined)
      const [uploadBusy, setUploadBusy] = React.useState(false)
      const [zoom, setZoom] = React.useState(undefined)
      const previewKey = JSON.stringify({
        sourceId: source?.id ?? null,
        settings: {
          compressResolution: draft.compressResolution,
          compressBitrate: draft.compressBitrate,
          quality: draft.quality,
          resolutionScale: draft.resolutionScale,
          format: draft.format,
          maxEdge: draft.maxEdge,
          maxPixels: draft.maxPixels,
          maxBytes: draft.maxBytes,
          minResizeScale: draft.minResizeScale,
          webpEffort: draft.webpEffort,
          jpegBackground: draft.jpegBackground,
          downscaleWebp: draft.downscaleWebp,
        },
      })
      React.useEffect(() => {
        // A field being cleared mid-edit is not a request; keep the last preview.
        const numeric = ['quality', 'resolutionScale', 'maxEdge', 'maxPixels', 'maxBytes', 'minBytes', 'minResizeScale', 'webpEffort']
        if (!numeric.every((key) => draft[key] !== '' && Number.isFinite(Number(draft[key])))) return undefined
        const controller = new AbortController()
        const timer = setTimeout(() => {
          setPreview((current) => ({ status: current.data === undefined ? 'loading' : 'refreshing', data: current.data }))
          fetch('/api/read-image-compress/preview', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: previewKey,
            credentials: 'same-origin',
            signal: controller.signal,
          })
            .then((response) => response.json().catch(() => ({})).then((data) => ({ response, data })))
            .then(({ response, data }) => {
              if (data?.ok === true) {
                setPreview({ status: 'ready', data })
                return
              }
              // The host reports why: an unusable sample photo must not read as
              // an unreachable endpoint, because the fix is to upload a photo.
              throw new Error(typeof data?.error === 'string' && data.error !== '' ? data.error : `HTTP ${response.status}`)
            })
            .catch((failure) => {
              if (failure?.name !== 'AbortError') setPreview({ status: 'error', data: undefined, detail: failure instanceof Error ? failure.message : 'network error' })
            })
        }, 300)
        return () => {
          clearTimeout(timer)
          controller.abort()
        }
      }, [previewKey])

      if (view === 'summary') return h('span', null, t('summary'))
      if (snapshot.status === 'loading') {
        return h('p', { style: styles.hint }, t('loading'))
      }
      if (snapshot.status === 'unavailable') {
        return h('p', { style: styles.hint }, t('unavailable'))
      }
      if (snapshot.writable === false) {
        return h('p', { style: styles.hint }, t('readOnly'))
      }

      const set = (key) => (value) => setDraft((current) => ({ ...current, [key]: value }))
      const setNumber = (key) => (raw) => setDraft((current) => ({ ...current, [key]: raw === '' ? '' : Number(raw) }))
      const setKib = (key) => (raw) => setDraft((current) => ({ ...current, [key]: raw === '' ? '' : Math.round(Number(raw) * 1024) }))
      const setMegapixels = (key) => (raw) => setDraft((current) => ({ ...current, [key]: raw === '' ? '' : Math.round(Number(raw) * 1000000) }))

      const dirty = JSON.stringify(draft) !== JSON.stringify(merge(snapshot.value))
      const canSave = !busy && dirty

      const save = async () => {
        if (!canSave) return
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const ops = Object.entries(draft).map(([key, value]) => ({ op: 'set', path: [key], value }))
          const ok = await form.mutate(ops, snapshot.revision)
          if (!ok) setError(t('saveFailed'))
          else setNotice(t('saved'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const discard = () => {
        setDraft(merge(form.getSnapshot().value))
        setError('')
        setNotice('')
      }

      const section = (title, rows) => h('section', { style: styles.section },
        h('h4', { style: styles.heading }, title),
        h('div', { style: styles.grid }, rows))

      /** A stage of the pipeline: its own checkbox in the heading, its knobs below. */
      const modeSection = ({ key, id, title, hint, rows }) => h('section', { style: styles.section },
        h('h4', { style: styles.heading },
          h('label', { htmlFor: id, style: styles.modeLabel },
            h('input', {
              id,
              type: 'checkbox',
              checked: draft[key] === true,
              onChange: (event) => set(key)(event.target.checked),
            }),
            h('span', null, title))),
        h('p', { style: styles.hint }, hint),
        h('div', { style: draft[key] === true ? styles.grid : { ...styles.grid, ...styles.gridOff } }, rows))

      const uploadPreviewSource = async (event) => {
        const file = event?.target?.files?.[0]
        if (file === undefined) return
        setUploadBusy(true)
        setPreview({ status: 'loading', data: undefined })
        try {
          const bytes = await file.arrayBuffer()
          const response = await fetch('/api/read-image-compress/source', {
            method: 'POST',
            headers: { 'content-type': file.type || 'application/octet-stream' },
            body: bytes,
          })
          const data = await response.json().catch(() => undefined)
          if (data?.ok !== true) throw new Error(`HTTP ${response.status}`)
          setSource({ id: data.id, name: file.name, width: data.width, height: data.height })
        } catch (failure) {
          setPreview({ status: 'error', data: undefined, detail: failure instanceof Error ? failure.message : 'upload failed' })
        } finally {
          setUploadBusy(false)
        }
      }

      const previewSection = h('section', { style: styles.section },
        h('h4', { style: styles.heading }, t('sectionPreview')),
        h('p', { style: styles.hint }, t('previewHint')),
        h('div', { style: styles.sourceRow },
          h('input', {
            id: 'ric-preview-file',
            type: 'file',
            accept: 'image/*',
            style: styles.fileInput,
            disabled: uploadBusy,
            onChange: uploadPreviewSource,
          }),
          h('span', { style: styles.sourceLabel }, sourceLabel(t, source, preview.data?.sample)),
          source === undefined ? null : h('button', { type: 'button', style: styles.secondary, onClick: () => setSource(undefined) }, t('previewResetSample'))),
        preview.status === 'error'
          ? h('p', { style: styles.error }, preview.detail === 'sample-unavailable'
            ? t('previewSampleUnavailable')
            : preview.detail === undefined ? t('previewError') : `${t('previewError')}（${preview.detail}）`)
          : preview.data === undefined
            ? h('p', { style: styles.hint }, uploadBusy ? t('previewUploading') : t('previewLoading'))
            : h(PreviewGrid, { t, data: preview.data, onOpen: setZoom }),
        h(ZoomOverlay, {
          t,
          variants: preview.data?.variants,
          cap: preview.data?.cap,
          variant: zoom,
          onClose: () => setZoom(undefined),
          onSelect: setZoom,
        }),
        h('p', { style: styles.hint }, t('previewTokenHint')),
        draft.summaryMode === 'off' ? h('p', { style: styles.hint }, t('previewOff')) : null)

      const bothModesOff = draft.enabled === true && draft.compressResolution !== true && draft.compressBitrate !== true

      return h('div', { style: styles.root },
        h('p', { style: styles.hint }, t('saveHint')),
        bothModesOff ? h('p', { style: styles.warn }, t('modeNone')) : null,
        h('p', { style: styles.example }, t('footerExample')),

        section(t('sectionQuick'), [
          h(Field, { key: 'enabled', id: 'ric-enabled', label: t('enabled') },
            h('div', { style: styles.checkRow },
              h('input', { id: 'ric-enabled', type: 'checkbox', checked: draft.enabled, onChange: (e) => set('enabled')(e.target.checked) }))),
          h(Field, { key: 'format', id: 'ric-format', label: t('format') },
            h('select', {
              id: 'ric-format', value: draft.format, style: styles.input,
              onChange: (e) => set('format')(e.target.value),
            },
              h('option', { value: 'auto' }, t('formatAuto')),
              h('option', { value: 'jpeg' }, t('formatJpeg')),
              h('option', { value: 'webp' }, t('formatWebp')),
              h('option', { value: 'png' }, t('formatPng')))),
          draft.format === 'webp'
            ? h(NumberField, { key: 'webpEffort', id: 'ric-effort', label: t('webpEffort'), value: draft.webpEffort, min: 0, max: 6, step: 1, onChange: setNumber('webpEffort') })
            : null,
          draft.format === 'jpeg'
            ? h(Field, { key: 'jpegBackground', id: 'ric-background', label: t('jpegBackground') },
                h('input', {
                  id: 'ric-background', type: 'color', value: draft.jpegBackground, style: styles.input,
                  onChange: (e) => set('jpegBackground')(e.target.value),
                }))
            : null,
          draft.compressBitrate === false
            ? h('p', { key: 'format-fidelity', style: { ...styles.hint, margin: 0, gridColumn: '1 / -1' } }, t('formatFidelityHint'))
            : null,
          h(Field, { key: 'summaryMode', id: 'ric-summary-mode', label: t('summaryMode') },
            h('select', {
              id: 'ric-summary-mode', value: draft.summaryMode, style: styles.input,
              onChange: (e) => set('summaryMode')(e.target.value),
            },
              h('option', { value: 'detailed' }, t('summaryDetailed')),
              h('option', { value: 'compact' }, t('summaryCompact')),
              h('option', { value: 'off' }, t('summaryOff')))),
          h(Field, { key: 'summaryLanguage', id: 'ric-summary-language', label: t('summaryLanguage') },
            h('select', {
              id: 'ric-summary-language', value: draft.summaryLanguage, style: styles.input,
              onChange: (e) => set('summaryLanguage')(e.target.value),
            },
              h('option', { value: 'zh' }, t('languageZh')),
              h('option', { value: 'en' }, t('languageEn')))),
        ]),

        modeSection({
          key: 'compressResolution',
          id: 'ric-mode-resolution',
          title: t('modeResolution'),
          hint: t('modeResolutionHint'),
          rows: [
            h(NumberField, { key: 'resolutionScale', id: 'ric-scale', label: t('resolutionScale'), value: draft.resolutionScale, min: 0.1, max: 1, step: 0.05, onChange: setNumber('resolutionScale') }),
            h(NumberField, { key: 'maxEdge', id: 'ric-max-edge', label: t('maxEdge'), value: draft.maxEdge, min: 64, max: 8192, step: 1, onChange: setNumber('maxEdge') }),
            h(NumberField, { key: 'maxPixels', id: 'ric-max-pixels', label: t('maxPixels'), value: Math.round(Number(draft.maxPixels) / 10000) / 100, min: 0.01, step: 0.01, onChange: setMegapixels('maxPixels') }),
            h(NumberField, { key: 'minResizeScale', id: 'ric-min-resize', label: t('minResizeScale'), value: draft.minResizeScale, min: 0.1, max: 1, step: 0.05, onChange: setNumber('minResizeScale') }),
          ],
        }),

        modeSection({
          key: 'compressBitrate',
          id: 'ric-mode-bitrate',
          title: t('modeBitrate'),
          hint: t('modeBitrateHint'),
          rows: [
            h(NumberField, { key: 'quality', id: 'ric-quality', label: t('quality'), value: draft.quality, min: 1, max: 100, step: 1, onChange: setNumber('quality') }),
            h(NumberField, { key: 'maxBytes', id: 'ric-max-bytes', label: t('maxBytes'), value: Math.round(Number(draft.maxBytes) / 1024), min: 1, step: 1, onChange: setKib('maxBytes') }),
          ],
        }),

        section(t('sectionAdvanced'), [
          h(NumberField, { key: 'minBytes', id: 'ric-min-bytes', label: t('minBytes'), value: Math.round(Number(draft.minBytes) / 1024), min: 0, step: 1, onChange: setKib('minBytes') }),
          h(NumberField, { key: 'cacheEntries', id: 'ric-cache', label: t('cacheEntries'), value: draft.cacheEntries, min: 0, max: 4096, step: 1, onChange: setNumber('cacheEntries') }),
          h(Field, { key: 'downscaleWebp', id: 'ric-downscale-webp', label: t('downscaleWebp') },
            h('div', { style: styles.checkRow },
              h('input', { id: 'ric-downscale-webp', type: 'checkbox', checked: draft.downscaleWebp, onChange: (e) => set('downscaleWebp')(e.target.checked) }))),
          h(Field, { key: 'skipGif', id: 'ric-skip-gif', label: t('skipGif') },
            h('div', { style: styles.checkRow },
              h('input', { id: 'ric-skip-gif', type: 'checkbox', checked: draft.skipGif, onChange: (e) => set('skipGif')(e.target.checked) }))),
        ]),

        previewSection,

        h('div', { style: styles.actions },
          h('button', { type: 'button', style: styles.primary, disabled: !canSave, onClick: save }, busy ? t('saving') : t('save')),
          h('button', { type: 'button', style: styles.secondary, disabled: busy || !dirty, onClick: discard }, t('discard'))),

        error === '' ? null : h('p', { style: styles.error }, error),
        notice === '' ? null : h('p', { style: styles.notice }, notice),
        dirty ? h('p', { style: styles.dirty }, t('dirty')) : null,
      )
    }

    return {
      // Exposed for the offline test harness only; the module loader ignores it.
      __components: { PreviewGrid, ZoomOverlay },
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT))

        // The row's Host settings namespace is the single document; bind it
        // once and hand the same form to the bundle-page card.
        const form = ctx.configForms.get(SETTINGS_NAMESPACE)
        const Card = (props) => h(SettingsCard, { ...props, form })

        ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NAMESPACE], () =>
          ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
            name: 'plugins.bundle.config',
            key: BUNDLE,
            id: BUNDLE,
            locale: NS,
          }, Card))))
      },
    }
  },
})
