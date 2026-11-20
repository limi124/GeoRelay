// 高德 Web 服务代理：安全密钥（JS API securityJsCode）与 Web 服务 Key 只在服务端使用。
// 浏览器只访问同源 /api/amap/*，密钥不会进入前端构建产物。
import { env, mask } from './env.mjs'

const REST = 'https://restapi.amap.com'

// GCJ-02 ⇄ WGS-84（与服务端示例保持一致）
const A = 6378245.0
const EE = 0.00669342162296594323

function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x, y) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3
  return ret
}

function transformLon(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3
  ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3
  return ret
}

export function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat]
  let dLat = transformLat(lng - 105, lat - 35)
  let dLon = transformLon(lng - 105, lat - 35)
  const radLat = (lat / 180) * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI)
  dLon = (dLon * 180) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI)
  return [lng + dLon, lat + dLat]
}

export function gcj02ToWgs84(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat]
  const [glng, glat] = wgs84ToGcj02(lng, lat)
  return [lng * 2 - glng, lat * 2 - glat]
}

export function amapConfig() {
  return {
    webKey: env('AMAP_WEB_KEY'),
    securityJsCode: env('AMAP_SECURITY_JS_CODE'),
    restKey: env('AMAP_REST_KEY'),
    jsVersion: env('AMAP_JS_VERSION', '2.0'),
    mock: env('AMAP_ALLOW_SAMPLE', '1') !== '0',
  }
}

export function amapStatus() {
  const webKey = env('AMAP_WEB_KEY')
  const restKey = env('AMAP_REST_KEY')
  const security = env('AMAP_SECURITY_JS_CODE')
  return {
    webKeyConfigured: Boolean(webKey),
    securityCodeConfigured: Boolean(security),
    restConfigured: Boolean(restKey || webKey),
    jsVersion: env('AMAP_JS_VERSION', '2.0'),
    // 只回脱敏值：前端不需要完整 Key（Key 由 /config 在页面加载时下发一次）
    maskedKey: webKey ? `${webKey.slice(0, 3)}***${webKey.slice(-2)}` : '',
  }
}

/** 由代理签署的 securityJsCode（浏览器端）。缺省时返回 null，前端转入示例模式。 */
export function securityCode() {
  return amapConfig().securityJsCode || null
}

function restKey() {
  const c = amapConfig()
  return c.restKey || c.webKey
}

class AmapError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

async function callRest(path, params) {
  const key = restKey()
  if (!key) throw new AmapError('NO_KEY', '服务端未配置高德 Key（AMAP_REST_KEY / AMAP_WEB_KEY）')
  const qs = new URLSearchParams({ ...params, key, output: 'JSON' })
  const url = `${REST}${path}?${qs.toString()}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 9000)
  let res
  try {
    res = await fetch(url, { signal: ctrl.signal })
  } catch (err) {
    throw new AmapError('NETWORK', `高德接口请求失败：${err?.name === 'AbortError' ? '超时' : err.message}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new AmapError('HTTP', `高德接口 HTTP ${res.status}`)
  const json = await res.json()
  if (String(json.status) !== '1') {
    throw new AmapError(`AMAP_${json.infocode ?? 'ERR'}`, `高德接口返回错误：${json.info ?? 'unknown'}（infocode ${json.infocode ?? '?'}）`)
  }
  return json
}

function isScalar(v) {
  return typeof v === 'string' || typeof v === 'number'
}

function parseLngLat(str) {
  if (!str || typeof str !== 'string') return null
  const [lng, lat] = str.split(',').map(Number)
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  return gcj02ToWgs84(lng, lat)
}

export async function aroundPharmacies({ center, radius, keywords }) {
  const [lng, lat] = wgs84ToGcj02(center[0], center[1])
  const r = Math.max(Math.round(radius), 500)
  const json = await callRest('/v3/place/around', {
    location: `${lng.toFixed(6)},${lat.toFixed(6)}`,
    keywords: keywords || '药店',
    radius: String(Math.min(r, 30000)),
    offset: '25',
    page: '1',
    extensions: 'base',
    sortrule: 'distance',
  })
  const pois = Array.isArray(json.pois) ? json.pois : []
  return pois
    .map((p) => {
      const ll = parseLngLat(p.location)
      if (!ll) return null
      const distance = Number.parseInt(p.distance ?? '0', 10)
      return {
        id: `amap-${p.id}`,
        name: p.name,
        address: isScalar(p.address) && p.address ? p.address : [p.pname, p.cityname, p.adname].filter(isScalar).join(''),
        lngLat: ll,
        distanceM: Number.isFinite(distance) ? distance : 0,
        tel: isScalar(p.tel) ? String(p.tel) : undefined,
        source: 'amap',
        typecode: p.typecode,
      }
    })
    .filter(Boolean)
}

export async function drivingRoute(points) {
  const origin = points[0]
  const destination = points[points.length - 1]
  const waypoints = points.slice(1, -1)
  const toG = (p) => {
    const [lng, lat] = wgs84ToGcj02(p[0], p[1])
    return `${lng.toFixed(6)},${lat.toFixed(6)}`
  }
  const params = {
    origin: toG(origin),
    destination: toG(destination),
    extensions: 'base',
    strategy: '0',
  }
  if (waypoints.length) params.waypoints = waypoints.slice(0, 16).map(toG).join(';')
  const json = await callRest('/v3/direction/driving', params)
  const path = json.route?.paths?.[0]
  if (!path) throw new AmapError('NO_ROUTE', '高德未返回可用驾车路线（可能是起点或终点不在道路附近）')
  const polyline = []
  for (const step of path.steps ?? []) {
    for (const pair of String(step.polyline ?? '').split(';')) {
      const [lng, lat] = pair.split(',').map(Number)
      if (Number.isFinite(lng) && Number.isFinite(lat)) polyline.push(gcj02ToWgs84(lng, lat))
    }
  }
  return {
    ok: true,
    path: polyline,
    distanceM: Number.parseInt(path.distance ?? '0', 10),
    durationS: Number.parseInt(path.duration ?? '0', 10),
    source: 'amap',
    steps: (path.steps ?? []).map((s) => ({ instruction: s.instruction ?? s.road ?? '通行', distanceM: Number.parseInt(s.distance ?? '0', 10) })),
  }
}

export async function geocode(query, city) {
  const tips = await inputTips(query, city).catch(() => [])
  const place = tips.find((tip) => tip.name.trim() === query.trim())
  if (place) {
    const formatted = place.address ? `${place.name} · ${place.address}` : place.name
    return { lngLat: place.lngLat, formatted, level: '兴趣点' }
  }
  const json = await callRest('/v3/geocode/geo', { address: query, ...(city ? { city } : {}) })
  const geo = Array.isArray(json.geocodes) ? json.geocodes[0] : null
  if (!geo) throw new AmapError('NO_RESULT', `没有找到「${query}」对应的地址`)
  const ll = parseLngLat(geo.location)
  if (!ll) throw new AmapError('NO_RESULT', '高德返回的地址缺少坐标')
  return { lngLat: ll, formatted: geo.formatted_address, level: geo.level }
}

export async function inputTips(query, city) {
  const json = await callRest('/v3/assistant/inputtips', { keywords: query, ...(city ? { city } : {}) })
  const tips = Array.isArray(json.tips) ? json.tips : []
  return tips
    .map((t) => {
      const ll = parseLngLat(t.location)
      return ll ? { name: isScalar(t.name) ? t.name : '', address: isScalar(t.address) ? String(t.address) : undefined, lngLat: ll } : null
    })
    .filter(Boolean)
    .filter((t) => t.name)
}

export async function regeo(lngLat) {
  const [lng, lat] = wgs84ToGcj02(lngLat[0], lngLat[1])
  const json = await callRest('/v3/geocode/regeo', {
    location: `${lng.toFixed(6)},${lat.toFixed(6)}`,
    extensions: 'base',
    radius: '500',
  })
  const rg = json.regeocode
  if (!rg) throw new AmapError('NO_RESULT', '逆地理编码没有结果')
  return { address: rg.formatted_address, pois: rg.pois?.slice(0, 5).map((p) => p.name) ?? [] }
}

export { AmapError }
