#!/usr/bin/env node
/**
 * Microsoft Learn 格式校验器。
 *
 * 检查 docs/ 下的文章是否符合 Microsoft 文档规范：front matter、H1 与 title 一致、
 * 标题层级与写法、提示块语法、表格结构、代码围栏语言、相对链接可达、toc 条目存在，
 * 以及禁用词（"我们""点击""只需"之类）。代码围栏与行内代码不参与禁用词检查。
 *
 * 用法：
 *   node scripts/validate-docs.mjs            # 校验 docs/ 下全部 Markdown
 *   node scripts/validate-docs.mjs docs/x.md  # 只校验指定文件
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = join(ROOT, 'docs')

const ALLOWED_TOPICS = new Set([
  'overview',
  'quickstart',
  'concept-article',
  'how-to',
  'reference',
  'tutorial',
  'sample',
  'troubleshooting',
])

const ALLOWED_ALERTS = new Set(['NOTE', 'TIP', 'IMPORTANT', 'CAUTION', 'WARNING'])

// 短语级禁用词：句中出现即报错，行内代码与代码围栏内不检查。
const BANNED_PHRASES = [
  '我们',
  '咱',
  '点击',
  '单击',
  '点开',
  '点一下',
  '键入',
  '填写',
  '只需',
  '一键',
  '轻松',
  '简单',
  '显然',
  '当然',
  '其实',
  '毕竟',
  '说白了',
  '这里',
  '此处',
]

const REQUIRED_KEYS = ['title', 'description', 'ms.date', 'ms.topic']
const RELATED_HEADING = '相关内容'

/** 收集待校验文件：显式参数优先，否则 docs/ 下递归全部 .md。 */
function collectTargets(argv) {
  if (argv.length > 0) return argv.map((p) => resolve(ROOT, p))
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (extname(entry.name) === '.md') found.push(full)
    }
  }
  walk(DOCS)
  return found.sort()
}

/** 解析 front matter，返回 { data, body, bodyOffset }；没有 front matter 时 data 为 null。 */
function splitFrontMatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { data: null, body: text, bodyOffset: 0, problem: '文件开头没有 YAML front matter' }
  }
  const lines = text.split('\n')
  const end = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line))
  if (end === -1) return { data: null, body: text, bodyOffset: 0, problem: 'front matter 缺少结束的 ---' }

  const data = new Map()
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z][\w.-]*)\s*:\s*(.*)$/.exec(line)
    if (match === null) return { data: null, body: text, bodyOffset: 0, problem: `front matter 行无法解析：${line}` }
    data.set(match[1], match[2].trim().replace(/^['"]|['"]$/g, ''))
  }
  return { data, body: lines.slice(end + 1).join('\n'), bodyOffset: end + 1 }
}

/** 返回正文的“散文视图”：代码围栏整段移除，行内代码替换为等长空格，保持行号不变。 */
function proseView(lines) {
  const out = []
  let fence = null
  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line)
    if (fence !== null) {
      if (fenceMatch !== null && fenceMatch[1].startsWith(fence)) fence = null
      out.push('')
      continue
    }
    if (fenceMatch !== null) {
      fence = fenceMatch[1]
      out.push('')
      continue
    }
    out.push(line.replace(/`[^`]*`/g, (match) => ' '.repeat(match.length)))
  }
  return out
}

/** 收集某一行里的 Markdown 链接目标。 */
function linkTargets(line) {
  const targets = []
  const pattern = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g
  let match
  while ((match = pattern.exec(line)) !== null) {
    targets.push(match[1].replace(/^<|>$/g, ''))
  }
  return targets
}

function isExternal(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)
}

/** 校验单个文件，返回问题列表（每条含 level、line、message）。 */
function validateFile(file) {
  const issues = []
  const add = (level, line, message) => issues.push({ level, line, message })
  const text = readFileSync(file, 'utf8')
  const label = relative(ROOT, file)

  if (!text.endsWith('\n')) add('error', 0, '文件末尾没有换行')

  const { data, body, bodyOffset, problem } = splitFrontMatter(text)
  if (problem !== undefined) {
    add('error', 1, problem)
  } else {
    for (const key of REQUIRED_KEYS) {
      if (!data.has(key) || data.get(key) === '') add('error', 1, `front matter 缺少 ${key}`)
    }
    const date = data.get('ms.date')
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      add('error', 1, `ms.date 必须是 YYYY-MM-DD，当前是 ${date}`)
    } else if (date !== undefined) {
      const parsed = new Date(`${date}T00:00:00Z`)
      if (Number.isNaN(parsed.getTime())) add('error', 1, `ms.date 不是有效日期：${date}`)
    }
    const topic = data.get('ms.topic')
    if (topic !== undefined && !ALLOWED_TOPICS.has(topic)) {
      add('error', 1, `ms.topic 不在允许清单内：${topic}`)
    }
    const description = data.get('description')
    if (description !== undefined && description.length > 200) {
      add('warn', 1, `description 超过 200 字（${description.length}）`)
    }
  }

  const lines = body.split('\n')
  const prose = proseView(lines)
  const raw = lines

  // 标题检查
  const headings = []
  let inFence = false
  let fenceMark = null
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i]
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line)
    if (inFence) {
      if (fenceMatch !== null && fenceMatch[1].startsWith(fenceMark)) inFence = false
      continue
    }
    if (fenceMatch !== null) {
      const language = line.trim().replace(/^(```+|~~~+)/, '').trim()
      if (language === '') add('error', i + 1 + bodyOffset, '代码围栏没有语言标记（用 text 表示纯文本）')
      inFence = true
      fenceMark = fenceMatch[1]
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading === null) continue
    headings.push({ level: heading[1].length, text: heading[2].trim(), line: i + 1 + bodyOffset })
  }

  const h1s = headings.filter((h) => h.level === 1)
  if (h1s.length === 0) add('error', 1, '没有 H1 标题')
  if (h1s.length > 1) add('error', h1s[1].line, '出现多个 H1 标题')
  if (h1s.length === 1) {
    if (headings[0] !== h1s[0]) add('error', h1s[0].line, 'H1 之前出现了其他标题')
    const title = data?.get('title')
    if (title !== undefined && title !== h1s[0].text) {
      add('error', h1s[0].line, `H1 与 front matter 的 title 不一致：\n     title: ${title}\n        H1: ${h1s[0].text}`)
    }
  }

  let previousLevel = 0
  for (const heading of headings) {
    if (previousLevel !== 0 && heading.level > previousLevel + 1) {
      add('error', heading.line, `标题层级跳级：H${previousLevel} → H${heading.level}`)
    }
    previousLevel = heading.level
    if (heading.level >= 2) {
      if (/^\d+(?:\.\d+)*[.、\s]/.test(heading.text)) {
        add('error', heading.line, `标题不要编号：${heading.text}`)
      }
      if (/[。.，,；;：:！!？?]\s*$/.test(heading.text)) {
        add('error', heading.line, `标题不要以标点结尾：${heading.text}`)
      }
      if (heading.text.startsWith('：') || heading.text === '') {
        add('error', heading.line, '标题为空或缺少文字')
      }
    }
  }

  const h2Seen = new Map()
  for (const heading of headings.filter((h) => h.level === 2)) {
    if (h2Seen.has(heading.text)) {
      add('error', heading.line, `H2 标题重复：${heading.text}`)
    }
    h2Seen.set(heading.text, heading.line)
  }

  const lastH2 = headings.filter((h) => h.level === 2).at(-1)
  if (lastH2 === undefined || lastH2.text !== RELATED_HEADING) {
    add('warn', 0, `末节应为“## ${RELATED_HEADING}”，当前是“${lastH2?.text ?? '无 H2'}”`)
  }

  // 提示块、禁用词、链接
  for (let i = 0; i < prose.length; i += 1) {
    const line = prose[i]
    const lineNo = i + 1 + bodyOffset
    if (line.trim() === '') continue

    const alert = /^\s*>\s*\[!([A-Za-z]+)\]/.exec(line)
    if (alert !== null && !ALLOWED_ALERTS.has(alert[1].toUpperCase())) {
      add('error', lineNo, `未知的提示块类型：${alert[1]}`)
    }

    for (const phrase of BANNED_PHRASES) {
      if (line.includes(phrase)) add('error', lineNo, `禁用词“${phrase}”：${line.trim()}`)
    }
    // “请求”是技术名词（请求层、请求体），不算禁用词；其余“请”只允许出现在“请参阅”里。
    if (/请(?!参阅|求)/.test(line)) add('error', lineNo, `“请”只允许出现在“请参阅”中：${line.trim()}`)

    for (const target of linkTargets(line)) {
      if (isExternal(target)) continue
      const withoutAnchor = target.split('#')[0].split('?')[0]
      if (withoutAnchor === '') continue
      const resolved = resolve(dirname(file), decodeURIComponent(withoutAnchor))
      if (!existsSync(resolved)) {
        add('error', lineNo, `链接目标不存在：${target}`)
      }
    }

    const bareUrl = /(^|[\s(])(https?:\/\/\S+)/.exec(line.replace(/!?\[[^\]]*\]\([^)]*\)/g, ''))
    if (bareUrl !== null) add('warn', lineNo, `裸 URL 应改为描述性链接：${bareUrl[2]}`)
  }

  // 表格结构：连续的 | 行里，第二行必须是分隔行，且列数与表头一致
  let table = []
  const flushTable = () => {
    if (table.length < 2) {
      if (table.length === 1) add('error', table[0].line, '表格缺少分隔行')
      table = []
      return
    }
    const header = table[0]
    const separator = table[1]
    const count = (line) => line.text.split('|').length - 2
    if (!/^\s*\|[\s:|-]+\|?\s*$/.test(separator.text)) {
      add('error', separator.line, '表格第二行不是合法的分隔行')
    }
    for (const row of table.slice(1)) {
      if (count(row) !== count(header)) {
        add('error', row.line, `表格列数不一致：表头 ${count(header)} 列，本行 ${count(row)} 列`)
      }
    }
    table = []
  }
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i]
    if (/^\s*\|.*\|\s*$/.test(line)) {
      table.push({ text: line.trim(), line: i + 1 + bodyOffset })
    } else {
      flushTable()
    }
  }
  flushTable()

  return { label, issues }
}

function validateToc() {
  const tocPath = join(DOCS, 'toc.yml')
  const issues = []
  if (!existsSync(tocPath)) {
    issues.push({ level: 'error', line: 0, message: 'docs/toc.yml 不存在' })
    return { label: 'docs/toc.yml', issues }
  }
  const lines = readFileSync(tocPath, 'utf8').split('\n')
  let entries = 0
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*-?\s*href:\s*(\S+)\s*$/.exec(lines[i])
    if (match === null) continue
    entries += 1
    const target = resolve(DOCS, match[1])
    if (!existsSync(target) || !statSync(target).isFile()) {
      issues.push({ level: 'error', line: i + 1, message: `toc 条目指向不存在的文件：${match[1]}` })
    }
  }
  if (entries === 0) issues.push({ level: 'error', line: 0, message: 'toc.yml 没有任何 href 条目' })
  return { label: 'docs/toc.yml', issues }
}

const targets = collectTargets(process.argv.slice(2))
if (targets.length === 0) {
  console.error('没有找到待校验的 Markdown 文件。')
  process.exit(1)
}

const results = targets.map(validateFile)
if (process.argv.slice(2).length === 0) results.push(validateToc())

let errors = 0
let warnings = 0
for (const result of results) {
  const fileErrors = result.issues.filter((issue) => issue.level === 'error')
  const fileWarnings = result.issues.filter((issue) => issue.level === 'warn')
  errors += fileErrors.length
  warnings += fileWarnings.length
  if (result.issues.length === 0) {
    console.log(`✓ ${result.label}`)
    continue
  }
  console.log(`${fileErrors.length > 0 ? '✗' : '!'} ${result.label}`)
  for (const issue of [...fileErrors, ...fileWarnings]) {
    const where = issue.line > 0 ? `:${issue.line}` : ''
    console.log(`  ${issue.level === 'error' ? 'error' : 'warn '} ${result.label}${where}  ${issue.message}`)
  }
}

console.log('')
console.log(`${results.length} 个文件，${errors} 个错误，${warnings} 个警告。`)
process.exit(errors > 0 ? 1 : 0)
