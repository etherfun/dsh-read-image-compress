/**
 * Browser half of the read-image-compress bundle: the row configuration page.
 *
 * The Plugins page owns the form state and passes `{ state, mutate }`; this
 * component stages values locally, then writes them through one atomic
 * mutation. It deliberately uses plain React controls so it does not depend on
 * the host's private UI primitives.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-read-image-compress',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'readImageCompress'
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

    const DICT = {
      en: {
        title: 'Read image compression',
        summary: 'Compress read_image results before the session stores them.',
        description: 'Downscale and re-encode images read by read_image.',
        sectionCompression: 'Compression',
        sectionResolution: 'Resolution',
        sectionFormat: 'Format',
        sectionBehaviour: 'Behaviour',
        enabled: 'Enable compression',
        quality: 'Quality (1–100)',
        resolutionScale: 'Resolution scale (0.1–1)',
        format: 'Output format',
        formatAuto: 'Auto (WebP for alpha, JPEG otherwise)',
        formatJpeg: 'JPEG (flattens alpha)',
        formatWebp: 'WebP',
        formatPng: 'PNG (lossless)',
        maxEdge: 'Maximum long edge (px)',
        maxBytes: 'Target bytes (KiB)',
        minBytes: 'Skip images below (KiB)',
        minResizeScale: 'Minimum resize ratio',
        webpEffort: 'WebP effort (0–6)',
        jpegBackground: 'JPEG background',
        cacheEntries: 'In-memory cache entries',
        downscaleWebp: 'Downscale WebP results',
        skipGif: 'Skip GIF images',
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
        saved: 'Saved',
        saveFailed: 'Could not save the settings',
        unavailable: 'Configuration is not available for this row.',
        loading: 'Loading configuration…',
        readOnly: 'This configuration is read-only.',
        dirty: 'Unsaved changes',
      },
      zh: {
        title: '读图压缩',
        summary: '在会话保存前压缩 read_image 的结果。',
        description: '对 read_image 读取的图片降尺寸并重新编码。',
        sectionCompression: '压缩',
        sectionResolution: '分辨率',
        sectionFormat: '格式',
        sectionBehaviour: '行为',
        enabled: '启用压缩',
        quality: '质量（1–100）',
        resolutionScale: '分辨率缩放（0.1–1）',
        format: '输出格式',
        formatAuto: '自动（有 alpha 用 WebP，否则 JPEG）',
        formatJpeg: 'JPEG（会压平 alpha）',
        formatWebp: 'WebP',
        formatPng: 'PNG（无损）',
        maxEdge: '最大长边（px）',
        maxBytes: '目标字节（KiB）',
        minBytes: '小于此值跳过（KiB）',
        minResizeScale: '最小缩放比例',
        webpEffort: 'WebP 编码强度（0–6）',
        jpegBackground: 'JPEG 背景色',
        cacheEntries: '内存缓存条数',
        downscaleWebp: '允许缩小 WebP',
        skipGif: '跳过 GIF',
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
        saved: '已保存',
        saveFailed: '设置保存失败',
        unavailable: '当前行没有可用的配置。',
        loading: '正在读取配置…',
        readOnly: '此配置为只读。',
        dirty: '有未保存的修改',
      },
    }

    const styles = {
      root: { maxWidth: '760px', color: 'var(--dsw-alias-label-primary, #1f2328)', fontSize: '13px' },
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
        gridTemplateColumns: 'minmax(160px, 220px) minmax(0, 1fr)',
        gap: '9px 16px',
        alignItems: 'center',
      },
      label: { color: 'var(--dsw-alias-label-primary, #1f2328)' },
      hint: { color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: '12px', marginTop: '6px' },
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
      const state = form?.state
      const [draft, setDraft] = React.useState(() => merge(state?.value))
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')

      React.useEffect(() => {
        setDraft(merge(state?.value))
        setError('')
        setNotice('')
      }, [state?.revision, state?.value])

      if (view === 'summary') return h('span', null, t('summary'))
      if (!state || state.status === 'loading') {
        return h('p', { style: styles.hint }, t('loading'))
      }
      if (state.status === 'unavailable') {
        return h('p', { style: styles.hint }, t('unavailable'))
      }
      if (state.writable === false) {
        return h('p', { style: styles.hint }, t('readOnly'))
      }

      const set = (key) => (value) => setDraft((current) => ({ ...current, [key]: value }))
      const setNumber = (key) => (raw) => setDraft((current) => ({ ...current, [key]: raw === '' ? '' : Number(raw) }))
      const setKib = (key) => (raw) => setDraft((current) => ({ ...current, [key]: raw === '' ? '' : Math.round(Number(raw) * 1024) }))

      const dirty = JSON.stringify(draft) !== JSON.stringify(merge(state.value))
      const canSave = !busy && dirty

      const save = async () => {
        if (!canSave) return
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const ops = Object.entries(draft).map(([key, value]) => ({ op: 'set', path: [key], value }))
          const ok = await form.mutate(ops, state.revision)
          if (!ok) setError(t('saveFailed'))
          else setNotice(t('saved'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const discard = () => {
        setDraft(merge(state.value))
        setError('')
        setNotice('')
      }

      const section = (title, rows) => h('section', { style: styles.section },
        h('h4', { style: styles.heading }, title),
        h('div', { style: styles.grid }, rows))

      return h('div', { style: styles.root },
        h('p', { style: styles.hint }, t('description')),

        section(t('sectionCompression'), [
          h(Field, { key: 'enabled', id: 'ric-enabled', label: t('enabled') },
            h('div', { style: styles.checkRow },
              h('input', { id: 'ric-enabled', type: 'checkbox', checked: draft.enabled, onChange: (e) => set('enabled')(e.target.checked) }))),
          h(NumberField, { key: 'quality', id: 'ric-quality', label: t('quality'), value: draft.quality, min: 1, max: 100, step: 1, onChange: setNumber('quality') }),
          h(NumberField, { key: 'maxBytes', id: 'ric-max-bytes', label: t('maxBytes'), value: Math.round(Number(draft.maxBytes) / 1024), min: 1, step: 1, onChange: setKib('maxBytes') }),
          h(NumberField, { key: 'minBytes', id: 'ric-min-bytes', label: t('minBytes'), value: Math.round(Number(draft.minBytes) / 1024), min: 0, step: 1, onChange: setKib('minBytes') }),
          h(NumberField, { key: 'cacheEntries', id: 'ric-cache', label: t('cacheEntries'), value: draft.cacheEntries, min: 0, max: 4096, step: 1, onChange: setNumber('cacheEntries') }),
        ]),

        section(t('sectionResolution'), [
          h(NumberField, { key: 'resolutionScale', id: 'ric-scale', label: t('resolutionScale'), value: draft.resolutionScale, min: 0.1, max: 1, step: 0.05, onChange: setNumber('resolutionScale') }),
          h(NumberField, { key: 'maxEdge', id: 'ric-max-edge', label: t('maxEdge'), value: draft.maxEdge, min: 64, max: 8192, step: 1, onChange: setNumber('maxEdge') }),
          h(NumberField, { key: 'minResizeScale', id: 'ric-min-resize', label: t('minResizeScale'), value: draft.minResizeScale, min: 0.1, max: 1, step: 0.05, onChange: setNumber('minResizeScale') }),
        ]),

        section(t('sectionFormat'), [
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
        ]),

        section(t('sectionSummary'), [
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

        section(t('sectionBehaviour'), [
          h(Field, { key: 'skipGif', id: 'ric-skip-gif', label: t('skipGif') },
            h('div', { style: styles.checkRow },
              h('input', { id: 'ric-skip-gif', type: 'checkbox', checked: draft.skipGif, onChange: (e) => set('skipGif')(e.target.checked) }))),
          h(Field, { key: 'downscaleWebp', id: 'ric-downscale-webp', label: t('downscaleWebp') },
            h('div', { style: styles.checkRow },
              h('input', { id: 'ric-downscale-webp', type: 'checkbox', checked: draft.downscaleWebp, onChange: (e) => set('downscaleWebp')(e.target.checked) }))),
        ]),

        h('div', { style: styles.actions },
          h('button', { type: 'button', style: styles.primary, disabled: !canSave, onClick: save }, busy ? t('saving') : t('save')),
          h('button', { type: 'button', style: styles.secondary, disabled: busy || !dirty, onClick: discard }, t('discard'))),

        error === '' ? null : h('p', { style: styles.error }, error),
        notice === '' ? null : h('p', { style: styles.notice }, notice),
        dirty ? h('p', { style: styles.dirty }, t('dirty')) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT))
        ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: '@local/dsh-read-image-compress#read-image-compress',
          locale: NS,
        }, SettingsCard)))
      },
    }
  },
})
