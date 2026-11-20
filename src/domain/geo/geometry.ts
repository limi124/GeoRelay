import type { TurnSide, Vec2 } from './types.ts'

// 2D 几何：多边形、旋转矩形、折线。全部使用局部平面米制坐标。

export const EPS = 1e-9

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y }
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y }
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k }
}

export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

export function normalize(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y)
  return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}

export function perpLeft(a: Vec2): Vec2 {
  return { x: -a.y, y: a.x }
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y
}

export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x
}

/** 数学角度（弧度）转罗盘方位角：0°=北，90°=东 */
export function mathAngleToCompass(theta: number): number {
  return ((90 - (theta * 180) / Math.PI) % 360 + 360) % 360
}

export function compassToUnit(deg: number): Vec2 {
  const r = (deg * Math.PI) / 180
  return { x: Math.sin(r), y: Math.cos(r) }
}

// ---------------- 多边形 ----------------

/** 鞋带公式面积（绝对值，平方米） */
export function polygonArea(poly: Vec2[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

export function polygonSignedArea(poly: Vec2[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

export function polygonCentroid(poly: Vec2[]): Vec2 {
  let cx = 0
  let cy = 0
  let a2 = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const cr = a.x * b.y - b.x * a.y
    a2 += cr
    cx += (a.x + b.x) * cr
    cy += (a.y + b.y) * cr
  }
  if (Math.abs(a2) < EPS) {
    const n = poly.length || 1
    return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n }
  }
  a2 *= 3
  return { x: cx / a2, y: cy / a2 }
}

/** 凹多边形面积质心可能落在多边形外，此时回退到顶点均值或网格采样 */
export function polygonInteriorPoint(poly: Vec2[]): Vec2 {
  const c = polygonCentroid(poly)
  if (pointInPolygon(c, poly)) return c
  const n = poly.length
  const mean = { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n }
  if (pointInPolygon(mean, poly)) return mean
  const grid = sampleInside(poly, 12)
  return grid[0] ?? mean
}

export function sampleInside(poly: Vec2[], n: number): Vec2[] {
  const xs = poly.map((p) => p.x)
  const ys = poly.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const out: Vec2[] = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const p = { x: minX + ((i + 0.5) / n) * (maxX - minX), y: minY + ((j + 0.5) / n) * (maxY - minY) }
      if (pointInPolygon(p, poly)) out.push(p)
    }
  }
  return out
}

/** 射线法；边界上的点视为内部（调用方负责使用合适的内缩多边形） */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    const intersects = a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    if (intersects) inside = !inside
  }
  return inside
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a)
  const len2 = dot(ab, ab)
  if (len2 < EPS) return dist(p, a)
  let t = dot(sub(p, a), ab) / len2
  t = Math.max(0, Math.min(1, t))
  return dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t })
}

export function distToPolygonBoundary(p: Vec2, poly: Vec2[]): number {
  let m = Infinity
  for (let i = 0; i < poly.length; i++) {
    m = Math.min(m, distToSegment(p, poly[i], poly[(i + 1) % poly.length]))
  }
  return m
}

function onSegment(p: Vec2, a: Vec2, b: Vec2, eps = 1e-7): boolean {
  if (Math.abs(cross(sub(b, a), sub(p, a))) > eps) return false
  return p.x >= Math.min(a.x, b.x) - eps && p.x <= Math.max(a.x, b.x) + eps && p.y >= Math.min(a.y, b.y) - eps && p.y <= Math.max(a.y, b.y) + eps
}

function segmentsProperlyCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(sub(b, a), sub(c, a))
  const d2 = cross(sub(b, a), sub(d, a))
  const d3 = cross(sub(d, c), sub(a, c))
  const d4 = cross(sub(d, c), sub(b, c))
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function segmentsTouch(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  return (
    onSegment(c, a, b) ||
    onSegment(d, a, b) ||
    onSegment(a, c, d) ||
    onSegment(b, c, d) ||
    segmentsProperlyCross(a, b, c, d)
  )
}

export interface SelfIntersection {
  indexA: number
  indexB: number
  point: Vec2
}

/**
 * 自交检测。相邻边共享端点不算自交；非相邻边接触或相交都算。
 * 凹多边形是允许的 —— 只拒绝边与边交叉。
 */
export function findSelfIntersection(poly: Vec2[]): SelfIntersection | null {
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const a1 = poly[i]
    const a2 = poly[(i + 1) % n]
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === i || (j + 1) % n === i || i + 1 === j || i === (j + 1) % n
      const b1 = poly[j]
      const b2 = poly[(j + 1) % n]
      // 相邻边：允许共享端点，但要求不共线重叠
      if (adjacent) {
        const shared = dist(a1, b1) < 1e-7 ? a1 : dist(a1, b2) < 1e-7 ? a1 : dist(a2, b1) < 1e-7 ? a2 : a2
        const o1 = dist(a1, shared) < 1e-7 ? a2 : a1
        const o2 = dist(b1, shared) < 1e-7 ? b2 : b1
        // 两条边从共享点出发、方向相反的共线重叠
        const dirOut = sub(o1, shared)
        const dirIn = sub(o2, shared)
        const overlap = dist(shared, o1) > 0.2 && dist(shared, o2) > 0.2 && Math.abs(cross(normalize(dirOut), normalize(dirIn))) < 1e-6 && dot(dirOut, dirIn) < 0
        if (overlap) return { indexA: i, indexB: j, point: shared }
        continue
      }
      if (segmentsTouch(a1, a2, b1, b2)) {
        return { indexA: i, indexB: j, point: { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 } }
      }
    }
  }
  return null
}

// ---------------- 闭包恒等判定 ----------------

/** 判断点是否能沿直线看到多边形外（通过所有顶点向外放射的射线是否相交） */
export function pointSeesOutside(p: Vec2, poly: Vec2[]): boolean {
  const rays = 24
  for (let k = 0; k < rays; k++) {
    const ang = (k / rays) * Math.PI * 2
    const far = { x: p.x + Math.cos(ang) * 1e5, y: p.y + Math.sin(ang) * 1e5 }
    let blocked = false
    for (let i = 0; i < poly.length; i++) {
      if (segmentsProperlyCross(p, far, poly[i], poly[(i + 1) % poly.length])) {
        blocked = true
        break
      }
    }
    if (!blocked) return true
  }
  return false
}

// ---------------- 旋转矩形（楼栋底面） ----------------

export interface Rect {
  /** 中心 */
  c: Vec2
  /** 沿宽度方向（本地 x）的单位向量 */
  u: Vec2
  w: number
  d: number
}

export function rectCorners(r: Rect): Vec2[] {
  const u = r.u
  const v = perpLeft(u)
  const hw = r.w / 2
  const hd = r.d / 2
  return [
    add(r.c, add(scale(u, -hw), scale(v, -hd))),
    add(r.c, add(scale(u, hw), scale(v, -hd))),
    add(r.c, add(scale(u, hw), scale(v, hd))),
    add(r.c, add(scale(u, -hw), scale(v, hd))),
  ]
}

export function rectAxes(r: Rect): Vec2[] {
  return [r.u, perpLeft(r.u)]
}

export function rectProjection(r: Rect, axis: Vec2): number {
  return (r.w / 2) * Math.abs(dot(r.u, axis)) + (r.d / 2) * Math.abs(dot(perpLeft(r.u), axis))
}

/** SAT：两个旋转矩形是否重叠（gap>0 时要求分离至少 gap 米） */
export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  const centerGap = dist(a.c, b.c)
  if (centerGap > Math.hypot(a.w, a.d) / 2 + Math.hypot(b.w, b.d) / 2 + gap) return false
  const axes = [...rectAxes(a), ...rectAxes(b)]
  const d = sub(b.c, a.c)
  for (const ax of axes) {
    const p = Math.abs(dot(d, ax))
    const ra = rectProjection(a, ax)
    const rb = rectProjection(b, ax)
    if (p >= ra + rb + gap - 1e-9) return false
  }
  return true
}

export function rectContainsPoint(r: Rect, p: Vec2, margin = 0): boolean {
  const d = sub(p, r.c)
  return (
    Math.abs(dot(d, r.u)) <= r.w / 2 + margin + 1e-9 && Math.abs(dot(d, perpLeft(r.u))) <= r.d / 2 + margin + 1e-9
  )
}

// ---------------- 折线 ----------------

export function polylineLength(pts: Vec2[]): number {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i])
  return s
}

export interface Projection {
  seg: number
  t: number
  point: Vec2
  distance: number
  along: number
}

export function projectOnPolyline(p: Vec2, pts: Vec2[]): Projection {
  let best: Projection = { seg: 0, t: 0, point: pts[0], distance: Infinity, along: 0 }
  let acc = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const ab = sub(b, a)
    const len2 = dot(ab, ab)
    const len = Math.sqrt(len2)
    let t = len2 < EPS ? 0 : dot(sub(p, a), ab) / len2
    t = Math.max(0, Math.min(1, t))
    const q = { x: a.x + ab.x * t, y: a.y + ab.y * t }
    const d = dist(p, q)
    if (d < best.distance) best = { seg: i, t, point: q, distance: d, along: acc + t * len }
    acc += len
  }
  return best
}

/** 折线上距起点 s 米处的点 */
export function pointAtDistance(pts: Vec2[], s: number): Vec2 {
  if (pts.length === 0) return { x: 0, y: 0 }
  if (pts.length === 1) return pts[0]
  let remaining = Math.max(0, s)
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const len = dist(a, b)
    if (remaining <= len || i === pts.length - 2) return lerp(a, b, len < EPS ? 0 : Math.min(1, remaining / len))
    remaining -= len
  }
  return pts[pts.length - 1]
}

/** 折线在距离 s 处的朝向（方位角，用于标记旋转） */
export function headingAtDistance(pts: Vec2[], s: number): Vec2 {
  if (pts.length < 2) return { x: 0, y: 1 }
  let remaining = Math.max(0, s)
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const len = dist(a, b)
    if (remaining <= len || i === pts.length - 2) return normalize(sub(b, a))
    remaining -= len
  }
  return normalize(sub(pts[pts.length - 1], pts[pts.length - 2]))
}

export function turnSide(prev: Vec2, next: Vec2): TurnSide {
  const c = cross(prev, next)
  if (Math.abs(c) < 0.25) return 'straight'
  // 平面坐标 y 轴朝北；叉积>0 表示左转
  return c > 0 ? 'left' : 'right'
}

/** 折线简化（Douglas-Peucker，米） */
export function simplify(pts: Vec2[], tol = 1.5): Vec2[] {
  if (pts.length <= 2) return pts.slice()
  let maxD = -1
  let idx = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment(pts[i], pts[0], pts[pts.length - 1])
    if (d > maxD) {
      maxD = d
      idx = i
    }
  }
  if (maxD > tol) {
    const left = simplify(pts.slice(0, idx + 1), tol)
    const right = simplify(pts.slice(idx), tol)
    return [...left.slice(0, -1), ...right]
  }
  return [pts[0], pts[pts.length - 1]]
}

export function polylineIntersectsSegment(pts: Vec2[], a: Vec2, b: Vec2): boolean {
  for (let i = 0; i < pts.length - 1; i++) {
    if (segmentsTouch(pts[i], pts[i + 1], a, b)) return true
  }
  return false
}

/** 两条折线是否相交（含端点接触），用于“路线不经过封闭路段”校验之前的路由规则 */
export function polylinesIntersect(a: Vec2[], b: Vec2[]): boolean {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      if (segmentsTouch(a[i], a[i + 1], b[j], b[j + 1])) return true
    }
  }
  return false
}
