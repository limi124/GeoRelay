import type { LngLat, Vec2 } from '../geo/types.ts'
import { haversine, localFrame, round, toLngLat } from '../geo/wgs84.ts'
import {
  add,
  dist,
  distToPolygonBoundary,
  findSelfIntersection,
  lerp,
  mathAngleToCompass,
  normalize,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  polygonInteriorPoint,
  rectContainsPoint,
  rectCorners,
  rectsOverlap,
  scale,
  simplify,
  sub,
} from '../geo/geometry.ts'
import type {
  BatchOptions,
  BatchResult,
  Building,
  BuildingStyle,
  CommunityModel,
  Fence,
  FenceValidation,
  Gate,
  Net,
  Road,
  Staging,
} from './model.ts'
import { fromLocal, localFrameFromFence } from './frame.ts'
import { uid } from '../util/id.ts'
import { rng } from '../util/rng.ts'

export const MIN_AREA_M2 = 1500
export const MAX_AREA_M2 = 2_000_000
export const MIN_BUILDING_SPACING_M = 3
export const MIN_FLOORS = 1
export const MAX_FLOORS = 60
export const MIN_FLOOR_HEIGHT_M = 2.2
export const MAX_FLOOR_HEIGHT_M = 6
export const MAX_BUILDINGS = 200

// ---------------- 围栏 ----------------

export function makeFence(polygon: LngLat[]): Fence {
  const { localPoly, areaM2 } = localFrameFromFence(polygon)
  return { polygon: polygon.map((p) => round(p)), localVertices: localPoly, areaM2 }
}

export function validateFence(polygon: LngLat[]): FenceValidation {
  const { localPoly, areaM2 } = localFrameFromFence(polygon)
  const errors: string[] = []
  const warnings: string[] = []
  if (polygon.length < 3) {
    return { ok: false, errors: ['围栏至少需要 3 个顶点'], warnings, areaM2: 0 }
  }
  for (let i = 0; i < localPoly.length; i++) {
    const a = localPoly[i]
    const b = localPoly[(i + 1) % localPoly.length]
    if (dist(a, b) < 1.5) errors.push(`第 ${i + 1} 与第 ${((i + 1) % localPoly.length) + 1} 个顶点过近（<1.5 米）`)
  }
  let selfIntersection: FenceValidation['selfIntersection']
  const si = findSelfIntersection(localPoly)
  if (si) {
    selfIntersection = si
    errors.push(`围栏第 ${si.indexA + 1} 条边与第 ${si.indexB + 1} 条边交叉（自交），请双击交叉顶点后拖动调整，或重新绘制`)
  }
  if (areaM2 < MIN_AREA_M2) errors.push(`围栏面积 ${Math.round(areaM2)} m² 过小（至少 ${MIN_AREA_M2} m²）`)
  if (areaM2 > MAX_AREA_M2) errors.push(`围栏面积 ${(areaM2 / 1e6).toFixed(2)} km² 过大（上限 2 km²）`)
  if (!errors.length) {
    let perimeter = 0
    for (let i = 0; i < localPoly.length; i++) perimeter += dist(localPoly[i], localPoly[(i + 1) % localPoly.length])
    const compactness = (perimeter * perimeter) / areaM2
    if (compactness > 320) warnings.push('围栏较为狭长，批量生成楼栋的空间可能不足')
  }
  return { ok: errors.length === 0, errors, warnings, areaM2, selfIntersection }
}

export function fenceCenter(fence: Fence): LngLat {
  const { localPoly } = localFrameFromFence(fence.polygon)
  const c = polygonInteriorPoint(localPoly)
  const f = localFrame(fence.polygon[0])
  return toLngLat(f, c)
}

/** 以某个点为中心生成矩形凹口围栏（示例） */
export function makeRectFence(center: LngLat, radiusM: number, verts = 8): LngLat[] {
  const frame = localFrame(center)
  const cx = toLocalX(frame, center)
  const out: LngLat[] = []
  for (let i = 0; i < verts; i++) {
    const ang = (i / verts) * Math.PI * 2 + Math.PI / verts
    out.push(round(toLngLat(frame, { x: cx.x + Math.cos(ang) * radiusM, y: cx.y + Math.sin(ang) * radiusM })))
  }
  return out
}

function toLocalX(frame: ReturnType<typeof localFrame>, p: LngLat): Vec2 {
  return { x: (p[0] - frame.origin[0]) * frame.mxPerDegLng, y: (p[1] - frame.origin[1]) * frame.myPerDegLat }
}

// ---------------- 楼栋 ----------------

function doorOnFootprint(corners: Vec2[], frame: ReturnType<typeof localFrameFromFence>['frame']): Building['entrance'] {
  const c = polygonCentroid(corners)
  let bestEdge = 0
  let bestScore = -Infinity
  for (let i = 0; i < 4; i++) {
    const a = corners[i]
    const b = corners[(i + 1) % 4]
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const outward = normalize(sub(mid, c))
    // 入口优先朝南（便于绘制），次要偏好朝东
    const score = -outward.y * 2 + outward.x * 0.2
    if (score > bestScore) {
      bestScore = score
      bestEdge = i
    }
  }
  const a = corners[bestEdge]
  const b = corners[(bestEdge + 1) % 4]
  const door = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  return { edgeIndex: bestEdge, doorPoint: door, doorLngLat: round(fromLocal(frame, door)) }
}

function makeBuilding(
  localC: Vec2,
  theta: number,
  w: number,
  d: number,
  floors: number,
  floorHeightM: number,
  frame: ReturnType<typeof localFrameFromFence>['frame'],
  seq: number,
  style: BuildingStyle,
): Building {
  const u = { x: Math.cos(theta), y: Math.sin(theta) }
  const corners = rectCorners({ c: localC, u, w, d })
  const center = fromLocal(frame, localC)
  return {
    id: uid('bld'),
    name: `${seq} 号楼`,
    local: { c: localC, u, w, d },
    footprint: corners,
    center: round(center),
    floors,
    floorHeightM,
    widthM: w,
    depthM: d,
    rotationDeg: Math.round(((mathAngleToCompass(theta) + 360) % 360) * 10) / 10,
    volumeM3: w * d * floors * floorHeightM,
    style,
    entrance: doorOnFootprint(corners, frame),
  }
}

export function buildingRect(b: Building) {
  return { c: b.local.c, u: b.local.u, w: b.local.w, d: b.local.d }
}

export function heightM(b: Building): number {
  return b.floors * b.floorHeightM
}

/** 单栋楼校验：整栋底面必须在围栏内，且与其它楼栋不重叠 */
export function validateBuilding(
  model: Pick<CommunityModel, 'fence' | 'buildings'>,
  b: Building,
  ignoreIds: string[] = [],
): { ok: boolean; errors: string[]; overlaps: string[] } {
  const errors: string[] = []
  const poly = model.fence.localVertices
  const corners = rectCorners(buildingRect(b))
  let inside = corners.every((p) => pointInPolygon(p, poly)) && distToPolygonBoundary(b.local.c, poly) > 0.01
  if (!inside) errors.push('楼栋底面超出围栏')
  for (let i = 0; i < 4 && inside; i++) {
    const a = corners[i]
    const c = corners[(i + 1) % 4]
    for (let k = 1; k < 4; k++) {
      const p = { x: a.x + ((c.x - a.x) * k) / 4, y: a.y + ((c.y - a.y) * k) / 4 }
      if (!pointInPolygon(p, poly)) {
        errors.push('楼栋底面超出围栏')
        inside = false
        break
      }
    }
  }
  const overlaps: string[] = []
  for (const o of model.buildings) {
    if (o.id === b.id || ignoreIds.includes(o.id)) continue
    if (rectsOverlap(buildingRect(b), buildingRect(o))) overlaps.push(o.id)
  }
  if (overlaps.length) {
    const names = overlaps.map((id) => model.buildings.find((x) => x.id === id)?.name ?? id)
    errors.push(`与 ${names.join('、')} 重叠`)
  }
  return { ok: errors.length === 0, errors, overlaps }
}

export function updateBuilding(model: CommunityModel, id: string, patch: { floors?: number; floorHeightM?: number; vulnerable?: number }): { model: CommunityModel; errors: string[] } {
  const errors: string[] = []
  const target = model.buildings.find((b) => b.id === id)
  if (!target) return { model, errors: ['楼栋不存在'] }
  const floors = patch.floors ?? target.floors
  const fh = patch.floorHeightM ?? target.floorHeightM
  if (!Number.isFinite(floors) || !Number.isInteger(floors) || floors < MIN_FLOORS || floors > MAX_FLOORS) {
    return { model, errors: [`层数需为 ${MIN_FLOORS}–${MAX_FLOORS} 的整数`] }
  }
  if (!Number.isFinite(fh) || fh < MIN_FLOOR_HEIGHT_M || fh > MAX_FLOOR_HEIGHT_M) {
    return { model, errors: [`单层层高需在 ${MIN_FLOOR_HEIGHT_M}–${MAX_FLOOR_HEIGHT_M} 米之间`] }
  }
  const vulnerable = patch.vulnerable ?? target.vulnerable ?? 0
  if (!Number.isFinite(vulnerable) || !Number.isInteger(vulnerable) || vulnerable < 0 || vulnerable > 200) {
    return { model, errors: ['重点住户数需为 0–200 的整数'] }
  }
  const buildings = model.buildings.map((b) =>
    b.id === id ? { ...b, floors, floorHeightM: fh, vulnerable, volumeM3: b.widthM * b.depthM * floors * fh } : b,
  )
  return { model: touch({ ...model, buildings }), errors }
}

export function removeBuilding(model: CommunityModel, id: string): CommunityModel {
  const buildings = model.buildings.filter((b) => b.id !== id).map((b, i) => ({ ...b, name: `${i + 1} 号楼` }))
  const roads = model.net.roads.filter((r) => !r.points.some((p) => nodeKeyOf(p, model) === `entrance:${id}`))
  return touch({ ...model, buildings, net: { ...model.net, roads } })
}

function worldToLocal(frame: ReturnType<typeof localFrameFromFence>['frame'], p: LngLat): Vec2 {
  return { x: (p[0] - frame.origin[0]) * frame.mxPerDegLng, y: (p[1] - frame.origin[1]) * frame.myPerDegLat }
}

export function moveBuilding(model: CommunityModel, id: string, centerLngLat: LngLat): { model: CommunityModel; errors: string[] } {
  const { frame } = localFrameFromFence(model.fence.polygon)
  const b = model.buildings.find((x) => x.id === id)
  if (!b) return { model, errors: ['楼栋不存在'] }
  const localC = worldToLocal(frame, centerLngLat)
  const moved: Building = {
    ...b,
    local: { ...b.local, c: localC },
    footprint: rectCorners({ c: localC, u: b.local.u, w: b.local.w, d: b.local.d }),
    center: round(centerLngLat),
  }
  const v = validateBuilding(model, moved)
  if (!v.ok) return { model, errors: v.errors }
  moved.entrance = doorOnFootprint(moved.footprint, frame)
  return { model: touch({ ...model, buildings: model.buildings.map((x) => (x.id === id ? moved : x)) }), errors: [] }
}

export function rotateBuilding(model: CommunityModel, id: string, deltaDeg: number): { model: CommunityModel; errors: string[] } {
  const { frame } = localFrameFromFence(model.fence.polygon)
  const b = model.buildings.find((x) => x.id === id)
  if (!b) return { model, errors: ['楼栋不存在'] }
  const theta = Math.atan2(b.local.u.y, b.local.u.x) + (deltaDeg * Math.PI) / 180
  const u = { x: Math.cos(theta), y: Math.sin(theta) }
  const rotated: Building = {
    ...b,
    local: { ...b.local, u },
    footprint: rectCorners({ c: b.local.c, u, w: b.local.w, d: b.local.d }),
    rotationDeg: Math.round(((mathAngleToCompass(theta) + 360) % 360) * 10) / 10,
  }
  const v = validateBuilding(model, rotated)
  if (!v.ok) return { model, errors: v.errors }
  rotated.entrance = doorOnFootprint(rotated.footprint, frame)
  return { model: touch({ ...model, buildings: model.buildings.map((x) => (x.id === id ? rotated : x)) }), errors: [] }
}

// ---------------- 批量生成 ----------------

interface Candidate {
  c: Vec2
  theta: number
  rowKey: number
}

/** 在给定间距下贪心放置，返回放下的候选 */
function place(
  candidates: Candidate[],
  count: number,
  w: number,
  d: number,
  spacing: number,
  existingRects: Array<{ c: Vec2; u: Vec2; w: number; d: number }>,
  existingSpacing: number,
): Candidate[] {
  const chosen: Candidate[] = []
  const rects: Array<{ c: Vec2; u: Vec2; w: number; d: number }> = []
  for (const cand of candidates) {
    if (chosen.length >= count) break
    const rect = { c: cand.c, u: { x: Math.cos(cand.theta), y: Math.sin(cand.theta) }, w, d }
    if (rects.some((r) => rectsOverlap(r, rect, spacing))) continue
    if (existingRects.some((r) => rectsOverlap(r, rect, existingSpacing))) continue
    chosen.push(cand)
    rects.push(rect)
  }
  return chosen
}

function spread(
  candidates: Candidate[],
  count: number,
  w: number,
  d: number,
  spacing: number,
  existing: ReturnType<typeof buildingRect>[],
  center: Vec2,
): Candidate[] {
  const distance = (a: Vec2, b: Vec2): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2
  const available = candidates.map((candidate) => {
    const rect = { c: candidate.c, u: { x: Math.cos(candidate.theta), y: Math.sin(candidate.theta) }, w, d }
    const score = existing.length ? Math.min(...existing.map((other) => distance(other.c, rect.c))) : -distance(center, rect.c)
    return { candidate, rect, score, valid: !existing.some((other) => rectsOverlap(other, rect, MIN_BUILDING_SPACING_M)) }
  })
  const chosen: Candidate[] = []
  while (chosen.length < count) {
    let best: typeof available[number] | undefined
    for (const item of available) if (item.valid && (!best || item.score > best.score)) best = item
    if (!best) break
    chosen.push(best.candidate)
    for (const item of available) {
      if (!item.valid) continue
      const separation = distance(best.rect.c, item.rect.c)
      item.score = chosen.length === 1 && !existing.length ? separation : Math.min(item.score, separation)
      if (separation < (Math.hypot(w, d) + 2 * spacing) ** 2 && rectsOverlap(best.rect, item.rect, spacing)) item.valid = false
    }
  }
  return chosen
}

/**
 * 批量生成楼栋：在围栏内尽量均匀分布。
 *
 * 优先选离现有楼栋最远的可用点，密排时以逐行放置补足容量。
 * 间距从宽松到紧凑逐步让步（最紧仍保证楼栋之间 ≥3 米、离围栏线 ≥1 米），
 * 因此在围栏中能放下时就不会因为“留白过大”而误报空间不足。
 */
export function generateBuildings(model: CommunityModel, opts: BatchOptions): BatchResult {
  const validation = validateFence(model.fence.polygon)
  if (!validation.ok) return { ok: false, reason: 'invalid', message: validation.errors.join('；'), capacity: 0, placed: 0 }
  if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > MAX_BUILDINGS) {
    return { ok: false, reason: 'invalid', message: `楼栋数量需为 1–${MAX_BUILDINGS} 的整数`, capacity: 0, placed: 0 }
  }
  if (opts.widthM < 4 || opts.widthM > 120 || opts.depthM < 4 || opts.depthM > 120) {
    return { ok: false, reason: 'invalid', message: '楼栋尺寸需在 4–120 米之间', capacity: 0, placed: 0 }
  }
  if (!Number.isInteger(opts.floors) || opts.floors < MIN_FLOORS || opts.floors > MAX_FLOORS) {
    return { ok: false, reason: 'invalid', message: `默认层数需为 ${MIN_FLOORS}–${MAX_FLOORS} 的整数`, capacity: 0, placed: 0 }
  }
  if (opts.floorHeightM < MIN_FLOOR_HEIGHT_M || opts.floorHeightM > MAX_FLOOR_HEIGHT_M) {
    return { ok: false, reason: 'invalid', message: `单层层高需在 ${MIN_FLOOR_HEIGHT_M}–${MAX_FLOOR_HEIGHT_M} 米之间`, capacity: 0, placed: 0 }
  }

  const { frame, localPoly, centroid } = localFrameFromFence(model.fence.polygon)
  const w = opts.widthM
  const d = opts.depthM
  const halfDiag = Math.hypot(w, d) / 2
  const inset = localPoly.map((p) => add(p, scale(normalize(sub(centroid, p)), halfDiag * 0.9 + 1)))
  const xs = inset.map((p) => p.x)
  const ys = inset.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const step = Math.max(2, Math.min(w, d) / 6)
  const rotations = [0, Math.PI / 2]
  const pitchY = d + MIN_BUILDING_SPACING_M
  const candidates: Candidate[] = []
  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      for (const theta of rotations) {
        const c = { x, y }
        const corners = rectCorners({ c, u: { x: Math.cos(theta), y: Math.sin(theta) }, w, d })
        if (!corners.every((p) => pointInPolygon(p, inset))) continue
        if (!corners.every((p) => pointInPolygon(p, localPoly))) continue
        if (corners.some((p) => distToPolygonBoundary(p, localPoly) < 1)) continue
        candidates.push({ c, theta, rowKey: Math.round(y / pitchY) })
      }
    }
  }
  // 行优先：北→南，行内西→东
  candidates.sort((a, b) => (b.rowKey - a.rowKey) || a.c.x - b.c.x)

  const existingRects = opts.keepExisting ? model.buildings.map(buildingRect) : []
  const spacings = [
    Math.max(w, d) * 0.32 + 8,
    Math.max(w, d) * 0.24 + MIN_BUILDING_SPACING_M,
    Math.max(w, d) * 0.16 + MIN_BUILDING_SPACING_M,
    MIN_BUILDING_SPACING_M,
  ]
  let chosen: Candidate[] = []
  let usedSpacing = spacings[0]
  for (const spacing of spacings) {
    chosen = place(candidates, opts.count, w, d, spacing, existingRects, MIN_BUILDING_SPACING_M)
    usedSpacing = spacing
    if (chosen.length >= opts.count) {
      const distributed = spread(candidates, opts.count, w, d, spacing + 1, existingRects, centroid)
      if (distributed.length === opts.count) chosen = distributed
      break
    }
  }

  if (chosen.length < opts.count) {
    // 用“能放下的最大数量”作为可执行建议
    const capacity = chosen.length
    const suggestion = capacity > 0 ? `当前围栏最多可放置 ${capacity} 栋` : '当前围栏一栋也放不下'
    return {
      ok: false,
      reason: capacity === 0 ? 'tight' : 'too_many',
      message: `围栏内空间不足：${suggestion}。请减少楼栋数量、减小楼栋尺寸，或扩大围栏后重试。`,
      capacity,
      placed: capacity,
    }
  }

  const seq = chosen.slice().sort((a, b) => (b.rowKey - a.rowKey) || a.c.x - b.c.x)
  const startIndex = opts.keepExisting ? model.buildings.length + 1 : 1
  const buildings: Building[] = seq.map((cand, i) => {
    const style: BuildingStyle = opts.floors >= 20 ? 'highrise' : opts.floors >= 7 ? 'residential' : 'public'
    const j = rng(opts.seed + i * 7919)
    const jx = (j.next() - 0.5) * Math.min(2.4, step * 0.3)
    const jy = (j.next() - 0.5) * Math.min(2.4, step * 0.3)
    const c = { x: cand.c.x + jx, y: cand.c.y + jy }
    const corners = rectCorners({ c, u: { x: Math.cos(cand.theta), y: Math.sin(cand.theta) }, w, d })
    const ok = corners.every((p) => pointInPolygon(p, localPoly)) && corners.every((p) => distToPolygonBoundary(p, localPoly) >= 0.5)
    return makeBuilding(ok ? c : cand.c, cand.theta, w, d, opts.floors, opts.floorHeightM, frame, startIndex + i, style)
  })

  const ordered = opts.keepExisting ? [...model.buildings, ...buildings] : buildings
  const result: CommunityModel = touch({
    ...model,
    buildings: ordered,
    generation: { count: opts.count, floors: opts.floors, floorHeightM: opts.floorHeightM, widthM: w, depthM: d },
  })
  const warning = usedSpacing < Math.max(w, d) * 0.2 ? '空间较紧，楼栋间距已压缩到接近最小间距' : undefined
  return { ok: true, model: result, placed: buildings.length, warning }
}

// ---------------- 路网 ----------------

type RoadPointLike = Road['points'][number]

function lngLatOf(p: RoadPointLike): LngLat {
  return Array.isArray(p) ? [p[0], p[1]] : [p.lng, p.lat]
}

export function nodeKeyOf(p: RoadPointLike, model: Pick<CommunityModel, 'net' | 'buildings'>): string | null {
  const [lng, lat] = lngLatOf(p)
  for (const g of model.net.gates) if (Math.abs(g.lngLat[0] - lng) < 1e-6 && Math.abs(g.lngLat[1] - lat) < 1e-6) return `gate:${g.id}`
  for (const s of model.net.staging) if (Math.abs(s.lngLat[0] - lng) < 1e-6 && Math.abs(s.lngLat[1] - lat) < 1e-6) return `staging:${s.id}`
  for (const b of model.buildings) {
    if (Math.abs(b.entrance.doorLngLat[0] - lng) < 1e-6 && Math.abs(b.entrance.doorLngLat[1] - lat) < 1e-6) return `entrance:${b.id}`
  }
  return null
}

export function addGate(model: CommunityModel, lngLat: LngLat, name?: string): CommunityModel {
  const { frame } = localFrameFromFence(model.fence.polygon)
  const g: Gate = {
    id: uid('gate'),
    name: name ?? `大门 ${model.net.gates.length + 1}`,
    lngLat: round(lngLat),
    local: worldToLocal(frame, lngLat),
  }
  return touch({ ...model, net: { ...model.net, gates: [...model.net.gates, g] } })
}

export function renameGate(model: CommunityModel, id: string, name: string): CommunityModel {
  return touch({ ...model, net: { ...model.net, gates: model.net.gates.map((g) => (g.id === id ? { ...g, name } : g)) } })
}

export function addStaging(model: CommunityModel, lngLat: LngLat, name?: string): CommunityModel {
  const { frame } = localFrameFromFence(model.fence.polygon)
  const s: Staging = {
    id: uid('stg'),
    name: name ?? `接驳点 ${model.net.staging.length + 1}`,
    lngLat: round(lngLat),
    local: worldToLocal(frame, lngLat),
  }
  return touch({ ...model, net: { ...model.net, staging: [...model.net.staging, s] } })
}

export function removeNetNode(model: CommunityModel, nodeKey: string): CommunityModel {
  const [kind, id] = nodeKey.split(':')
  const net: Net = { ...model.net }
  if (kind === 'gate') net.gates = net.gates.filter((g) => g.id !== id)
  if (kind === 'staging') net.staging = net.staging.filter((s) => s.id !== id)
  net.roads = net.roads.filter((r) => !r.points.some((p) => nodeKeyOf(p, model) === nodeKey))
  return touch({ ...model, net })
}

export function confirmRoads(model: CommunityModel): CommunityModel {
  return touch({ ...model, net: { ...model.net, roads: model.net.roads.map((r) => ({ ...r, status: 'user' as const })) } })
}

export function removeRoad(model: CommunityModel, roadId: string): CommunityModel {
  return touch({ ...model, net: { ...model.net, roads: model.net.roads.filter((r) => r.id !== roadId) } })
}

export function addRoad(model: CommunityModel, points: LngLat[], name?: string): CommunityModel {
  const road: Road = {
    id: uid('road'),
    points: points.map((p) => round(p)),
    name: name ?? `路段 ${model.net.roads.length + 1}`,
    status: 'user',
  }
  return touch({ ...model, net: { ...model.net, roads: [...model.net.roads, road] } })
}

/** 在路段中间插入拐点（拖动路段形状时使用） */
export function insertRoadPoint(model: CommunityModel, roadId: string, index: number, p: LngLat): CommunityModel {
  const roads = model.net.roads.map((r) => {
    if (r.id !== roadId) return r
    const pts = r.points.slice()
    pts.splice(index + 1, 0, round(p))
    return { ...r, points: pts, status: 'user' as const }
  })
  return touch({ ...model, net: { ...model.net, roads } })
}

/**
 * 生成示例路网（供指挥员调整）。
 *
 * 关键约束：**生成的支线必须吸附到主轴线上真实存在的顶点**，否则图中会出现
 * “看起来连着、其实断开的”两条折线，寻路会失败。所以这里先把主轴采样成点列，
 * 支线与接驳点一律从这些采样点出发。
 *
 * 全部标记为 suggested，必须由指挥员确认后才算可通行。
 */
export function suggestNetwork(model: CommunityModel): CommunityModel {
  const { frame, localPoly } = localFrameFromFence(model.fence.polygon)
  if (!model.net.gates.length) return model
  const roads: Road[] = []
  const rects = model.buildings.map(buildingRect)
  const toWorld = (p: Vec2): LngLat => round(fromLocal(frame, p))
  const center = polygonInteriorPoint(localPoly)

  /** 主轴采样点（局部坐标），与生成的 Road.points 一一对应 */
  const axes: Array<{ gateId: string; samples: Vec2[]; dir: Vec2 }> = []

  for (const g of model.net.gates) {
    const dir = normalize(sub(center, g.local))
    const samples: Vec2[] = [g.local]
    for (let s = 12; s < 460; s += 12) {
      const q = add(g.local, scale(dir, s))
      if (!pointInPolygon(q, localPoly)) break
      if (rects.some((r) => rectContainsPoint(r, q, 1.5))) break
      samples.push(q)
    }
    if (samples.length === 1) samples.push(add(g.local, scale(dir, 12)))
    roads.push({ id: uid('road'), points: samples.map(toWorld), name: `${g.name} 主动脉`, status: 'suggested' })
    axes.push({ gateId: g.id, samples, dir })
  }

  /** 找离某点最近的轴线采样点（用于支线起点，保证图连通） */
  const nearestSample = (p: Vec2): { axis: (typeof axes)[number]; idx: number; d: number } | null => {
    let best: { axis: (typeof axes)[number]; idx: number; d: number } | null = null
    for (const axis of axes) {
      for (let i = 0; i < axis.samples.length; i++) {
        const d = dist(axis.samples[i], p)
        if (!best || d < best.d) best = { axis, idx: i, d }
      }
    }
    return best
  }

  // 楼栋入口支线：从最近的轴线采样点出发（同一坐标 → 图中为同一顶点）
  for (const b of model.buildings) {
    const door = b.entrance.doorPoint
    const near = nearestSample(door)
    if (!near || near.d > 190) continue
    const foot = near.axis.samples[near.idx]
    if (rects.some((r) => rectContainsPoint(r, foot, 1))) continue
    const side = { x: -near.axis.dir.y, y: near.axis.dir.x }
    const rel = sub(door, foot)
    const across = rel.x * side.x + rel.y * side.y
    const dots: Vec2[] = [foot]
    // 直角走法：先沿轴线横移，再进楼栋入口；拐点要避开楼栋
    if (Math.abs(across) > 3) {
      const elbow = add(foot, scale(side, across))
      if (!rects.some((r) => rectContainsPoint(r, elbow, 1))) dots.push(elbow)
    }
    if (dist(dots[dots.length - 1], door) > 1) dots.push(door)
    if (dots.length < 2) continue
    roads.push({ id: uid('road'), points: dots.map(toWorld), name: `${b.name} 入口支线`, status: 'suggested' })
  }

  // 接驳点支线：同样吸附到最近的轴线采样点
  for (const s of model.net.staging) {
    const near = nearestSample(s.local)
    if (!near) continue
    const foot = near.axis.samples[near.idx]
    if (dist(foot, s.local) < 2) continue
    roads.push({ id: uid('road'), points: [toWorld(foot), round(s.lngLat)].map((p) => round(lngLatOf(p))), name: `${s.name} 接驳支线`, status: 'suggested' })
  }

  // 横向通道：在若干深度把相邻主动脉连起来，形成网格而不是“一根独木桥”。
  // 单通路路网一旦封路就会把楼栋彻底隔离，改派也就无从谈起；
  // 真实小区通常有环路，这里按同样的思路生成多条通道。
  if (axes.length >= 2) {
    const depths = [0.28, 0.55, 0.82]
    for (const frac of depths) {
      for (let i = 0; i < axes.length; i++) {
        const a = axes[i]
        const b = axes[(i + 1) % axes.length]
        const ia = Math.max(1, Math.min(a.samples.length - 1, Math.round((a.samples.length - 1) * frac)))
        const ib = Math.max(1, Math.min(b.samples.length - 1, Math.round((b.samples.length - 1) * frac)))
        const from = a.samples[ia]
        const to = b.samples[ib]
        if (dist(from, to) < 8) continue
        const pts: Vec2[] = [from]
        const dirAB = normalize(sub(to, from))
        const side = { x: -dirAB.y, y: dirAB.x }
        // 轻微绕开楼栋：若中点落在楼里，就往垂直方向让一步
        const mid = lerp(from, to, 0.5)
        if (rects.some((r) => rectContainsPoint(r, mid, 2))) {
          const offset = add(mid, scale(side, 18))
          const offset2 = add(mid, scale(side, -18))
          const pick = rects.some((r) => rectContainsPoint(r, offset, 1)) ? offset2 : offset
          if (!rects.some((r) => rectContainsPoint(r, pick, 1))) pts.push(pick)
        }
        pts.push(to)
        roads.push({ id: uid('road'), points: pts.map(toWorld), name: `横向通道 ${i + 1}-${Math.round(frac * 100)}`, status: 'suggested' })
      }
    }
  }
  return touch({ ...model, net: { ...model.net, roads } })
}

/** 路网完备性检查（确认路网前调用） */
export function validateNetwork(model: CommunityModel): { ok: boolean; errors: string[]; warnings: string[]; unlinked: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!model.net.gates.length) errors.push('至少标记一个小区大门')
  if (!model.net.roads.length) errors.push('至少确认一条可通行路段')
  const touched = new Set<string>()
  for (const r of model.net.roads) {
    if (r.points.length < 2) continue
    for (const p of r.points) {
      const k = nodeKeyOf(p, model)
      if (k) touched.add(k)
    }
  }
  const gateTouched = model.net.gates.some((g) => touched.has(`gate:${g.id}`))
  if (model.net.gates.length && !gateTouched) errors.push('没有路段连接小区大门')
  const unlinked = model.buildings.filter((b) => !touched.has(`entrance:${b.id}`)).map((b) => b.name)
  if (model.buildings.length && unlinked.length === model.buildings.length) errors.push('所有楼栋入口都未接入路段')
  else if (unlinked.length) warnings.push(`${unlinked.join('、')} 的入口未接入路段（演练中不可达）`)
  const suggested = model.net.roads.filter((r) => r.status === 'suggested').length
  if (suggested) errors.push(`还有 ${suggested} 条示例路段未确认`)
  return { ok: errors.length === 0, errors, warnings, unlinked }
}

// ---------------- 其他 ----------------

export function touch(model: CommunityModel): CommunityModel {
  return { ...model, updatedAt: new Date().toISOString() }
}

export function createEmptyModel(center: LngLat, name = '我的社区'): CommunityModel {
  return {
    version: 2,
    id: uid('cm'),
    name,
    address: '',
    center,
    fence: { polygon: [], localVertices: [], areaM2: 0 },
    buildings: [],
    net: { gates: [], staging: [], roads: [] },
    generation: { count: 12, floors: 8, floorHeightM: 2.9, widthM: 22, depthM: 15 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

export function simplifyPolygon(points: LngLat[], tol = 2.5): LngLat[] {
  const { frame, localPoly } = localFrameFromFence(points)
  return simplify(localPoly, tol).map((p) => round(toLngLat(frame, p)))
}

export function polygonPerimeterM(polygon: LngLat[]): number {
  if (polygon.length < 2) return 0
  const { localPoly } = localFrameFromFence(polygon)
  let s = 0
  for (let i = 0; i < localPoly.length; i++) s += dist(localPoly[i], localPoly[(i + 1) % localPoly.length])
  return s
}

export function polygonAreaM2(polygon: LngLat[]): number {
  return polygonArea(localFrameFromFence(polygon).localPoly)
}

export { haversine as distanceMeters }
