#!/usr/bin/env node
/**
 * GeoRelay 密钥自检（可复现，零依赖）
 *
 * 目的：让 README 里「构建产物与源码中不含真实密钥」这句话有对应命令可跑：
 *       npm run check:secrets
 *
 * 只用内置模块 node:fs / node:path，不新增依赖，不需要编译。
 *
 * 扫描范围：
 *   - dist/  整目录的文本产物（不存在则提示先 npm run build，并以非 0 退出）
 *   - src/   仅 .ts / .tsx / .css
 *   - server/ 仅 .mjs
 *   统一跳过 node_modules / .git / artifacts。
 *
 * 检测项（命中即失败）：
 *   1. OpenAI 风格密钥：sk-[A-Za-z0-9]{20,}
 *   2. 真实 Bearer token：Bearer <20+ 个 [A-Za-z0-9._-]>（变量名/模板插值不算）
 *   3. 32 位十六进制串（高德 Key 常见形态），但排除：
 *        - CSS 颜色（紧跟在 # 之后）
 *        - 十六进制/小数数学常量（如 GCJ_EE 一类 0x 字面量或 0.xxxx 小数）
 *        - 出现在注释里的示例
 *   4. 明文赋值：AMAP_WEB_KEY= / AMAP_SECURITY_JS_CODE= / AI_API_KEY= 后面跟非空值；
 *      process.env.X、env('X')、单独变量名、报错文案里的变量名都不算命中。
 *
 * 输出：逐条列出命中（路径 + 行号 + 脱敏片段），结尾打印
 *       密钥自检：通过 / 密钥自检：发现 N 处可疑值
 * 退出码：0 通过，1 发现可疑值，2 缺少 dist/ 无法检查。
 *
 * 说明：本脚本只读，不会修改任何文件，也不会联网。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'

// ── 扫描范围配置 ────────────────────────────────────────────────
const SKIP_DIRS = new Set(['node_modules', '.git', 'artifacts'])
const SRC_EXT = new Set(['.ts', '.tsx', '.css'])
const SERVER_EXT = new Set(['.mjs'])
// dist 里只读这些文本产物，跳过图片/字体/压缩包等二进制
const DIST_EXT = new Set([
  '.js', '.mjs', '.cjs', '.css', '.html', '.htm', '.json', '.map',
  '.svg', '.txt', '.xml', '.webmanifest', '.woff', '.woff2'
])
// 上面名单里 woff 是二进制，单独排除掉
const DIST_BINARY_EXT = new Set(['.woff', '.woff2'])

const DIST_MARKERS = ['/api/amap/security', 'securityJsCode']
const ASSIGN_VARS = ['AMAP_WEB_KEY', 'AMAP_SECURITY_JS_CODE', 'AI_API_KEY']

// ── 基础工具 ────────────────────────────────────────────────────
function findRoot(start) {
  let dir = resolve(start)
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(start)
}

function walk(dir, extFilter, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, extFilter, out)
      continue
    }
    if (!entry.isFile()) continue
    const ext = extname(entry.name).toLowerCase()
    if (extFilter && !extFilter.has(ext)) continue
    if (DIST_BINARY_EXT.has(ext)) continue
    out.push(full)
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function splitLines(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts.map((start, index) => {
    let end = index + 1 < starts.length ? starts[index + 1] - 1 : text.length
    if (end > start && text.charCodeAt(end - 1) === 13) end -= 1
    return { start, text: text.slice(start, end) }
  })
}

/**
 * 标记注释区域（1 = 位于注释内），用于排除「注释里的示例」。
 * 同时跟踪字符串，避免把 "https://x" 里的 // 当成注释。
 * CSS 只有块注释，JS/TS/MJS 额外支持 // 行注释。
 */
function buildCommentMask(text, ext) {
  const mask = new Uint8Array(text.length)
  const allowLineComment = ext !== '.css' && ext !== '.svg' && ext !== '.html'
  let state = 'code'
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (state === 'code') {
      if (allowLineComment && c === '/' && n === '/') {
        mask[i] = 1
        mask[i + 1] = 1
        state = 'line'
        i += 2
        continue
      }
      if (c === '/' && n === '*') {
        mask[i] = 1
        mask[i + 1] = 1
        state = 'block'
        i += 2
        continue
      }
      if (c === "'") { state = 'squote'; i += 1; continue }
      if (c === '"') { state = 'dquote'; i += 1; continue }
      if (c === '`') { state = 'template'; i += 1; continue }
      i += 1
      continue
    }
    if (state === 'line') {
      if (c === '\n' || c === '\r') { state = 'code'; i += 1; continue }
      mask[i] = 1
      i += 1
      continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        mask[i] = 1
        mask[i + 1] = 1
        state = 'code'
        i += 2
        continue
      }
      mask[i] = 1
      i += 1
      continue
    }
    // 字符串内部
    if (c === '\\') { i += 2; continue }
    if ((state === 'squote' && c === "'") || (state === 'dquote' && c === '"') || (state === 'template' && c === '`')) {
      state = 'code'
      i += 1
      continue
    }
    i += 1
  }
  return mask
}

/** 脱敏：最多显示前 4 位 + 长度，绝不打印完整值 */
function maskValue(value) {
  const len = value.length
  if (len === 0) return '（空）'
  const head = value.slice(0, Math.min(4, len))
  const stars = len > head.length ? '*'.repeat(Math.min(8, len - head.length)) : ''
  return `${head}${stars}（长度 ${len}）`
}

// ── 检测规则 ────────────────────────────────────────────────────

// 1. OpenAI 风格密钥：sk-<20+ 个字母数字>；
//    兼容真实发行格式 sk-proj-… / sk-ant-… / sk-live-…（否则这类新密钥会被漏掉）
const RE_OPENAI = /sk-(?:[A-Za-z0-9]{20,}|(?:proj|ant|live|test|svcacct|admin)-[A-Za-z0-9_-]{16,})/g
// 2. 真实 Bearer token：token 必须是字面量，模板插值（${...}）不会命中
const RE_BEARER = /Bearer[ \t]+[A-Za-z0-9._-]{20,}/g
// 3. 32 位十六进制串
const RE_HEX32 = /(?<![0-9A-Za-z])[0-9a-fA-F]{32}(?![0-9A-Za-z])/g
// 4. 明文赋值：变量名后紧跟 = 且不是 == / === / =>
const RE_ASSIGN = new RegExp(
  `(?<![.\\w])(${ASSIGN_VARS.join('|')})[ \\t]*=(?![=>])[ \\t]*([^\\s,;)\\]}]*)`,
  'g'
)

/** 判断 32 位十六进制命中是否属于「正常代码/样式」，命中需排除 */
function isHex32Allowed(text, offset, mask) {
  // 注释里的示例（如「例如 xxxxxxxx…」）不算
  if (mask[offset] === 1) return { skip: true, why: '注释示例' }

  // CSS 颜色（#RRGGBB / #RRGGBBAA）：紧跟在 # 之后
  if (offset > 0 && text[offset - 1] === '#') return { skip: true, why: 'CSS 颜色' }

  const prev2 = offset >= 2 ? text.slice(offset - 2, offset) : ''
  const prev1 = offset >= 1 ? text[offset - 1] : ''
  const prev0 = offset >= 2 ? text[offset - 2] : ''

  // 十六进制字面量：0x00669342162296594323（GCJ_EE 这类数学常量）
  if (/^0[xX]$/.test(prev2)) return { skip: true, why: '十六进制数学常量' }
  // 小数：0.00669342162296594323 —— 点号 + 数字前缀视为浮点常量
  if (prev1 === '.' && /[0-9]/.test(prev0)) return { skip: true, why: '浮点数学常量' }
  // 科学计数法尾部：1e+0123456789abcdef…（此时前两位是 e+/e-）
  if (/^[eE][+-]$/.test(prev2)) return { skip: true, why: '科学计数法常量' }
  // 说明：1e0123… 这类无符号指数不需要单独判断——紧邻 e 会被上面的
  //「前面不能是字母数字」边界条件直接排除，不会产生命中。

  return { skip: false }
}

/**
 * 把赋值右侧的原文归一成「值」。
 * 去掉引号；空值返回空串。
 */
function normalizeAssignedValue(raw) {
  let value = raw.trim()
  if (value === '') return ''
  const quote = value[0]
  if (quote === '"' || quote === "'" || quote === '`') {
    const end = value.indexOf(quote, 1)
    value = end === -1 ? value.slice(1) : value.slice(1, end)
  }
  return value.trim()
}

/**
 * 判断赋值右侧是否为「真正的明文密钥」，还是代码引用/占位符。
 * 这里集中放「避免误报」的排除逻辑。
 */
function classifyAssignedValue(value) {
  if (value === '') return { hit: false, why: '空值' }

  // 读取环境变量/配置的引用形式，都不是明文密钥
  if (/^process\.env\b/.test(value)) return { hit: false, why: 'process.env 引用' }
  if (/^import\.meta\.env\b/.test(value)) return { hit: false, why: 'import.meta.env 引用' }
  if (/^env\s*\(/.test(value)) return { hit: false, why: 'env() 引用' }
  if (/^(require|readEnv|getEnv|loadEnv|get|read)\s*\(/.test(value)) return { hit: false, why: '函数读取' }
  if (/^(undefined|null|void 0)\b/.test(value)) return { hit: false, why: '非密钥占位' }
  // 模板插值 / 表达式：值是代码而不是字面量
  if (value.includes('${') || value.includes('`')) return { hit: false, why: '模板插值' }
  if (/[(){}[\]$<>]/.test(value)) return { hit: false, why: '代码表达式或占位符' }
  // 纯占位符：***、xxx、<...> 之类
  if (/^[*x·—_-]+$/.test(value)) return { hit: false, why: '占位符' }
  // 值里带空白说明不是单个密钥字面量
  if (/\s/.test(value)) return { hit: false, why: '非字面量' }

  return { hit: true }
}

// ── 扫描实现 ────────────────────────────────────────────────────
function scanFile(file, hits) {
  const text = readText(file)
  if (text === null) return { markers: new Set() }

  const ext = extname(file).toLowerCase()
  const lines = splitLines(text)
  const commentMask = buildCommentMask(text, ext)
  const markers = new Set()

  for (const wanted of DIST_MARKERS) {
    if (text.includes(wanted)) markers.add(wanted)
  }

  lines.forEach((line, index) => {
    const lineNo = index + 1
    const source = line.text
    if (source === '') return

    // 1) sk-
    collect(source, RE_OPENAI, (match) => {
      hits.push({ file, line: lineNo, rule: 'OpenAI 风格密钥（sk-）', masked: maskValue(match) })
    })

    // 2) Bearer token
    collect(source, RE_BEARER, (match) => {
      const token = match.replace(/^Bearer[ \t]+/, '')
      hits.push({ file, line: lineNo, rule: '真实 Bearer Token', masked: `Bearer ${maskValue(token)}` })
    })

    // 3) 32 位十六进制串
    collect(source, RE_HEX32, (match, matchIndex) => {
      const offset = line.start + matchIndex
      const verdict = isHex32Allowed(text, offset, commentMask)
      if (verdict.skip) return
      hits.push({ file, line: lineNo, rule: '32 位十六进制串（疑似高德 Key）', masked: maskValue(match) })
    })

    // 4) 明文赋值
    collect(source, RE_ASSIGN, (match, matchIndex, groups) => {
      const value = normalizeAssignedValue(groups[2] ?? '')
      const verdict = classifyAssignedValue(value)
      if (!verdict.hit) return
      hits.push({ file, line: lineNo, rule: `明文赋值 ${groups[1]}`, masked: `${groups[1]}=${maskValue(value)}` })
    })
  })

  return { markers }
}

function collect(source, regex, onMatch) {
  // 每次新建正则，避免 lastIndex 互相影响
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`)
  let match = re.exec(source)
  while (match !== null) {
    const captured = match[0]
    if (captured.length === 0) {
      re.lastIndex += 1
      continue
    }
    onMatch(captured, match.index, match)
    match = re.exec(source)
  }
}

// ── 主流程 ──────────────────────────────────────────────────────
function main() {
  const root = findRoot(process.cwd())
  const distDir = join(root, 'dist')
  const srcDir = join(root, 'src')
  const serverDir = join(root, 'server')

  console.log('GeoRelay 密钥自检')
  console.log(`根目录：${root}`)
  console.log('规则：sk- 密钥 · Bearer Token · 32 位十六进制串 · 明文赋值（AMAP_WEB_KEY / AMAP_SECURITY_JS_CODE / AI_API_KEY）')
  console.log('')

  if (!existsSync(distDir)) {
    console.error('[失败] 未找到 dist/：请先运行 npm run build 生成构建产物，再执行 npm run check:secrets')
    process.exitCode = 2
    return
  }

  const distFiles = []
  walk(distDir, DIST_EXT, distFiles)
  const srcFiles = []
  walk(srcDir, SRC_EXT, srcFiles)
  const serverFiles = []
  walk(serverDir, SERVER_EXT, serverFiles)

  console.log(`扫描范围：dist/ ${distFiles.length} 个文件 · src/ ${srcFiles.length} 个文件 · server/ ${serverFiles.length} 个文件`)
  console.log('跳过目录：node_modules / .git / artifacts')
  console.log('')

  const hits = []
  const markers = new Set()

  for (const file of distFiles) {
    const result = scanFile(file, hits)
    for (const marker of result.markers) markers.add(marker)
  }
  for (const file of srcFiles) scanFile(file, hits)
  for (const file of serverFiles) scanFile(file, hits)

  const relPath = (file) => relative(root, file).split('\\').join('/')

  if (hits.length === 0) {
    console.log('命中：无')
  } else {
    console.log(`命中：${hits.length} 处`)
    hits.forEach((hit, index) => {
      console.log(`  ${String(index + 1).padStart(2, ' ')}. ${relPath(hit.file)}:${hit.line}  [${hit.rule}]  ${hit.masked}`)
    })
  }
  console.log('')

  // dist/ 字段说明（字段名出现是正常的，不算失败）
  const markerText = DIST_MARKERS
    .map((marker) => `${marker}：${markers.has(marker) ? '出现' : '未出现'}`)
    .join(' · ')
  console.log(`dist/ 说明：${markerText}（字段名/代理端点出现在产物里属正常设计，不计为失败）`)
  console.log('')

  if (hits.length === 0) {
    console.log('密钥自检：通过')
    process.exitCode = 0
    return
  }

  console.log(`密钥自检：发现 ${hits.length} 处可疑值`)
  process.exitCode = 1
}

main()
