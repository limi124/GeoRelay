import type { CommunityModel } from '../community/model.ts'
import type { Vec2 } from '../geo/types.ts'
import type { NetVertex, NetVerts } from './vertex.ts'

/**
 * 备用入口（第二疏散门）。
 *
 * 现实里一栋楼通常不止一个出入口。火灾场景要求“原入口受阻时能否改走备用入口”，
 * 所以这里给每栋楼在**与正门相对的外立面**补一个备用门节点，并用一条接入边连到
 * 最近的内部路网顶点。备用门是真实图节点，因此：
 *  - 封住正门后，规划器仍可能从备用门送达（可达性是真的算出来的）；
 *  - 若备用门也被封（火灾 variant=no_alt），整栋楼就真的不可达，界面会说明原因。
 *
 * 接入边用合成路段 ID（`access:<楼栋>:alt`），不参与封路集合，
 * 避免“封一条主动脉就把备用门也顺带封掉”的假象。
 */
export function withAlternateDoors(base: NetVerts, model: CommunityModel): NetVerts {
  const byId = new Map(base.byId)
  const byNode = new Map(base.byNode)
  const links = [...base.links]

  for (const b of model.buildings) {
    const key = `entranceAlt:${b.id}`
    if (byNode.has(key)) continue
    const pos = oppositeFacePoint(b)
    // 连到最近的、不是楼栋入口的路网顶点（避免借用别的楼栋的门）
    let best: NetVertex | null = null
    let bestD = Infinity
    for (const v of byId.values()) {
      if (v.kind === 'entrance') continue
      const d = Math.hypot(v.pos.x - pos.x, v.pos.y - pos.y)
      if (d < bestD) {
        bestD = d
        best = v
      }
    }
    if (!best) continue
    const node: NetVertex = { id: key, pos, kind: 'entrance' }
    byId.set(key, node)
    byNode.set(key, node)
    links.push({ a: key, b: best.id, roadId: `access:${b.id}:alt` })
  }
  return { ...base, byId, byNode, links }
}

/** 与正门相对的外立面中点（楼栋局部坐标 → 社区局部坐标） */
function oppositeFacePoint(b: CommunityModel['buildings'][number]): Vec2 {
  const { c, u, w, d } = b.local
  const v = { x: -u.y, y: u.x }
  const edge = b.entrance?.edgeIndex ?? 0
  const opposite = (edge + 2) % 4
  const hw = w / 2
  const hd = d / 2
  const out =
    opposite === 0
      ? { x: c.x - v.x * hd, y: c.y - v.y * hd }
      : opposite === 1
        ? { x: c.x + u.x * hw, y: c.y + u.y * hw }
        : opposite === 2
          ? { x: c.x + v.x * hd, y: c.y + v.y * hd }
          : { x: c.x - u.x * hw, y: c.y - u.y * hw }
  // 略微外移 1.5 米，避免正好压在楼栋边界上
  const dir = { x: out.x - c.x, y: out.y - c.y }
  const len = Math.hypot(dir.x, dir.y) || 1
  return { x: out.x + (dir.x / len) * 1.5, y: out.y + (dir.y / len) * 1.5 }
}
