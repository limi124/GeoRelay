import type { LngLat } from '../geo/types.ts'
import type { CommunityModel } from '../community/model.ts'
import type { DrillConfig, InventoryPoint, Task, Agent } from './types.ts'
import { rng, hashSeed } from '../util/rng.ts'
import { localFrameFromFence } from '../community/frame.ts'
import { dist, normalize, sub } from '../geo/geometry.ts'
import { offsetMeters } from '../geo/wgs84.ts'
import type { Pharmacy } from '../lbs/types.ts'

/**
 * 演练场景装配。
 *
 * 重要：任务、Agent 起点、接驳关系全部从“用户刚确认的社区模型”派生（围栏、楼栋、入口、大门、接驳点），
 * 不读取任何硬编码的楼栋或路网。药店来自高德周边搜索（或示例），
 * 库存与可用性属于演练配置，全部标注为演练数据。
 */

export const DRILL_DATA_LABEL = '演练数据'
export const SAMPLE_SOURCE_LABEL = '示例数据（未接入真实数据）'

export function configFromSeed(seed: number, startLabel: string, startMs: number): DrillConfig {
  const r = rng(hashSeed(seed, 'config'))
  return {
    seed,
    depthThresholdM: 0.3,
    durationS: 2400,
    startLabel,
    startMs,
    depthPeakM: [0.16 + r.next() * 0.08, 0.4 + r.next() * 0.12],
    rain: 0.9,
    externalOriginRadiusM: 2600,
  }
}

export function slaForSlot(slot: 'morning' | 'afternoon'): number {
  return slot === 'morning' ? 70 * 60 : 135 * 60
}

/** 从用户楼栋派生任务：约一半楼栋有任务；主推任务指向离围栏中心最远的楼栋；
 *  标记了重点住户（独居老人/行动不便）的楼栋必定有任务，且优先级最高、时限最紧。 */
export function deriveTasks(model: CommunityModel, seed: number): Task[] {
  const { centroid } = localFrameFromFence(model.fence.polygon)
  const ranked = model.buildings.map((b) => ({ b, d: dist(b.local.c, centroid) })).sort((x, y) => y.d - x.d)
  const r = rng(hashSeed(seed, 'tasks'))
  const total = model.buildings.length
  const withTask = Math.min(total, Math.max(3, Math.ceil(total * 0.5)))
  const main = ranked[0]?.b
  const picked = new Set<string>()
  if (main) picked.add(main.id)
  const rest = model.buildings.filter((b) => !picked.has(b.id))
  while (picked.size < withTask && rest.length) {
    picked.add(rest.splice(r.int(rest.length), 1)[0].id)
  }
  for (const b of model.buildings) {
    if ((b.vulnerable ?? 0) > 0) picked.add(b.id)
  }
  const items = ['饮用水', '应急食品', '药品', '电池与照明']
  const base = model.buildings.filter((b) => picked.has(b.id))
  // 没有重点住户时保持原有顺序（演练脚本依赖它）；有重点住户时把它们提到最前，其余顺序不变
  const ordered = [...base.filter((b) => (b.vulnerable ?? 0) > 0), ...base.filter((b) => (b.vulnerable ?? 0) === 0)]
  return ordered.map((b, i) => {
    const vuln = (b.vulnerable ?? 0) > 0
    const high = vuln || b.id === main?.id
    const slot: Task['slot'] = vuln ? 'morning' : i % 2 === 0 ? 'morning' : 'afternoon'
    const item = high ? '饮用水 + 药品' : items[i % items.length]
    return {
      id: `task-${b.id}`,
      code: `T${String(i + 1).padStart(2, '0')}`,
      title: vuln ? `重点住户补给 → ${b.name}` : high ? `紧急补给 → ${b.name}` : `${item} → ${b.name}`,
      kind: 'supply',
      targetBuildingId: b.id,
      targetName: b.name,
      slot,
      slaAt: slaForSlot(slot),
      deadlineLabel: slot === 'morning' ? '09:10 前' : '10:15 前',
      need: { item, qty: high ? 4 : 2 },
      weightKg: high ? 38 : 22,
      priority: high ? 'high' : 'normal',
    }
  })
}

/** 外部 Agent 演练起点（演练数据），内部 Agent 从用户标记的接驳点出发 */
export function deriveAgents(model: CommunityModel, seed: number, config: DrillConfig): Agent[] {
  const externals: Agent[] = ['甲组', '乙组'].map((n, i) => ({
    id: `agt-ext-${i + 1}`,
    name: `外部志愿者 ${n}`,
    role: 'external',
    group: (i === 0 ? 'A' : 'B') as 'A' | 'B',
    origin: externalOrigin(model.center, seed, i, config.externalOriginRadiusM),
    capacityKg: 45,
    speedMps: 4.0,
    demo: true,
  }))
  const stagings = model.net.staging
  const internals: Agent[] = ['丙组', '丁组'].map((n, i) => {
    const stg = stagings[i % Math.max(1, stagings.length)]
    return {
      id: `agt-int-${i + 1}`,
      name: `内部志愿者 ${n}`,
      role: 'internal',
      group: (i === 0 ? 'C' : 'B') as 'C' | 'B',
      origin: stg ? stg.lngLat : model.center,
      capacityKg: 30,
      speedMps: 1.15,
      stagingNodeKey: stg ? `staging:${stg.id}` : undefined,
      demo: true,
    }
  })
  return [...externals, ...internals]
}

export function externalOrigin(center: LngLat, seed: number, index: number, radiusM: number): LngLat {
  const r = rng(hashSeed(seed, `origin:${index}`))
  const ang = index === 0 ? Math.PI * 0.2 + r.next() * 0.3 : Math.PI * 0.95 + r.next() * 0.3
  const rad = radiusM * (0.92 + r.next() * 0.25)
  return offsetMeters(center, Math.cos(ang) * rad, Math.sin(ang) * rad)
}

export function demoOriginFor(center: LngLat, index: number): LngLat {
  return externalOrigin(center, 1, index, 2600)
}

/** 演练库存：药店位置来自地图，库存数量由演练配置（种子）生成 */
export function demoInventory(pharmacies: Pharmacy[], seed: number): Record<string, InventoryPoint> {
  const out: Record<string, InventoryPoint> = {}
  pharmacies.forEach((p) => {
    const r = rng(hashSeed(seed, `inv:${p.id}`))
    const roll = r.next()
    out[p.id] = {
      id: p.id,
      name: p.name,
      label: `${p.name}（演练库存）`,
      source: p.source,
      stock: { 饮用水: 8 + r.int(22), 应急食品: 6 + r.int(14), 药品: 3 + r.int(9), 电池与照明: 5 + r.int(12) },
      lngLat: p.lngLat,
      address: p.address,
      availability: roll > 0.8 ? 'limited' : 'available',
    }
  })
  return out
}

export function stockOf(inv: Record<string, InventoryPoint>, pharmacyId: string, item: string): number {
  const key = item.split(' + ')[0]
  return inv[pharmacyId]?.stock[item] ?? inv[pharmacyId]?.stock[key] ?? 0
}

export function agentOriginLabel(agent: Agent): string {
  return agent.role === 'external' ? `${DRILL_DATA_LABEL}·模拟起点` : DRILL_DATA_LABEL
}

export function unitOf(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  return normalize(sub(b, a))
}
