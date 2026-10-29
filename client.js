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
  id: '@local/dsh-read-image-compress',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'readImageCompress'
    const SETTINGS_NAMESPACE = 'read-image-compress'
    const BUNDLE = '@local/dsh-read-image-compress'

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

    /** The provider normalizes an image to 544²..1300² before billing it and caps one image at 1024 tokens. */
    const MIN_BILLED_PIXELS = 544 * 544
    const MAX_BILLED_PIXELS = 1300 * 1300
    const IMAGE_TOKEN_CAP = 1024
    const SAMPLE = Object.freeze({ width: 3200, height: 2000 })

    /** The per-image token estimate the provider's stated rule implies. */
    function estimateTokens(width, height) {
      const area = width * height
      if (!(area > 0)) return 0
      const billed = Math.min(MAX_BILLED_PIXELS, Math.max(MIN_BILLED_PIXELS, area))
      return Math.max(1, Math.round((billed / MAX_BILLED_PIXELS) * IMAGE_TOKEN_CAP))
    }

    /** The raster the current draft would produce for the sample image. */
    function previewTarget(draft) {
      const { width, height } = SAMPLE
      const longEdge = Math.max(width, height)
      const area = width * height
      const maxPixels = Number(draft.maxPixels)
      const maxEdge = Number(draft.maxEdge)
      const resolutionScale = Number(draft.resolutionScale)
      // A field the person is midway through clearing is not a target; keep the
      // sample untouched until it parses again.
      if (!(maxPixels > 0) || !(maxEdge > 0) || !(resolutionScale > 0)) return { width, height }
      const scale = Math.min(1, resolutionScale, maxEdge / longEdge, Math.sqrt(maxPixels / area))
      if (!(scale < 1 && scale <= Number(draft.minResizeScale))) return { width, height }
      return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
    }

    const DICT = {
      en: {
        title: 'Read image compression',
        summary: 'Compress read_image results before the session stores them.',
        description: 'Downscale and re-encode images read by read_image.',
        sectionQuick: 'Everyday settings',
        sectionAdvanced: 'Advanced',
        sectionPreview: 'Preview',
        previewRaster: 'Sample {width}×{height} → {outWidth}×{outHeight}',
        previewMeta: 'resolution ↓{percent}% · ≈{tokens} tokens (per-image cap 1024)',
        previewOff: 'The footer is off, so this line will not appear when expanded.',
        enabled: 'Enable compression',
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
        footerExample: 'Example: Original: 3200×2000 · 2.05 MB · PNG | Compressed: 1568×980 · 43.9 KB · JPEG | Ratio: 47.9× (bytes ↓97.9%, resolution ↓51.0%) | ≈931 tokens',
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
        previewRaster: '示例 {width}×{height} → 压缩后 {outWidth}×{outHeight}',
        previewMeta: '分辨率 ↓{percent}% · 预计 ≈{tokens} tokens（单图上限 1024）',
        previewOff: '底部描述已关闭，展开时不会显示这一行。',
        enabled: '启用压缩',
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
        footerExample: '示例：原图: 3200×2000 · 2.05 MB · PNG | 压缩后: 1568×980 · 43.9 KB · JPEG | 压缩比: 47.9×（体积 ↓97.9%，分辨率 ↓51.0%） | ≈931 tokens',
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

      return h('div', { style: styles.root },
        h('p', { style: styles.hint }, t('saveHint')),
        h('p', { style: styles.example }, t('footerExample')),

        section(t('sectionQuick'), [
          h(Field, { key: 'enabled', id: 'ric-enabled', label: t('enabled') },
            h('div', { style: styles.checkRow },
              h('input', { id: 'ric-enabled', type: 'checkbox', checked: draft.enabled, onChange: (e) => set('enabled')(e.target.checked) }))),
          h(NumberField, { key: 'quality', id: 'ric-quality', label: t('quality'), value: draft.quality, min: 1, max: 100, step: 1, onChange: setNumber('quality') }),
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
          h(NumberField, { key: 'resolutionScale', id: 'ric-scale', label: t('resolutionScale'), value: draft.resolutionScale, min: 0.1, max: 1, step: 0.05, onChange: setNumber('resolutionScale') }),
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

        section(t('sectionAdvanced'), [
          h(NumberField, { key: 'maxEdge', id: 'ric-max-edge', label: t('maxEdge'), value: draft.maxEdge, min: 64, max: 8192, step: 1, onChange: setNumber('maxEdge') }),
          h(NumberField, { key: 'maxPixels', id: 'ric-max-pixels', label: t('maxPixels'), value: Math.round(Number(draft.maxPixels) / 10000) / 100, min: 0.01, step: 0.01, onChange: setMegapixels('maxPixels') }),
          h(NumberField, { key: 'maxBytes', id: 'ric-max-bytes', label: t('maxBytes'), value: Math.round(Number(draft.maxBytes) / 1024), min: 1, step: 1, onChange: setKib('maxBytes') }),
          h(NumberField, { key: 'minBytes', id: 'ric-min-bytes', label: t('minBytes'), value: Math.round(Number(draft.minBytes) / 1024), min: 0, step: 1, onChange: setKib('minBytes') }),
          h(NumberField, { key: 'minResizeScale', id: 'ric-min-resize', label: t('minResizeScale'), value: draft.minResizeScale, min: 0.1, max: 1, step: 0.05, onChange: setNumber('minResizeScale') }),
          h(NumberField, { key: 'cacheEntries', id: 'ric-cache', label: t('cacheEntries'), value: draft.cacheEntries, min: 0, max: 4096, step: 1, onChange: setNumber('cacheEntries') }),
          h(Field, { key: 'downscaleWebp', id: 'ric-downscale-webp', label: t('downscaleWebp') },
            h('div', { style: styles.checkRow },
              h('input', { id: 'ric-downscale-webp', type: 'checkbox', checked: draft.downscaleWebp, onChange: (e) => set('downscaleWebp')(e.target.checked) }))),
          h(Field, { key: 'skipGif', id: 'ric-skip-gif', label: t('skipGif') },
            h('div', { style: styles.checkRow },
              h('input', { id: 'ric-skip-gif', type: 'checkbox', checked: draft.skipGif, onChange: (e) => set('skipGif')(e.target.checked) }))),
        ]),

        (() => {
          const target = previewTarget(draft)
          const tokens = estimateTokens(target.width, target.height)
          const percent = ((1 - Math.max(target.width, target.height) / Math.max(SAMPLE.width, SAMPLE.height)) * 100).toFixed(1)
          return h('section', { style: styles.section },
            h('h4', { style: styles.heading }, t('sectionPreview')),
            h('div', { style: styles.example },
              h('div', null, t('previewRaster', { width: SAMPLE.width, height: SAMPLE.height, outWidth: target.width, outHeight: target.height })),
              h('div', null, t('previewMeta', { percent, tokens })),
              draft.summaryMode === 'off' ? h('div', null, t('previewOff')) : null))
        })(),

        h('div', { style: styles.actions },
          h('button', { type: 'button', style: styles.primary, disabled: !canSave, onClick: save }, busy ? t('saving') : t('save')),
          h('button', { type: 'button', style: styles.secondary, disabled: busy || !dirty, onClick: discard }, t('discard'))),

        error === '' ? null : h('p', { style: styles.error }, error),
        notice === '' ? null : h('p', { style: styles.notice }, notice),
        dirty ? h('p', { style: styles.dirty }, t('dirty')) : null,
      )
    }

    return {
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
