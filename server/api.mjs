// 最小 HTTP 服务：静态资源（dist）+ /api/amap 代理 + /api/ai 代理。
// 开发与预览都走这里；Vite dev server 把 /api 代理到本服务。
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv, env, envBool, mask } from './env.mjs'
import * as amap from './amap.mjs'
import { aiStatus, analyzeDisaster, explainCandidates } from './ai.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
loadEnv(root)

const PORT = Number.parseInt(env('PORT', env('API_PORT', '8791')), 10)
const HOST = env('HOST', '127.0.0.1')
const DIST = join(root, 'dist')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readBody(req, limit = 1024 * 128) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function number(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 同源校验：安全密钥只发给同源页面。
 *
 * 之前只依赖“没有 CORS 头 + 绑定 127.0.0.1”，本机任意程序都能直接取到 securityJsCode；
 * 一旦 HOST 改成 0.0.0.0，同网段即可读取。这里显式校验 Sec-Fetch-Site / Origin。
 */
function sameOriginAllowed(req) {
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (!origin) return true // 同源导航请求可能不带 Origin
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

async function handleAmap(req, res, url) {
  const route = url.pathname.replace('/api/amap', '')
  // 浏览器启动高德 JS API 前取配置：只返回 Web Key 与 JS 版本；安全密钥走 _AMapSecurityConfig 由前端同源调用 getSecurityCode
  if (route === '/config' && req.method === 'GET') {
    const status = amap.amapStatus()
    // 注意：amapStatus() 只回脱敏字段（maskedKey），真实 Web Key 在 amapConfig() 里；
    // 之前这里误用 status.webKey 导致前端永远拿不到 Key、静默退回示例地图。
    const cfg = amap.amapConfig()
    return sendJson(res, 200, {
      ok: status.webKeyConfigured,
      jsVersion: cfg.jsVersion,
      webKey: cfg.webKey,
      securityCodeConfigured: status.securityCodeConfigured,
      securityCodePath: '/api/amap/security',
      allowSample: cfg.mock,
      message: status.webKeyConfigured
        ? '高德 JS API 已配置'
        : '未配置 AMAP_WEB_KEY：使用示例地图（可编辑、可演练，但不是真实地图）',
    })
  }
  if (route === '/security' && req.method === 'GET') {
    if (!sameOriginAllowed(req)) {
      return sendJson(res, 403, { ok: false, error: '安全密钥只对同源页面下发' })
    }
    const code = amap.securityCode()
    // 安全密钥按高德约定映射进 _AMapSecurityConfig.securityJsCode（生产环境应在代理层做域名白名单）
    return sendJson(res, 200, { securityJsCode: code })
  }
  if (route === '/status' && req.method === 'GET') {
    return sendJson(res, 200, amap.amapStatus())
  }
  try {
    if (route === '/around' && req.method === 'POST') {
      const body = await readBody(req)
      const center = Array.isArray(body.center) ? body.center.map(Number) : null
      if (!center || center.length !== 2 || !center.every(Number.isFinite)) {
        return sendJson(res, 400, { ok: false, error: 'center 需要 [lng, lat]' })
      }
      const items = await amap.aroundPharmacies({
        center,
        radius: number(body.radius, 3000),
        keywords: typeof body.keywords === 'string' ? body.keywords : '药店',
      })
      return sendJson(res, 200, { ok: true, items, source: 'amap' })
    }
    if (route === '/route' && req.method === 'POST') {
      const body = await readBody(req)
      const points = Array.isArray(body.points) ? body.points.filter((p) => Array.isArray(p) && p.length === 2) : []
      if (points.length < 2) return sendJson(res, 400, { ok: false, error: 'points 至少需要起点和终点' })
      const out = await amap.drivingRoute(points)
      return sendJson(res, 200, out)
    }
    if (route === '/geocode' && req.method === 'POST') {
      const body = await readBody(req)
      if (!body.query) return sendJson(res, 400, { ok: false, error: '缺少 query' })
      const out = await amap.geocode(String(body.query), body.city ? String(body.city) : undefined)
      return sendJson(res, 200, { ok: true, ...out })
    }
    if (route === '/tips' && req.method === 'POST') {
      const body = await readBody(req)
      if (!body.query) return sendJson(res, 400, { ok: false, error: '缺少 query' })
      const items = await amap.inputTips(String(body.query), body.city ? String(body.city) : undefined)
      return sendJson(res, 200, { ok: true, items })
    }
    if (route === '/regeo' && req.method === 'POST') {
      const body = await readBody(req)
      if (!Array.isArray(body.lngLat)) return sendJson(res, 400, { ok: false, error: '缺少 lngLat' })
      const out = await amap.regeo(body.lngLat.map(Number))
      return sendJson(res, 200, { ok: true, ...out })
    }
    return sendJson(res, 404, { ok: false, error: `未知的高德接口 ${route}` })
  } catch (err) {
    const code = err?.code ?? 'ERROR'
    // 只记录错误码与消息，绝不记录 URL（其中包含 Key）
    console.warn(`[amap] ${route} 失败：${code} ${err?.message ?? err}`)
    return sendJson(res, 502, {
      ok: false,
      error: err?.message ?? '高德接口调用失败',
      code,
      source: 'amap',
    })
  }
}

async function handleAi(req, res, url) {
  if (url.pathname === '/api/ai/status' && req.method === 'GET') {
    return sendJson(res, 200, aiStatus())
  }
  if (url.pathname === '/api/ai/analyze' && req.method === 'POST') {
    try {
      const body = await readBody(req, 1024 * 256)
      const out = await analyzeDisaster(body)
      return sendJson(res, 200, out)
    } catch (err) {
      // 失败原因要明确回给前端：界面据此提示并保留规则候选
      const code = err?.code ?? 'AI_ERROR'
      console.warn(`[ai] analyze 失败：${code} ${err?.message ?? err}`)
      return sendJson(res, code === 'AI_NETWORK' || code === 'AI_TIMEOUT' ? 504 : 502, {
        ok: false,
        mode: 'error',
        code,
        message: err?.message ?? 'AI 接口调用失败',
        protocolVersion: 1,
      })
    }
  }
  if (url.pathname === '/api/ai/explain' && req.method === 'POST') {
    try {
      const body = await readBody(req, 1024 * 256)
      const out = await explainCandidates(body)
      return sendJson(res, 200, out)
    } catch (err) {
      console.warn(`[ai] explain 失败：${err?.code ?? 'ERROR'} ${err?.message ?? err}`)
      return sendJson(res, 200, { ok: false, mode: 'rules', error: err?.message ?? 'AI 接口不可用', code: err?.code ?? 'ERROR' })
    }
  }
  return sendJson(res, 404, { ok: false, error: '未知的 AI 接口' })
}

async function serveStatic(req, res, url) {
  if (!(await exists(DIST))) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('尚未构建前端产物。开发模式请运行 npm run dev；生产预览请先运行 npm run build。')
    return
  }
  const rawPath = decodeURIComponent(url.pathname)
  const safe = normalize(rawPath).replace(/^([/\\])+/, '')
  if (safe.includes('..')) {
    res.writeHead(400).end('bad path')
    return
  }
  let file = join(DIST, safe)
  if (!(await exists(file)) || (await stat(file)).isDirectory()) file = join(DIST, 'index.html')
  const data = await readFile(file)
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
  })
  res.end(data)
}

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  try {
    if (url.pathname === '/api/health') {
      const a = amap.amapStatus()
      const ai = aiStatus()
      return sendJson(res, 200, {
        ok: true,
        amap: { webKeyConfigured: a.webKeyConfigured, securityCodeConfigured: a.securityCodeConfigured, restConfigured: a.restConfigured, maskedKey: a.masked },
        ai,
        time: new Date().toISOString(),
      })
    }
    if (url.pathname.startsWith('/api/amap')) return await handleAmap(req, res, url)
    if (url.pathname.startsWith('/api/ai')) return await handleAi(req, res, url)
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: '未知接口' })
    return await serveStatic(req, res, url)
  } catch (err) {
    console.error('[server]', err?.message ?? err)
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: '服务器内部错误' })
    else res.end()
  }
})

server.listen(PORT, HOST, () => {
  const a = amap.amapStatus()
  const ai = aiStatus()
  console.log(`[georelay] API 服务 http://${HOST}:${PORT}`)
  console.log(`[georelay] 高德 Web Key：${a.webKeyConfigured ? `已配置（${mask(a.webKey)}）` : '未配置 → 前端使用示例地图'}`)
  console.log(`[georelay] 高德安全密钥：${a.securityCodeConfigured ? '已配置（服务端代理）' : '未配置'}`)
  console.log(`[georelay] AI 接口：${ai.enabled ? `已配置（${ai.label}）` : '未配置 → 规则模式'}`)
  if (envBool('SHOW_ENV_WARNINGS', true) && a.webKeyConfigured && !a.securityCodeConfigured) {
    console.warn('[georelay] 提示：设置了 Web Key 但未设置 AMAP_SECURITY_JS_CODE，高德 JS API 2.0 可能拒绝加载。')
  }
})
