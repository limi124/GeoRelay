import type { BBox, LocalFrame, LngLat, Vec2 } from './types.ts'

// 世界大地测量系统 WGS-84 与 GCJ-02（高德/腾讯）之间的转换。
// 高德地图返回的坐标是 GCJ-02；OSM 搜索结果是 WGS-84。两者混用会产生 300~600 米偏移，
// 因此内部统一保存 WGS-84，只在调用高德接口时转换成 GCJ-02。

const PI = Math.PI
const A = 6378245.0
const EE = 0.00669342162296594323
const R = 6378137.0

function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0
  return ret
}

function transformLon(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0
  return ret
}

export function wgs84ToGcj02(p: LngLat): LngLat {
  const [lng, lat] = p
  if (outOfChina(lng, lat)) return [lng, lat]
  let dLat = transformLat(lng - 105.0, lat - 35.0)
  let dLon = transformLon(lng - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI)
  dLon = (dLon * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI)
  return [lng + dLon, lat + dLat]
}

export function gcj02ToWgs84(p: LngLat): LngLat {
  const [lng, lat] = p
  if (outOfChina(lng, lat)) return [lng, lat]
  const [glng, glat] = wgs84ToGcj02(p)
  return [lng * 2 - glng, lat * 2 - glat]
}

export function haversine(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s))
}

export function localFrame(origin: LngLat): LocalFrame {
  return {
    origin,
    mxPerDegLng: (Math.cos((origin[1] * PI) / 180) * 2 * PI * R) / 360,
    myPerDegLat: (2 * PI * R) / 360,
  }
}

export function toLocal(frame: LocalFrame, p: LngLat): Vec2 {
  return {
    x: (p[0] - frame.origin[0]) * frame.mxPerDegLng,
    y: (p[1] - frame.origin[1]) * frame.myPerDegLat,
  }
}

export function toLngLat(frame: LocalFrame, v: Vec2): LngLat {
  return [frame.origin[0] + v.x / frame.mxPerDegLng, frame.origin[1] + v.y / frame.myPerDegLat]
}

/** 东向/北向米制偏移 */
export function offsetMeters(p: LngLat, dx: number, dy: number): LngLat {
  const f = localFrame(p)
  return toLngLat(f, { x: dx, y: dy })
}

export function bearingDeg(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * PI) / 180
  const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]))
  const x =
    Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
    Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]))
  return ((Math.atan2(y, x) * 180) / PI + 360) % 360
}

export function round(p: LngLat, digits = 6): LngLat {
  const k = 10 ** digits
  return [Math.round(p[0] * k) / k, Math.round(p[1] * k) / k]
}

export function bboxOf(points: LngLat[]): BBox {
  const box: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const [lng, lat] of points) {
    box.minX = Math.min(box.minX, lng)
    box.minY = Math.min(box.minY, lat)
    box.maxX = Math.max(box.maxX, lng)
    box.maxY = Math.max(box.maxY, lat)
  }
  return box
}

/** 经纬度距离（米）对应的度数（用于后端搜索半径估算） */
export function metersToDegrees(meters: number, lat: number): number {
  const f = localFrame([0, lat])
  return Math.max(meters / f.mxPerDegLng, meters / f.myPerDegLat)
}
