import type { CommunityModel, RoadPoint } from '../community/model.ts'
import type { Vec2 } from '../geo/types.ts'
import { localFrameFromFence, toLocalIn } from '../community/frame.ts'
import type { NetVertex, NetVerts } from './vertex.ts'

/**
 * 由社区模型构建内部路网图。
 *
 * 顶点 = gate / entrance / staging + roadway waypoints（hand-drawn bends）。
 * 路段是折点序列，相邻折点之间在图中相连：内部寻路只走这些“指挥员确认过的路段”，
 * 不使用高德导航替代社区内部路网，也不把楼间空隙当成道路。
 */
export type { NetVertex, NetVerts }

export function edgeGateNodeId(edgeIndex: number): string {
  return `edgegate:${edgeIndex}`
}

export function coordNodeId(p: RoadPoint | [number, number]): string {
  const lng = Array.isArray(p) ? p[0] : p.lng
  const lat = Array.isArray(p) ? p[1] : p.lat
  return `x:${lng.toFixed(6)},${lat.toFixed(6)}`
}

export function lngLatOf(p: RoadPoint): [number, number] {
  return Array.isArray(p) ? [p[0], p[1]] : [p.lng, p.lat]
}

export function dedupeWaypoints(road: RoadPoint[]): RoadPoint[] {
  const seen = new Set<string>()
  const out: RoadPoint[] = []
  for (const p of road) {
    const id = coordNodeId(p)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(p)
  }
  return out
}

export function buildVerts(model: CommunityModel): NetVerts {
  const { frame, localPoly, centroid } = localFrameFromFence(model.fence.polygon)
  const byId = new Map<string, NetVertex>()
  const byNode = new Map<string, NetVertex>()
  /** 坐标 → 节点顶点：路段端点写在坐标里，必须先认出它其实是某个大门/入口/接驳点 */
  const byCoord = new Map<string, NetVertex>()
  const put = (v: NetVertex) => {
    if (!byId.has(v.id)) byId.set(v.id, v)
  }
  const registerNode = (nodeKey: string, v: NetVertex, lngLat: [number, number]) => {
    byNode.set(nodeKey, v)
    byCoord.set(coordNodeId(lngLat), v)
    put(v)
  }
  for (const g of model.net.gates) registerNode(`gate:${g.id}`, { id: g.id, pos: g.local, kind: 'gate' }, [g.lngLat[0], g.lngLat[1]])
  for (const s of model.net.staging) registerNode(`staging:${s.id}`, { id: s.id, pos: s.local, kind: 'staging' }, [s.lngLat[0], s.lngLat[1]])
  for (const b of model.buildings) {
    registerNode(`entrance:${b.id}`, { id: `entrance:${b.id}`, pos: b.entrance.doorPoint, kind: 'entrance' }, [
      b.entrance.doorLngLat[0],
      b.entrance.doorLngLat[1],
    ])
  }

  const segments: Array<{ roadId: string; points: Vec2[] }> = []
  const edges: Array<{ roadId: string; a: Vec2; b: Vec2 }> = []
  const links: Array<{ a: string; b: string; roadId: string }> = []
  for (const road of model.net.roads) {
    const wps = dedupeWaypoints(road.points)
    if (wps.length < 2) continue
    const nodes: NetVertex[] = wps.map((wp) => {
      const [lng, lat] = lngLatOf(wp)
      const key = coordNodeId([lng, lat])
      const node = byCoord.get(key)
      if (node) return node
      let v = byNode.get(key)
      if (!v) {
        v = { id: key, pos: toLocalIn(frame, [lng, lat]), kind: 'junction' }
        byNode.set(key, v)
        put(v)
      }
      return v
    })
    segments.push({ roadId: road.id, points: nodes.map((n) => n.pos) })
    for (let i = 0; i < nodes.length - 1; i++) {
      if (nodes[i].id === nodes[i + 1].id) continue
      links.push({ a: nodes[i].id, b: nodes[i + 1].id, roadId: road.id })
      // 逐段登记：路段折线的每一小段都可能被积水淹没，封路与命中判断要按“段”而不是整条
      edges.push({ roadId: road.id, a: nodes[i].pos, b: nodes[i + 1].pos })
    }
  }
  return { byId, byNode, segments, edges, links, frame, frameLocal: localPoly, centroidLocal: centroid }
}
