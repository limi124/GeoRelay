import type { NetVertex, RouteResult } from './vertex.ts'
import type { Vec2 } from '../geo/types.ts'

interface EdgeRef {
  to: string
  len: number
  roadId: string
}

/**
 * 社区内部路网的 Dijkstra（单源多终点）。
 * 代价 = 距离 + 少量“换路段拐弯”惩罚，倾向少拐弯的路线。
 * 刻意不实现 A* 的启发式：社区路网规模很小（几百个顶点），
 * Dijkstra 的最坏情况已经足够快，而结果更容易复现（同一输入必然同一路径）。
 */
export class DijkstraRouter {
  private adj = new Map<string, EdgeRef[]>()
  private pos = new Map<string, Vec2>()

  constructor(byId: Map<string, NetVertex>, links: Array<{ a: string; b: string; roadId: string }>) {
    for (const [id, v] of byId) this.pos.set(id, v.pos)
    for (const l of links) {
      const pa = byId.get(l.a)
      const pb = byId.get(l.b)
      if (!pa || !pb || l.a === l.b) continue
      const len = Math.hypot(pb.pos.x - pa.pos.x, pb.pos.y - pa.pos.y)
      push(this.adj, l.a, { to: l.b, len, roadId: l.roadId })
      push(this.adj, l.b, { to: l.a, len, roadId: l.roadId })
    }
  }

  hasVertex(id: string): boolean {
    return this.pos.has(id)
  }

  /** 顶点间直线距离（米） */
  distanceBetween(a: string, b: string): number {
    const pa = this.pos.get(a)
    const pb = this.pos.get(b)
    if (!pa || !pb) return Infinity
    return Math.hypot(pb.x - pa.x, pb.y - pa.y)
  }

  neighbours(id: string): EdgeRef[] {
    return this.adj.get(id) ?? []
  }

  /**
   * 最短路径。
   *
   * 封路只屏蔽**边**（blockedRoads），不屏蔽顶点：
   * 一条路的端点常常同时是另一条路的交叉点，若按顶点屏蔽，
   * 封一条横向通道就会顺带切断整条主动脉，改派必然失败。
   */
  shortest(startIds: string[], goalIds: string[], blockedVerts: Set<string>, blockedRoads: Set<string> = new Set()): RouteResult {
    const goals = new Set(goalIds.filter((g) => !blockedVerts.has(g)))
    const empty: RouteResult = { pathVertices: [], roadIds: [], distance: 0, cost: 0, bends: 0 }
    if (!goals.size) return empty
    const distMap = new Map<string, number>()
    const prev = new Map<string, { id: string; roadId: string }>()
    const bends = new Map<string, number>()
    const queue: Array<{ id: string; d: number }> = []
    for (const s of startIds) {
      if (blockedVerts.has(s) || !this.pos.has(s)) continue
      distMap.set(s, 0)
      bends.set(s, 0)
      queue.push({ id: s, d: 0 })
    }
    if (!queue.length) return empty
    const visited = new Set<string>()
    while (queue.length) {
      let best = 0
      for (let i = 1; i < queue.length; i++) if (queue[i].d < queue[best].d) best = i
      const cur = queue.splice(best, 1)[0]
      if (visited.has(cur.id)) continue
      visited.add(cur.id)
      if (goals.has(cur.id)) return this.reconstruct(cur.id, distMap, prev, bends)
      const prevRoad = prev.get(cur.id)?.roadId
      for (const e of this.adj.get(cur.id) ?? []) {
        if (blockedVerts.has(e.to) || blockedRoads.has(e.roadId) || visited.has(e.to)) continue
        const turn = prevRoad && prevRoad !== e.roadId ? 4 : 0
        const nd = cur.d + e.len + turn
        if (nd < (distMap.get(e.to) ?? Infinity)) {
          distMap.set(e.to, nd)
          prev.set(e.to, { id: cur.id, roadId: e.roadId })
          bends.set(e.to, (bends.get(cur.id) ?? 0) + (turn ? 1 : 0))
          queue.push({ id: e.to, d: nd })
        }
      }
    }
    return empty
  }

  /** 从起点出发可达的顶点集合（封路后判断连通性） */
  reachable(startIds: string[], blockedVerts: Set<string>, blockedRoads: Set<string> = new Set()): Set<string> {
    const seen = new Set<string>()
    const stack = startIds.filter((s) => !blockedVerts.has(s) && this.pos.has(s))
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      for (const e of this.adj.get(id) ?? []) {
        if (blockedVerts.has(e.to) || blockedRoads.has(e.roadId) || seen.has(e.to)) continue
        stack.push(e.to)
      }
    }
    return seen
  }

  private reconstruct(
    goal: string,
    distMap: Map<string, number>,
    prev: Map<string, { id: string; roadId: string }>,
    bends: Map<string, number>,
  ): RouteResult {
    const path: string[] = [goal]
    const roads: string[] = []
    let cur = goal
    while (prev.has(cur)) {
      const p = prev.get(cur)!
      path.unshift(p.id)
      roads.unshift(p.roadId)
      cur = p.id
    }
    let distance = 0
    for (let i = 1; i < path.length; i++) distance += this.distanceBetween(path[i - 1], path[i])
    return { pathVertices: path, roadIds: roads, distance, cost: distMap.get(goal) ?? distance, bends: bends.get(goal) ?? 0 }
  }
}

function push<T>(m: Map<string, T[]>, k: string, v: T): void {
  const arr = m.get(k)
  if (arr) arr.push(v)
  else m.set(k, [v])
}
