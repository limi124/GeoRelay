import type { CommunityModel } from '../domain/community/model.ts'
import type { HazardSpec } from '../domain/disaster/types.ts'
import type { LngLat, Vec2 } from '../domain/geo/types.ts'
import { fromLocal, localFrameFromFence, toLocalIn } from '../domain/community/frame.ts'
import { agentPosition, floodedAt, type Engine } from '../domain/sim/engine.ts'
import type { ResilienceReport } from '../domain/community/analysis.ts'
import { estimatedResidents, evacuationByBuilding } from '../domain/sim/evacuation.ts'
import type { Agent, Candidate, Plan, PlanSet, Responder } from '../domain/sim/types.ts'

/**
 * 沙盘（C）场景构建：把社区模型 + 演练状态投影成 2.5D 等轴测图形。
 *
 * 设计约束：
 *  - 只用「局部米制坐标」做投影，经纬度只用来查表 → 与 A 模式共用同一份社区版本与坐标系；
 *  - 输出是纯数据（多边形/折线/圆/文字 + 深度），由 `SandboxView` 渲染成 SVG，
 *    投影逻辑本身不依赖 DOM；
 *  - 楼高取自用户模型（`floors × floorHeightM`），不来自底图楼块；
 *  - 路线一律沿实际计算出的路网折线绘制，不画直线捷径。
 */

const AZ_COS = Math.cos(Math.PI / 4)
const AZ_SIN = Math.sin(Math.PI / 4)
const ELEV = 0.52 // 俯角系数：越大越“平视”
const Z_SCALE = 0.95 // 高度在屏幕上的缩放

export interface Pt {
  x: number
  y: number
}

/** 世界（局部米制，z 向上）→ 屏幕坐标（未平移缩放） */
export function project(v: Vec2, z: number): Pt {
  return {
    x: (v.x - v.y) * AZ_COS,
    y: (v.x + v.y) * AZ_SIN * ELEV - z * Z_SCALE,
  }
}

export type SceneTone = 'main' | 'muted' | 'mint' | 'warn' | 'external' | 'firefighter' | 'evacuation'
export type SandboxLayer = 'overview' | 'supply' | 'evacuation' | 'hazards'

const URGENCY_COLORS = [
  [0, [68, 181, 115]],
  [35, [229, 207, 104]],
  [60, [249, 150, 64]],
  [85, [239, 75, 75]],
] as const

function urgencyColor(score: number): string {
  const next = URGENCY_COLORS.findIndex(([threshold]) => threshold > score)
  const [end, to] = URGENCY_COLORS[next < 0 ? URGENCY_COLORS.length - 1 : next]
  const [start, from] = URGENCY_COLORS[next > 0 ? next - 1 : URGENCY_COLORS.length - 1]
  const fraction = end === start ? 0 : (score - start) / (end - start)
  return '#' + from.map((channel, i) => Math.round(channel + (to[i] - channel) * fraction).toString(16).padStart(2, '0')).join('')
}

export interface CommunityArrival {
  id: string
  kind: 'supply' | 'firefighter'
  path: LngLat[]
  label: string
}

export function projectArrival(frame: ReturnType<typeof localFrameFromFence>['frame'], path: LngLat[]): Pt[] {
  const local = path.map((point) => toLocalIn(frame, point))
  const tail = [local[local.length - 1]]
  let remaining = 75
  for (let i = local.length - 1; i > 0 && remaining > 0; i--) {
    const from = local[i - 1]
    const to = local[i]
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    if (!distance) continue
    const fraction = Math.min(1, remaining / distance)
    tail.unshift({ x: to.x + (from.x - to.x) * fraction, y: to.y + (from.y - to.y) * fraction })
    remaining -= distance
  }
  return tail.map((point) => project(point, 3))
}

export type SceneNode = (
  | { type: 'poly'; points: Pt[]; fill: string; stroke?: string; strokeWidth?: number; opacity?: number }
  | { type: 'line'; points: Pt[]; stroke: string; width: number; dash?: string; opacity?: number; cap?: 'round' | 'butt'; flow?: boolean }
  | { type: 'circle'; at: Pt; r: number; fill: string; stroke?: string; strokeWidth?: number }
  | { type: 'label'; at: Pt; text: string; tone: SceneTone; anchor?: 'start' | 'middle' | 'end'; hint?: string }
) & { layer?: 'flood' | 'fire' | 'earthquake' | 'closure' | 'risk' | 'evacuation' | 'occupancy' | 'dispatch' | 'urgency' }

export function buildingUrgency(engine: Engine, report: ResilienceReport | null, focusedId: string | null) {
  const { model, router } = engine.view
  const { state } = engine
  const evacuation = evacuationByBuilding(state.evacuation)
  const hazards = engine.disaster.plan.hazardsAt(state.clock.t)
  const impacts = Object.values(state.impacts)
  const wet = state.disaster === 'flood' ? floodedAt(engine).filter((part) => part.depthM > 0.04) : []
  return model.buildings.map((building) => {
    const issues = report?.issues.filter((issue) => issue.targetId === building.id && issue.level !== 'low') ?? []
    const focused = building.id === focusedId
    const isolated = issues.some((issue) => issue.kind === 'isolated')
    const priority = issues.some((issue) => issue.level === 'high')
    const residents = estimatedResidents(building.floors, model.unitsPerFloor)
    const inside = evacuation.get(building.id)?.inside ?? residents
    const exposure = Math.max(0,
      ...hazards.map((hazard) => {
        if (hazard.kind === 'smoke') {
          const a = toLocalIn(router.verts.frame, hazard.center)
          const b = toLocalIn(router.verts.frame, building.center)
          return 45 * Math.min(1, hazard.density) * Math.max(0, 1 - Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, hazard.radiusM))
        }
        return hazard.kind === 'damage' && pointInPolygon(building.center, hazard.path)
          ? { '轻微': 12, '中等': 24, '严重': 36, '倒塌': 45 }[hazard.level] : 0
      }),
      ...wet.map((part) => {
        const p = building.local.c
        const dx = part.b.x - part.a.x
        const dy = part.b.y - part.a.y
        const t = Math.max(0, Math.min(1, ((p.x - part.a.x) * dx + (p.y - part.a.y) * dy) / (dx * dx + dy * dy || 1)))
        return 45 * Math.min(1, part.depthM / 0.45) * Math.max(0, 1 - Math.hypot(p.x - part.a.x - dx * t, p.y - part.a.y - dy * t) / 55)
      }))
    const access = isolated ? 30 : priority || impacts.some((event) => event.traffic === 'blocked' && event.targetId.endsWith(`:${building.id}`)) ? 20 : issues.length ? 10 : 0
    const occupancy = Math.round(15 * inside / Math.max(1, residents))
    const vulnerable = Math.min(10, (building.vulnerable ?? 0) * 2) * inside / Math.max(1, residents)
    const score = Math.round(exposure + access + occupancy + vulnerable)
    const color = urgencyColor(score)
    const radiusM = Math.hypot(building.widthM, building.depthM) / 2 + 5 + score * 0.13
    const center = toLocalIn(router.verts.frame, building.center)
    const door = toLocalIn(router.verts.frame, building.entrance.doorLngLat)
    const direction = Math.atan2(door.y - center.y, door.x - center.x)
    const path = Array.from({ length: 23 }, (_, index) => {
      const angle = index * Math.PI * 2 / 23
      const radius = radiusM * (1 + 0.20 * Math.cos(angle - direction) + 0.13 * Math.cos(3 * angle + direction) + 0.065 * Math.sin(5 * angle - direction))
      return fromLocal(router.verts.frame, { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) })
    })
    const prevent = priority || score >= 45
    const zone: Extract<HazardSpec, { kind: 'risk' }> | null = focused || prevent || issues.length ? {
      id: building.id, kind: 'risk', center: building.center, radiusM, path, color, priority: prevent, focused,
      label: `${building.name} · ${score} 分 · ${isolated ? '图上孤岛' : prevent ? '重点预防' : issues.length ? '通达薄弱' : '已定位'}`,
    } : null
    return { id: building.id, name: building.name, score, color, inside, zone, path, exposure: Math.round(exposure), access, occupancy, vulnerable: Math.round(vulnerable) }
  })
}

export interface Placed {
  depth: number
  node: SceneNode
  /** 围栏外的 2D 底图：不参与视野计算，也不被围栏范围过滤掉 */
  backdrop?: boolean
}

export interface Scene {
  items: Placed[]
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  buildingCount: number
  roadCount: number
  damagedBuildingIds: string[]
  /** 沙盘里实际画出的楼栋高度（米），用于核对 A→C 高度一致 */
  buildingHeights: number[]
}

export const SANDBOX_THEME = {
  bg: '#191B1F',
  ground2d: '#191C20',
  groundGrid: 'rgba(120,132,142,0.09)',
  outerBlock: '#1E2226',
  outerBlockEdge: 'rgba(120,132,142,0.11)',
  fenceWall: 'rgba(159,240,184,0.14)',
  fenceLine: 'rgba(159,240,184,0.85)',
  slabTop: '#24272C',
  slabSide: '#141619',
  slabEdge: '#3B4046',
  road: '#6E747A',
  roadSuggested: '#5A6066',
  roof: '#EFEFEC',
  wallLit: '#DADBD5',
  wallShade: '#BCBEB8',
  buildingStroke: 'rgba(18,20,23,0.55)',
  targetRoof: '#E4F7E8',
  damagedRoof: '#E7B58F',
  routeActive: '#9FF0B8',
  routeCandidate: '#FFD18B',
  routeOriginal: '#8C9199',
  blocked: '#FF9D5C',
  agent: '#9FF0B8',
  agentExternal: '#75BFFF',
  agentFirefighter: '#FF9478',
  evacuation: '#D9C1FF',
  gate: '#F4F8EF',
  staging: '#9FF0B8',
  labelText: '#EDEFEA',
  labelMuted: '#9DA3A8',
}

const depthOf = (v: Vec2): number => v.x + v.y

function polygonDepth(poly: Vec2[]): number {
  let s = 0
  for (const p of poly) s += depthOf(p)
  return poly.length ? s / poly.length : 0
}

/** 楼栋棱柱：顶面 + 朝向观察者的墙面（背面不画） */
function prism(poly: Vec2[], heightM: number, roofFill: string): SceneNode[] {
  const nodes: SceneNode[] = []
  nodes.push({
    type: 'poly',
    points: poly.map((p) => project(p, heightM)),
    fill: roofFill,
    stroke: SANDBOX_THEME.buildingStroke,
    strokeWidth: 1,
  })
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % n]
    const pa = project(a, heightM)
    const pb = project(b, heightM)
    // 屏幕空间外法线：右手侧；法线朝下（ny > 0）的墙朝向观察者
    const nx = pb.y - pa.y
    const ny = -(pb.x - pa.x)
    if (ny <= 0) continue
    const shade = ny > Math.abs(nx) ? 0.62 : 0.82
    nodes.push({
      type: 'poly',
      points: [pa, pb, project(b, 0), project(a, 0)],
      fill: `color-mix(in srgb, ${roofFill} ${shade * 100}%, #172528)`,
      stroke: SANDBOX_THEME.buildingStroke,
      strokeWidth: 0.8,
    })
  }
  return nodes
}

/** 地台：围栏多边形顶面 + 朝向观察者的侧壁 */
function slab(poly: Vec2[], thicknessM: number): { nodes: SceneNode[]; depth: number } {
  const nodes: SceneNode[] = []
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % n]
    const pa = project(a, 0)
    const pb = project(b, 0)
    // 屏幕空间外法线的 y 分量：负数或零表示墙面背朝观察者
    const ny = -(pb.x - pa.x)
    if (ny <= 0) continue
    nodes.push({
      type: 'poly',
      points: [pa, pb, project(b, -thicknessM), project(a, -thicknessM)],
      fill: SANDBOX_THEME.slabSide,
      stroke: SANDBOX_THEME.slabEdge,
      strokeWidth: 1,
    })
  }
  nodes.push({
    type: 'poly',
    points: poly.map((p) => project(p, 0)),
    fill: SANDBOX_THEME.slabTop,
    stroke: SANDBOX_THEME.slabEdge,
    strokeWidth: 1.4,
  })
  return { nodes, depth: -1e9 }
}

/** 折线 → 带宽度的带状多边形（简单法线偏移） */
function ribbon(points: Vec2[], widthM: number): Pt[] {
  const left: Vec2[] = []
  const right: Vec2[] = []
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)]
    const next = points[Math.min(points.length - 1, i + 1)]
    const dx = next.x - prev.x
    const dy = next.y - prev.y
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len
    const ny = dx / len
    left.push({ x: points[i].x + (nx * widthM) / 2, y: points[i].y + (ny * widthM) / 2 })
    right.push({ x: points[i].x - (nx * widthM) / 2, y: points[i].y - (ny * widthM) / 2 })
  }
  return [...left, ...right.reverse()].map((p) => project(p, 0.45))
}

/** 点到围栏边界的最短距离（米，局部坐标） */
function distanceToFence(poly: Vec2[], p: Vec2): number {
  let best = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)))
  }
  return best
}

function pointInLocalPolygon(poly: Vec2[], p: Vec2): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x
    const yi = poly[i].y
    const xj = poly[j].x
    const yj = poly[j].y
    const hit = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
    if (hit) inside = !inside
  }
  return inside
}

/**
 * 只保留围栏内的连续路段。
 * 药店在社区外，外部路线整段都在围栏外 —— 沙盘不该把它画进地台，
 * 所以按“落在围栏内（含 3 m 边界容差）的最长连续段”裁剪。
 */
function clipToFence(poly: Vec2[], pts: Vec2[], tol = 3): Vec2[] {
  if (!pts.length) return []
  const inside = pts.map((p) => pointInLocalPolygon(poly, p) || distanceToFence(poly, p) <= tol)
  let bestStart = -1
  let bestLen = 0
  let start = -1
  for (let i = 0; i <= inside.length; i++) {
    const ok = i < inside.length && inside[i]
    if (ok && start < 0) start = i
    if (!ok && start >= 0) {
      if (i - start > bestLen) {
        bestLen = i - start
        bestStart = start
      }
      start = -1
    }
  }
  if (bestLen < 2) return []
  return pts.slice(bestStart, bestStart + bestLen)
}

function baselineOf(engine: Engine, taskId: string): Plan | null {
  const plans = Object.values(engine.state.plans).filter((p) => p.taskId === taskId)
  const blocked = plans.filter((p) => p.origin === 'baseline' && p.phase === 'blocked')
  if (blocked.length) return blocked[blocked.length - 1]
  return plans.find((p) => p.origin === 'baseline') ?? null
}

function activePlanOf(engine: Engine, taskId: string): Plan | null {
  const id = engine.state.assignments[taskId]
  return id ? engine.state.plans[id] ?? null : null
}

export function pickCandidate(planSet: PlanSet | null, selectedCandidateId: string | null): Candidate | null {
  if (!planSet) return null
  if (selectedCandidateId) {
    const c = planSet.candidates.find((x) => x.id === selectedCandidateId)
    if (c) return c
  }
  return planSet.candidates.filter((c) => c.feasible).sort((a, b) => a.rank - b.rank)[0] ?? planSet.candidates[0] ?? null
}

export interface SceneInput {
  layer?: SandboxLayer
  model: CommunityModel
  engine: Engine
  selectedTaskId: string | null
  selectedCandidateId: string | null
  planSet: PlanSet | null
  showHazards?: boolean
  resilience?: ResilienceReport | null
  focusedBuildingId?: string | null
  selectedImpactId?: string | null
}

export function buildScene(input: SceneInput): Scene {
  const { model, engine, selectedTaskId, selectedCandidateId, planSet } = input
  const showHazards = input.showHazards !== false
  const layer = input.layer ?? 'overview'
  const frame = localFrameFromFence(model.fence.polygon).frame
  const toV = (p: LngLat): Vec2 => toLocalIn(frame, p)

  const items: Placed[] = []
  const push = (node: SceneNode, depth: number, backdrop = false): void => {
    items.push({ depth, node, backdrop })
  }

  if (model.fence.polygon.length >= 3) {
    const s = slab(model.fence.polygon.map(toV), 8)
    for (const node of s.nodes) push(node, s.depth)

    // —— 围栏外：简化 2D 底图（网格 + 邻近街区 + 延伸道路），让社区坐在一块地图上 ——
    const fenceLocal = model.fence.polygon.map(toV)
    const fx = fenceLocal.map((q) => q.x)
    const fy = fenceLocal.map((q) => q.y)
    const cxL = (Math.min(...fx) + Math.max(...fx)) / 2
    const cyL = (Math.min(...fy) + Math.max(...fy)) / 2
    const spanL = Math.max(Math.max(...fx) - Math.min(...fx), Math.max(...fy) - Math.min(...fy))
    const halfL = Math.max(120, spanL * 1.5)
    const isoRect = (x0: number, y0: number, x1: number, y1: number): Pt[] =>
      [project({ x: x0, y: y0 }, 0), project({ x: x1, y: y0 }, 0), project({ x: x1, y: y1 }, 0), project({ x: x0, y: y1 }, 0)]
    push({ type: 'poly', points: isoRect(cxL - halfL, cyL - halfL, cxL + halfL, cyL + halfL), fill: SANDBOX_THEME.ground2d, opacity: 1 }, -1e9, true)
    const gridStep = 40
    for (let gx = Math.ceil((cxL - halfL) / gridStep) * gridStep; gx <= cxL + halfL; gx += gridStep) {
      push({ type: 'line', points: [project({ x: gx, y: cyL - halfL }, 0), project({ x: gx, y: cyL + halfL }, 0)], stroke: SANDBOX_THEME.groundGrid, width: 0.8 }, -1e8, true)
    }
    for (let gy = Math.ceil((cyL - halfL) / gridStep) * gridStep; gy <= cyL + halfL; gy += gridStep) {
      push({ type: 'line', points: [project({ x: cxL - halfL, y: gy }, 0), project({ x: cxL + halfL, y: gy }, 0)], stroke: SANDBOX_THEME.groundGrid, width: 0.8 }, -1e8, true)
    }
    // 邻近街区：确定性伪随机，围栏内不画（围栏内是用户自己的白模）
    let seedL = 20261119
    const rand = (): number => {
      seedL = (seedL * 1103515245 + 12345) & 0x7fffffff
      return seedL / 0x7fffffff
    }
    for (let gx = cxL - halfL; gx < cxL + halfL; gx += 51) {
      for (let gy = cyL - halfL; gy < cyL + halfL; gy += 51) {
        const w = 8 + rand() * 10
        const d = 7 + rand() * 9
        const ox = gx + rand() * 10
        const oy = gy + rand() * 10
        const inside = [[ox, oy], [ox + w, oy], [ox + w, oy + d], [ox, oy + d]].some(([qx, qy]) =>
          pointInLocalPolygon(fenceLocal, { x: qx, y: qy }),
        )
        if (inside) continue
        const far = Math.abs(ox - cxL) > halfL * 0.92 || Math.abs(oy - cyL) > halfL * 0.92
        if (far) continue
        // 围栏外只保留“2D 街区”的平面色块：白模只在围栏内，内外层次分明
        push(
          { type: 'poly', points: isoRect(ox, oy, ox + w, oy + d), fill: SANDBOX_THEME.outerBlock, stroke: SANDBOX_THEME.outerBlockEdge, strokeWidth: 0.7, opacity: 1 },
          -1e7,
          true,
        )
      }
    }
    // 大门外延伸道路：把社区路网接到围栏外的 2D 底图上
    for (const g of model.net.gates) {
      const gp = toLocalIn(frame, g.lngLat)
      let best: Vec2 | null = null
      let bestD = Infinity
      for (const r of model.net.roads) {
        for (const pt of r.points) {
          const v = toV(Array.isArray(pt) ? ([pt[0], pt[1]] as LngLat) : ([pt.lng, pt.lat] as LngLat))
          const dd = Math.hypot(v.x - gp.x, v.y - gp.y)
          if (dd < bestD) {
            bestD = dd
            best = v
          }
        }
      }
      if (!best) continue
      const dirX = gp.x - best.x
      const dirY = gp.y - best.y
      const len = Math.hypot(dirX, dirY) || 1
      const ext = 150
      const outer = { x: gp.x + (dirX / len) * ext, y: gp.y + (dirY / len) * ext }
      push({ type: 'poly', points: ribbon([gp, outer], 9), fill: '#2B3036', opacity: 0.95 }, -1e6, true)
      push({ type: 'poly', points: ribbon([gp, outer], 5.5), fill: '#3C434B', opacity: 0.9 }, -1e6 + 0.001, true)
    }

    // —— 电子围栏：一圈薄荷色矮墙 + 顶边虚线，把三维社区“包起来” ——
    const wallH = 14
    for (let i = 0; i < fenceLocal.length; i++) {
      const a = fenceLocal[i]
      const b = fenceLocal[(i + 1) % fenceLocal.length]
      const d = (a.x + a.y + b.x + b.y) / 2
      push(
        {
          type: 'poly',
          points: [project(a, 0), project(b, 0), project(b, wallH), project(a, wallH)],
          fill: SANDBOX_THEME.fenceWall,
          stroke: 'rgba(159,240,184,0.35)',
          strokeWidth: 0.8,
        },
        d - 0.01,
      )
      push({ type: 'line', points: [project(a, wallH), project(b, wallH)], stroke: SANDBOX_THEME.fenceLine, width: 2.2, dash: '10 7' }, d + 0.02)
      push({ type: 'line', points: [project(a, 0), project(b, 0)], stroke: 'rgba(159,240,184,0.5)', width: 1.6 }, d)
    }
  }

  // 灾情：受损楼栋（用模型 hazard 的几何落在哪栋楼上判断）
  const damaged = new Map<string, string>()
  const blockedPoints: Array<{ at: LngLat; name: string }> = []
  if (showHazards) {
    for (const h of engine.disaster.plan.hazardsAt(engine.state.clock.t)) {
      if (h.kind === 'damage' && h.path.length >= 3) {
        for (const b of model.buildings) if (pointInPolygon(b.center, h.path)) damaged.set(b.id, h.level)
      }
      if (h.kind === 'smoke') {
        const center = toV(h.center)
        const ring = Array.from({ length: 36 }, (_, i) => {
          const angle = i * Math.PI / 18
          return project({ x: center.x + h.radiusM * Math.cos(angle), y: center.y + h.radiusM * Math.sin(angle) }, 1)
        })
        push({ type: 'poly', layer: 'fire', points: ring, fill: '#FFA67D', opacity: Math.min(0.24, 0.10 + h.density * 0.14) }, 1e5)
        const core = project(center, 1)
        push({ type: 'poly', layer: 'fire', points: ring.map((p) => ({ x: core.x + (p.x - core.x) * 0.46, y: core.y + (p.y - core.y) * 0.46 })), fill: '#FFA67D', opacity: 0.13 }, 1e5 + 0.5)
        push({ type: 'line', layer: 'fire', points: [...ring, ring[0]], stroke: '#FFB084', width: 1.2, opacity: 0.52, dash: '5 4' }, 1e5 + 1)
        const at = project(center, 1)
        if (layer === 'hazards') push({ type: 'label', at: { x: at.x, y: at.y + 28 }, text: `烟雾范围 · 半径 ${Math.round(h.radiusM)} m`, tone: 'firefighter' }, 1e9 + 2)
      }
      if (h.kind === 'fire-origin') {
        const at = project(toV(h.center), 3)
        push({ type: 'circle', layer: 'fire', at, r: 8, fill: '#FF805F', stroke: '#FFE3D2', strokeWidth: 2 }, 1e9 + 2)
        push({ type: 'label', at: { x: at.x, y: at.y - 6 }, text: '起火点', tone: 'firefighter' }, 1e9 + 2.1)
      }
      if (h.kind === 'rupture' && h.path.length >= 2) {
        push({ type: 'line', layer: 'earthquake', points: h.path.map((p) => project(toV(p), 3)), stroke: '#FFB3EE', width: 6, dash: '2 6' }, 3e8)
        blockedPoints.push({ at: h.path[0], name: '地震断路' })
      }
    }
    for (const ev of Object.values(engine.state.impacts)) {
      if (ev.traffic === 'blocked' && ev.targetType === 'entrance' && ev.geometry?.kind === 'point') blockedPoints.push({ at: ev.geometry.at, name: '入口封闭' })
    }
    if (engine.state.disaster === 'flood') for (const f of floodedAt(engine)) {
      if (f.depthM < 0.05) continue
      const a = toV(fromLocal(engine.view.router.verts.frame, f.a))
      const b = toV(fromLocal(engine.view.router.verts.frame, f.b))
      push({ type: 'poly', layer: 'flood', points: ribbon([a, b], f.widthM), fill: '#79BBF7', opacity: Math.min(0.28, 0.07 + f.depthM * 0.35) * (layer === 'hazards' ? 1 : 0.53) }, 1e5)
    }
  }

  const task = selectedTaskId ? engine.state.tasks.find((t) => t.id === selectedTaskId) ?? null : null

  const residentGroups = evacuationByBuilding(engine.state.evacuation)
  const risks = new Map(buildingUrgency(engine, input.resilience ?? null, input.focusedBuildingId ?? null).map((risk) => [risk.id, risk]))
  for (const b of model.buildings) {
    const heightM = Math.max(3, b.floors * b.floorHeightM)
    const urgency = risks.get(b.id)!
    const risk = urgency.zone
    const focused = input.focusedBuildingId === b.id
    const damage = damaged.get(b.id)
    const roof = urgency.color
    const fp = b.footprint as Vec2[]
    const d = polygonDepth(fp)
    const nodes = prism(fp, heightM, roof)
    for (const node of nodes) push({ ...node, layer: 'urgency' }, 2e5 + d)
    if (damage) {
      const intensity = damage === '倒塌' ? 4 : damage === '严重' ? 3 : damage === '中等' ? 2 : 1
      const zone = urgency.path.map((point) => project(toV(point), 1))
      push({ type: 'poly', layer: 'earthquake', points: zone, fill: '#F4A2CF', stroke: '#F4A2CF', strokeWidth: 1, opacity: 0.08 + intensity * 0.046 }, 1e5 + d)
    }
    if (risk) {
      const color = risk.focused ? '#FFF1AD' : urgency.color
      const zone = risk.path!.map((point) => project(toV(point), 1))
      push({ type: 'poly', layer: 'risk', points: zone, fill: `${color}${layer === 'overview' || layer === 'hazards' ? '40' : '26'}`, stroke: `${color}BB`, strokeWidth: focused ? 2.8 : 1.4 }, 1.8e5 + d)
    }
    const group = residentGroups.get(b.id)
    const inside = group?.inside ?? estimatedResidents(b.floors, model.unitsPerFloor)
    const at = project(b.local.c, heightM + 4)
    const waitingInside = inside > 0 && Boolean(group?.waiting)
    if (layer === 'overview' || layer === 'evacuation' || focused || (layer === 'hazards' && risk)) {
      const text = layer === 'evacuation' ? `${b.name} · 楼内 ${inside} 人` : risk?.label ?? `${b.name} · ${urgency.score} 分`
      push({ type: 'label', layer: 'occupancy', at, text, tone: risk || waitingInside ? 'warn' : 'main', hint: `灾情 ${urgency.exposure} · 通达 ${urgency.access} · 楼内 ${urgency.occupancy} · 重点住户 ${urgency.vulnerable} · ${inside} 人${damage ? ` · ${damage}` : ''}` }, 3e9)
    }
    if (layer === 'supply') for (const order of engine.state.tasks.filter((item) => item.targetBuildingId === b.id)) {
      const plan = activePlanOf(engine, order.id)
      if (!plan) continue
      const status = plan.phase === 'delivered' ? '已送达' : plan.phase === 'blocked' ? '受阻' : plan.phase === 'delivering' ? '配送中' : plan.phase === 'external_enroute' ? '圈外在途' : '接驳待运'
      push({ type: 'label', layer: 'dispatch', at, text: `${order.code} · ${status}`, tone: plan.phase === 'blocked' ? 'warn' : 'mint', hint: `${b.name} · ${order.need.item} × ${order.need.qty}` }, 3e9)
    }
  }

  // 路网：未确认路段用虚线，已确认用带宽度路带
  for (const road of model.net.roads) {
    const pts = road.points.map((p) => toV(Array.isArray(p) ? ([p[0], p[1]] as LngLat) : ([p.lng, p.lat] as LngLat)))
    if (pts.length < 2) continue
    const d = polygonDepth(pts)
    if (road.status === 'suggested') {
      push({ type: 'line', points: pts.map((p) => project(p, 0.6)), stroke: SANDBOX_THEME.roadSuggested, width: 1.6, dash: '6 5' }, d + 1)
    } else {
      push({ type: 'poly', points: ribbon(pts, 7), fill: SANDBOX_THEME.road, opacity: 0.9 }, d)
    }
    const selectedScenarioRoad = layer === 'hazards' && engine.disaster.plan.events.some((event) => event.id === input.selectedImpactId && event.targetType === 'road' && event.targetId === road.id)
    if (showHazards && (engine.state.closures[road.id] || selectedScenarioRoad)) {
      const path = pts.map((p) => project(p, 2.8))
      const ev = Object.values(engine.state.impacts).find((e) => e.targetId === road.id && e.traffic === 'blocked')
      const depth = ev?.metrics?.depthM ?? engine.state.depths[road.id]
      push({ type: 'line', layer: 'closure', points: path, stroke: '#532823', width: 9, cap: 'round' }, 4e8)
      push({ type: 'line', layer: 'closure', points: path, stroke: '#FF916B', width: 5, dash: '7 4', cap: 'round' }, 4e8 + 1)
      const mid = path[Math.floor((path.length - 1) / 2)]
      const next = path[Math.floor((path.length - 1) / 2) + 1]
      if (layer === 'hazards' && (selectedScenarioRoad || ev?.id === input.selectedImpactId || Object.keys(engine.state.closures)[0] === road.id)) {
        const label = engine.state.closures[road.id] ? '封闭' : '模拟受阻点'
        push({ type: 'label', layer: 'closure', at: { x: (mid.x + next.x) / 2, y: (mid.y + next.y) / 2 - 7 }, text: `${road.name} · ${label}${depth > 0 ? ` · ${depth.toFixed(2)} m` : ''}`, tone: 'warn' }, 1e9 + 3)
      }
    }
  }

  // 路线：基线（灰虚线）→ 候选（薄荷绿虚线）→ 生效（薄荷绿实线）
  const fencePoly = model.fence.polygon.map(toV)
  const line = (points: LngLat[], style: 'original' | 'candidate' | 'active' | 'secondary' | 'delivered', depth: number): void => {
    if (points.length < 2) return
    // 只画围栏内的部分：外部药店到大门的那一段留给「外部支援地图」和底部接力条
    const clipped = clipToFence(fencePoly, points.map(toV))
    if (clipped.length < 2) return
    const pts = clipped.map((p) => project(p, style === 'active' ? 2.6 : style === 'candidate' ? 2.2 : 1.8))
    if (style === 'original') push({ type: 'line', layer: 'dispatch', points: pts, stroke: '#FFAC91', width: 2.4, dash: '7 6', cap: 'round' }, depth)
    if (style === 'candidate') push({ type: 'line', layer: 'dispatch', points: pts, stroke: SANDBOX_THEME.routeCandidate, width: 3.5, dash: '9 6', cap: 'round' }, depth)
    if (style === 'secondary') push({ type: 'line', layer: 'dispatch', points: pts, stroke: '#76D1DB', width: 2.6, opacity: 0.78, cap: 'round' }, depth)
    if (style === 'delivered') push({ type: 'line', layer: 'dispatch', points: pts, stroke: '#76D1DB', width: 2.2, opacity: layer === 'supply' ? 0.68 : 0.36, cap: 'round' }, depth)
    if (style === 'active') {
      push({ type: 'line', layer: 'dispatch', points: pts, stroke: '#76D1DB', width: 4, cap: 'round' }, depth)
      push({ type: 'line', layer: 'dispatch', points: pts, stroke: '#dffcff', width: 2, dash: '1 15', cap: 'round', flow: engine.state.clock.running }, depth + 0.1)
    }
  }

  for (const other of engine.state.tasks) {
    if (other.id === selectedTaskId) continue
    const plan = activePlanOf(engine, other.id)
    if (plan) line(plan.legs.internal?.path ?? plan.legs.external?.path ?? [], plan.phase === 'blocked' ? 'original' : plan.phase === 'delivered' ? 'delivered' : 'secondary', 2e8 - 1)
  }
  if (task) {
    const cand = pickCandidate(planSet, selectedCandidateId)
    const active = activePlanOf(engine, task.id)
    const base = baselineOf(engine, task.id)
    if (active?.phase === 'blocked') line(base?.legs.internal?.path ?? active.legs.internal?.path ?? active.legs.external?.path ?? [], 'original', 2e8)
    if (cand?.taskId === task.id && !planSet?.confirmedCandidateId) line(cand.internal?.path ?? [], 'candidate', 2e8 + 1)
    if (active?.phase !== 'blocked') line(active?.legs.internal?.path ?? active?.legs.external?.path ?? [], active?.phase === 'delivered' ? 'delivered' : 'active', 2e8 + 2)
  }

  // 关键节点与标签：只标大门、接驳点、目标楼栋
  for (const g of model.net.gates) {
    const p = project(toLocalIn(frame, g.lngLat), 0.5)
    push({ type: 'circle', at: p, r: 5, fill: SANDBOX_THEME.gate, stroke: 'rgba(20,22,25,0.8)', strokeWidth: 1.6 }, 1e9)
    if (layer === 'evacuation' || layer === 'supply') push({ type: 'label', at: { x: p.x, y: p.y - 10 }, text: g.name, tone: 'main', anchor: 'middle' }, 1e9 + 0.3)
  }
  for (const s of model.net.staging) {
    const selected = layer === 'hazards' && engine.disaster.plan.events.some((event) => event.id === input.selectedImpactId && event.targetType === 'staging' && event.targetId === s.id)
    if (selected) {
      const at = project(toV(s.lngLat), 1)
      push({ type: 'circle', layer: 'risk', at, r: 16, fill: '#FF986F44', stroke: '#FF986F', strokeWidth: 2 }, 1e9)
      push({ type: 'label', layer: 'risk', at: { x: at.x, y: at.y - 12 }, text: `${s.name} · 模拟受阻点`, tone: 'warn' }, 1e9 + 3)
    }
    const p = project(toLocalIn(frame, s.lngLat), 0.5)
    push({ type: 'circle', at: p, r: 5.5, fill: SANDBOX_THEME.staging, stroke: 'rgba(20,22,25,0.8)', strokeWidth: 1.6 }, 1e9)
    if (layer === 'supply') push({ type: 'label', at: { x: p.x, y: p.y - 11 }, text: s.name, tone: 'mint', anchor: 'middle' }, 1e9 + 0.4)
  }
  const gateNames = new Map(model.net.gates.map((gate) => [engine.view.router.gateVertex(gate.id), gate.name]))
  const exits = new Map<string, { p: Pt; count: number }>()
  const queues = new Map<string, { p: Pt; count: number }>()
  const activeEvacuation = engine.state.evacuation
  for (const group of activeEvacuation) {
    if (group.status === 'queued' || (!group.departed && group.status !== 'rescuing' && group.gateQueuedAt === undefined)) continue
    const p = project(toV(group.position), 6)
    if (group.gateQueuedAt !== undefined) {
      const id = group.vertices[0]
      const total = queues.get(id)?.count ?? 0
      queues.set(id, { p, count: total + group.residents })
      continue
    }
    if (group.status === 'arrived') {
      const gate = gateNames.get(group.vertices[0])
      const name = gate ? `${gate}外` : '专业救援集结点'
      const total = exits.get(name)?.count ?? 0
      exits.set(name, { p, count: total + group.residents })
      continue
    }
    const color = group.status === 'blocked' ? '#FFAC79' : SANDBOX_THEME.evacuation
    if (group.status === 'moving') {
      const remaining = group.vertices.slice(1).map((id) => engine.view.router.verts.byId.get(id)!.pos)
        .map((pos) => project(toV(fromLocal(engine.view.router.verts.frame, pos)), 4))
      const gate = remaining.at(-1) ?? p
      if (remaining.length) push({ type: 'line', layer: 'evacuation', points: [p, ...remaining], stroke: color, width: 3, dash: '5 3' }, 5e8)
      if (group.assembly) push({ type: 'line', layer: 'evacuation', points: [gate, project(toV(group.assembly), 4)], stroke: color, width: 2, dash: '1 5', cap: 'round' }, 5e8)
    }
    push({ type: 'circle', layer: 'evacuation', at: p, r: 7.5, fill: color, stroke: '#231D35', strokeWidth: 2 }, 2e9)
    const b = model.buildings.find((b) => b.id === group.buildingId)
    if (group.status !== 'moving' || layer === 'evacuation') {
      const status = group.status === 'rescuing' ? '转运' : group.status === 'blocked' ? '待援' : ''
      push({ type: 'label', layer: 'evacuation', at: { x: p.x, y: p.y + 8 }, text: `${group.residents} 人${status}`, tone: status ? 'warn' : 'evacuation', hint: b?.name }, 2e9 + 1)
    }
  }
  for (const [id, { p, count }] of queues) {
    push({ type: 'circle', layer: 'evacuation', at: p, r: 10, fill: '#FFAC79', stroke: '#231D35', strokeWidth: 2 }, 2e9)
    if (layer === 'evacuation') push({ type: 'label', layer: 'evacuation', at: { x: p.x + 6, y: p.y - 9 }, text: `${gateNames.get(id) ?? '出口'} · 排队 ${count} 人`, tone: 'warn', anchor: 'start' }, 3e9 + 1)
  }
  for (const [name, { p, count }] of exits) {
    push({ type: 'circle', layer: 'evacuation', at: p, r: 9, fill: '#332B53', stroke: SANDBOX_THEME.evacuation, strokeWidth: 2 }, 2e9)
    if (layer === 'evacuation') push({ type: 'label', layer: 'evacuation', at: { x: p.x + 6, y: p.y + 11 }, text: `${name} · ${count} 人已集结`, tone: 'evacuation', anchor: 'start' }, 2e9 + 1)
  }

  // 外部支援入口提示
  const activePlan = task ? activePlanOf(engine, task.id) : null
  const enteringGateId = activePlan?.legs.external?.atGate ?? null
  for (const g of model.net.gates) {
    const isEntry = enteringGateId ? `gate:${g.id}` === enteringGateId || g.id === enteringGateId.replace('gate:', '') : false
    if (!isEntry) continue
    const p = project(toLocalIn(frame, g.lngLat), 0.5)
    if (layer === 'supply') push({ type: 'label', at: { x: p.x, y: p.y + 22 }, text: '外部支援入口', hint: activePlan?.legs.external?.pharmacy.name, tone: 'external', anchor: 'middle' }, 1e9 + 0.45)
  }

  // 受阻点：橙点 + 叉号
  for (const bp of blockedPoints.slice(0, 6)) {
    const p = project(toLocalIn(frame, bp.at), 1.2)
    push({ type: 'circle', at: p, r: 8, fill: 'rgba(255,157,92,0.22)', stroke: SANDBOX_THEME.blocked, strokeWidth: 1.4 }, 1e9 + 0.6)
    push({ type: 'line', points: [{ x: p.x - 4, y: p.y - 4 }, { x: p.x + 4, y: p.y + 4 }], stroke: SANDBOX_THEME.blocked, width: 2, cap: 'round' }, 1e9 + 0.7)
    push({ type: 'line', points: [{ x: p.x + 4, y: p.y - 4 }, { x: p.x - 4, y: p.y + 4 }], stroke: SANDBOX_THEME.blocked, width: 2, cap: 'round' }, 1e9 + 0.7)
    if (layer === 'hazards') push({ type: 'label', at: { x: p.x, y: p.y + 17 }, text: bp.name, tone: 'warn' }, 1e9 + 0.8)
  }

  // 人员只读当前派单，角色取实际人员而非路线内/外段；同一人只保留一个当前位置。
  type Person = Pick<Agent | Responder, 'id' | 'name' | 'role'>
  const people = new Map<string, { person: Person; at: LngLat; status: string; selected: boolean; priority: number }>()
  const placePerson = (person: Person | undefined, at: LngLat | undefined | null, status: string, selected = false, priority = 0): void => {
    if (!person || !at) return
    const previous = people.get(person.id)
    // 执行/受阻优先于已完成/待命；同阶段优先展示选中任务，避免旧任务把人员拉回终点。
    if (previous && (previous.priority > priority || (previous.priority === priority && (previous.selected || !selected)))) return
    people.set(person.id, { person, at, status, selected, priority })
  }
  const idlePosition = (agent: Agent): LngLat | null => {
    const staging = model.net.staging.find((s) => `staging:${s.id}` === agent.stagingNodeKey || s.id === agent.stagingNodeKey)
    return agent.restingAt ?? staging?.lngLat ?? agent.origin
  }
  for (const planId of new Set(Object.values(engine.state.assignments))) {
    const plan = engine.state.plans[planId]
    if (!plan || plan.supersededBy) continue
    const assigned = engine.state.agents.find((a) => a.id === plan.agentId)
    const carrier = engine.state.agents.find((a) => a.id === plan.carryAgentId) ?? assigned
    const selected = plan.taskId === selectedTaskId
    const targetName = engine.state.tasks.find((t) => t.id === plan.taskId)?.targetName
    const destination = targetName ? ` · ${targetName}` : ''
    const start = plan.legs.internal?.path[0]
    const handover = plan.phase === 'handover_wait' || plan.phase === 'internal_ready'
    const carrying = plan.phase === 'delivering' || plan.phase === 'delivered' || plan.phase === 'blocked'
    const relay = plan.relay && carrier && assigned && carrier.id !== assigned.id

    if (carrying) {
      const pos = agentPosition(engine, plan)
      const status = plan.phase === 'blocked' ? '受阻待改派' : plan.phase === 'delivered' ? '已送达' : '配送中'
      placePerson(pos.leg === 'external' ? assigned : carrier, pos.lngLat, `${status}${destination}`, selected, plan.phase === 'delivered' ? 1 : 4)
    } else if (handover) {
      // 交接进度不是行走进度：双方仍在内部路径起点，不沿路径提前移动。
      placePerson(carrier, start ?? (carrier ? idlePosition(carrier) : null), '等待交接', selected, 3)
      if (relay) placePerson(assigned, start, '交接中', selected, 3)
    } else {
      const at = plan.phase === 'external_arrived'
        ? plan.legs.external?.path.at(-1)
        : plan.legs.external?.path.length
          ? agentPosition(engine, plan).lngLat
          : assigned ? idlePosition(assigned) : null
      const status = plan.phase === 'pickup_wait' ? '取货中' : plan.phase === 'external_arrived' ? '已到入口' : plan.phase === 'external_enroute' ? '前往取货' : '待命'
      placePerson(assigned, at, status, selected, plan.phase === 'planned' ? 0 : 4)
    }

    if (relay && !carrying && !handover) {
      placePerson(carrier, carrier.restingAt ?? start ?? idlePosition(carrier), '等待外部到达', selected, 2)
    }
  }
  for (const agent of engine.state.agents) {
    if (agent.role !== 'internal' || people.has(agent.id)) continue
    placePerson(agent, idlePosition(agent), agent.restingAt ? '原地待命' : '待命')
  }
  // 出警路途留给外部支援地图；只展示已到场消防员，远处消防站不参与沙盘边界。
  for (const responder of engine.state.responders ?? []) {
    if (responder.status !== 'arrived') continue
    placePerson(responder, responder.position, `已到场 · ${responder.targetName}`, false, 4)
  }

  for (const { person, at, status, selected, priority } of people.values()) {
    const local = toV(at)
    // 在真实位置判定是否属于社区（含 3 m 边界容差），绝不把界外人员投到社区入口。
    if (person.role !== 'firefighter' && !pointInLocalPolygon(fencePoly, local) && distanceToFence(fencePoly, local) > 3) continue
    const p = project(local, 1.6)
    const tone: SceneTone = person.role === 'external' ? 'external' : person.role === 'firefighter' ? 'firefighter' : 'mint'
    const color = person.role === 'external' ? SANDBOX_THEME.agentExternal : person.role === 'firefighter' ? SANDBOX_THEME.agentFirefighter : SANDBOX_THEME.agent
    // 同位置用同心标记保留每个人的角色色，不用偏移坐标制造虚假位置。
    const colocated = [...people.values()].filter((other) => other.at[0] === at[0] && other.at[1] === at[1])
    const ring = Math.min(7, (colocated.length - colocated.findIndex((other) => other.person.id === person.id) - 1) * 3)
    push({ type: 'circle', layer: 'dispatch', at: p, r: (selected ? 16 : 13) + ring, fill: `${color}36`, stroke: `${color}85`, strokeWidth: 1 }, 4e9)
    push({ type: 'circle', layer: 'dispatch', at: p, r: (selected ? 9 : 7.5) + ring, fill: color, stroke: '#141619', strokeWidth: 2 }, 4e9 + 1)
    // 同一接驳点可有多名人员：错开标签而不挪动真实位置，双方姓名和状态都可读。
    if (person.role === 'firefighter' || (layer === 'supply' && (selected || priority >= 2))) {
      const role = person.role === 'external' ? '外部志愿者' : '内部志愿者'
      push({ type: 'label', layer: 'dispatch', at: { x: p.x + 9, y: p.y + 18 }, text: person.role === 'firefighter' ? '消防已到场' : `${role} · ${status.split(' · ')[0]}`, hint: `${person.name} · ${status}`, tone, anchor: 'start' }, 4e9 + 2)
    }
  }

  const camera = [...fencePoly.map((p) => project(p, 0)), ...model.buildings.flatMap((b) =>
    b.footprint.map((p) => project(p, Math.max(3, b.floors * b.floorHeightM))))]
  const xs = camera.map((p) => p.x)
  const ys = camera.map((p) => p.y)

  return {
    items: items.sort((a, b) => a.depth - b.depth),
    bounds: camera.length ? { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) } : { minX: -100, minY: -100, maxX: 100, maxY: 100 },
    buildingCount: model.buildings.length,
    roadCount: model.net.roads.length,
    damagedBuildingIds: [...damaged.keys()],
    buildingHeights: model.buildings.map((b) => Math.max(3, b.floors * b.floorHeightM)),
  }
}

function pointInPolygon(p: LngLat, poly: LngLat[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0]
    const yi = poly[i][1]
    const xj = poly[j][0]
    const yj = poly[j][1]
    const intersect = yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}
