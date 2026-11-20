import type { LngLat, Vec2 } from '../geo/types.ts'
import type { CommunityModel } from '../community/model.ts'
import { fromLocal } from '../community/frame.ts'
import { toLocal as frameToLocal } from '../geo/wgs84.ts'
import { buildVerts } from './build.ts'
import { withAlternateDoors } from './doors.ts'
import type { NetVerts } from './vertex.ts'
import { DijkstraRouter } from './router.ts'
import type { RouteResult } from './vertex.ts'

export interface InternalRoute {
  ok: boolean
  /** 图中顶点序列 */
  vertexIds: string[]
  roadIds: string[]
  /** 内部路线经纬度折线（含接入段） */
  polyline: LngLat[]
  /** 起点接入段（界外点 → 大门/接驳点） */
  accessBefore: LngLat[]
  /** 终点接入段 */
  accessAfter: LngLat[]
  lengthM: number
  durationS: number
  /** 经过点的最大演练水深 */
  maxDepthM: number
  usedEdgeGate: boolean
  error?: string
}

export interface RouteOptions {
  /** 起点必须经由此大门进入（外部接驳任务使用同一个出入口 ID） */
  startGateId?: string
  /** 终点经由此大门离开 */
  endGateId?: string
  /** 直接指定目标节点键（楼栋入口 / 接驳点） */
  targetNodeKey?: string
  /** 不可通行的图中顶点（封路时写入） */
  blocked?: Set<string>
  /** 不可通行的路段 ID（封路时写入；只屏蔽边，不屏蔽交叉点） */
  blockedRoads?: Set<string>
  /** 允许从围栏边缘临时门进出 */
  allowEdgeGate?: boolean
  speed?: number
}

const WALK_SPEED = 1.15

/**
 * 社区内部路网规划器：只在指挥员确认过的路网上做 Dijkstra，
 * 不调用高德导航，也不把楼间空隙当成道路。
 */
export class CommunityRouter {
  readonly model: CommunityModel
  readonly verts: NetVerts
  readonly router: DijkstraRouter

  constructor(model: CommunityModel) {
    this.model = model
    this.verts = withAlternateDoors(buildVerts(model), model)
    this.router = new DijkstraRouter(this.verts.byId, this.verts.links)
  }

  private world(p: Vec2): LngLat {
    return fromLocal(this.verts.frame, p)
  }

  private local(p: LngLat): Vec2 {
    return frameToLocal(this.verts.frame, p)
  }

  /** 每条围栏边中点内侧的“临时门” */
  edgeGatePositions(): Array<{ id: string; pos: Vec2 }> {
    const poly = this.verts.frameLocal
    const c = this.verts.centroidLocal
    const out: Array<{ id: string; pos: Vec2 }> = []
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const d = { x: c.x - mid.x, y: c.y - mid.y }
      const l = Math.hypot(d.x, d.y) || 1
      out.push({ id: `edgegate:${i}`, pos: { x: mid.x + (d.x / l) * 10, y: mid.y + (d.y / l) * 10 } })
    }
    return out
  }

  gateVertex(gateId: string): string | null {
    return this.verts.byNode.get(`gate:${gateId}`)?.id ?? null
  }

  private entryFor(world: LngLat, opts: RouteOptions): { vertex: string | null; access: Vec2[]; usedEdgeGate: boolean } {
    const p = this.local(world)
    const blocked = opts.blocked ?? new Set<string>()
    if (opts.startGateId) {
      const gv = this.gateVertex(opts.startGateId)
      if (!gv) return { vertex: null, access: [], usedEdgeGate: false }
      return { vertex: gv, access: [p, this.verts.byId.get(gv)!.pos], usedEdgeGate: false }
    }
    const gates = this.model.net.gates
      .map((g) => this.verts.byNode.get(`gate:${g.id}`))
      .filter((v): v is NonNullable<typeof v> => Boolean(v))
      .sort((a, b) => Math.hypot(a.pos.x - p.x, a.pos.y - p.y) - Math.hypot(b.pos.x - p.x, b.pos.y - p.y))
    const nearest = gates.find((g) => !blocked.has(g.id)) ?? gates[0]
    if (nearest) return { vertex: nearest.id, access: [p, nearest.pos], usedEdgeGate: false }
    return this.edgeEntry(p, blocked)
  }

  private edgeEntry(p: Vec2, blocked: Set<string>): { vertex: string | null; access: Vec2[]; usedEdgeGate: boolean } {
    const gates = this.edgeGatePositions()
      .filter((g) => !blocked.has(g.id))
      .sort((a, b) => Math.hypot(a.pos.x - p.x, a.pos.y - p.y) - Math.hypot(b.pos.x - p.x, b.pos.y - p.y))
    const g = gates[0]
    if (!g) return { vertex: null, access: [], usedEdgeGate: false }
    return { vertex: g.id, access: [p, g.pos], usedEdgeGate: true }
  }

  /** 内部路线：界外点 → 大门 → 内部路网 → 目标入口 */
  route(from: LngLat, to: LngLat, opts: RouteOptions = {}): InternalRoute {
    const blocked = opts.blocked ?? new Set<string>()
    const blockedRoads = opts.blockedRoads ?? new Set<string>()
    const entry = this.entryFor(from, opts)
    if (!entry.vertex) return this.fail('社区还没有可用的接入点：请先在编辑器中标记大门')

    let targets: string[] = []
    let exact: string | null = null
    if (opts.targetNodeKey) {
      const v = this.verts.byNode.get(opts.targetNodeKey)
      if (v) {
        targets = [v.id]
        exact = v.id
      }
    } else if (opts.endGateId) {
      const gv = this.gateVertex(opts.endGateId)
      if (gv) targets = [gv]
    } else {
      targets = [...this.verts.byNode.entries()]
        .filter(([k]) => k.startsWith('entrance:') || k.startsWith('gate:') || k.startsWith('staging:'))
        .map(([, v]) => v.id)
        .filter((id) => !blocked.has(id))
    }
    if (!targets.length) return this.fail('内部目标附近没有可用的楼栋入口或接驳点')

    let result: RouteResult = this.router.shortest([entry.vertex], targets, blocked, blockedRoads)
    if (!result.pathVertices.length && opts.allowEdgeGate && !opts.startGateId) {
      const alt = this.edgeEntry(this.local(from), blocked)
      if (alt.vertex) {
        const retry = this.router.shortest([alt.vertex], targets, blocked, blockedRoads)
        if (retry.pathVertices.length) {
          entry.vertex = alt.vertex
          entry.access = alt.access
          entry.usedEdgeGate = true
          result = retry
        }
      }
    }
    if (!result.pathVertices.length) return this.fail('内部路网不可达：起点与目标之间没有连通且未封闭的路段')

    const pts: Vec2[] = [...entry.access, ...result.pathVertices.map((id) => this.verts.byId.get(id)!.pos)]
    let accessAfter: Vec2[] = []
    if (exact) {
      const p = this.local(to)
      const last = this.verts.byId.get(exact)!.pos
      if (Math.hypot(p.x - last.x, p.y - last.y) > 0.5) accessAfter = [last, p]
    }
    let length = 0
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    const all = [...pts, ...accessAfter.slice(1)]
    const speed = opts.speed ?? WALK_SPEED
    return {
      ok: true,
      vertexIds: result.pathVertices,
      roadIds: result.roadIds,
      polyline: all.map((p) => this.world(p)),
      accessBefore: entry.access.map((p) => this.world(p)),
      accessAfter: all.slice(pts.length - 1).map((p) => this.world(p)),
      lengthM: length,
      durationS: length / speed,
      maxDepthM: 0,
      usedEdgeGate: entry.usedEdgeGate,
    }
  }

  private fail(error: string): InternalRoute {
    return {
      ok: false,
      vertexIds: [],
      roadIds: [],
      polyline: [],
      accessBefore: [],
      accessAfter: [],
      lengthM: 0,
      durationS: 0,
      maxDepthM: 0,
      usedEdgeGate: false,
      error,
    }
  }
}
