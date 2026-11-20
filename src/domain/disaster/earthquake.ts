import type { CommunityModel } from '../community/model.ts'
import type { DrillConfig, SimTime } from '../sim/types.ts'
import type { LngLat } from '../geo/types.ts'
import { fromLocal, localFrameFromFence } from '../community/frame.ts'
import { hashSeed, rng } from '../util/rng.ts'
import type { DisasterPlan, HazardSpec, ImpactEvent } from './types.ts'

/**
 * 地震演练场景（固定、可复跑）。
 *
 * 设定：固定震级、固定震中（社区中心），楼栋受损等级与路段断裂点由演练种子确定；
 * 断裂按固定演练延迟依次发生，因此同一场景同一子种子必然得到同一事件序列。
 *
 * 判定依据全部来自可核对的量：震中距、震级衰减、楼栋自振/层数、路段沿线断裂点数量。
 */

export type DamageLevel = '轻微' | '中等' | '严重' | '倒塌'

export interface EarthquakeOptions {
  /** 必须中断的路段（由引擎按固定规则挑选，保证演练主线可解释） */
  rupturedRoadIds: string[]
  /** 原接驳点（会变得不可用） */
  blockedStagingId: string | null
  /** 震级（固定场景 5.8） */
  magnitude?: number
  /** 断裂发生的固定延迟（秒） */
  delays?: number[]
}

export interface BuildingDamage {
  buildingId: string
  name: string
  level: DamageLevel
  ratio: number
  epicenterDistanceM: number
}

const LEVEL_OF = (ratio: number): DamageLevel => (ratio >= 0.75 ? '倒塌' : ratio >= 0.5 ? '严重' : ratio >= 0.28 ? '中等' : '轻微')

export function planEarthquake(model: CommunityModel, config: DrillConfig, opts: EarthquakeOptions): DisasterPlan {
  const magnitude = opts.magnitude ?? 5.8
  const delays = opts.delays ?? [90, 140, 190]
  const { frame } = localFrameFromFence(model.fence.polygon)
  const epicenter: LngLat = model.center
  const events: ImpactEvent[] = []
  const damages: BuildingDamage[] = []

  for (const b of model.buildings) {
    const r = rng(hashSeed(config.seed, `quake:dmg:${b.id}`))
    const distM = Math.hypot(b.center[0] - epicenter[0], b.center[1] - epicenter[1]) * 111000
    // 震级衰减 + 楼层放大 + 种子扰动：全部是固定公式，可复算
    const attenuation = Math.max(0.08, 1 - distM / 900)
    const floorsFactor = Math.min(1.25, 0.7 + b.floors / 24)
    const ratio = Math.round(Math.min(0.98, Math.max(0.06, attenuation * floorsFactor * (0.55 + r.next() * 0.75))) * 100) / 100
    const level = LEVEL_OF(ratio)
    damages.push({ buildingId: b.id, name: b.name, level, ratio, epicenterDistanceM: distM })
    events.push({
      id: `earthquake:building:${b.id}`,
      disaster: 'earthquake',
      at: 40,
      targetType: 'building',
      targetId: b.id,
      targetName: b.name,
      traffic: level === '倒塌' || level === '严重' ? 'restricted' : 'open',
      level,
      basis: [
        `震级 ${magnitude}，震中距 ${distM.toFixed(0)} 米`,
        `衰减系数 ${attenuation.toFixed(2)} × 楼层放大 ${floorsFactor.toFixed(2)}（${b.floors} 层）`,
        `受损指数 ${ratio.toFixed(2)} → 判定「${level}」`,
      ],
      reason: `${b.name} 受损等级「${level}」（受损指数 ${ratio.toFixed(2)}）`,
      metrics: { damageRatio: ratio, magnitude },
      geometry: { kind: 'point', at: b.center },
    })
  }

  opts.rupturedRoadIds.forEach((roadId, i) => {
    const road = model.net.roads.find((r) => r.id === roadId)
    if (!road) return
    const at = delays[Math.min(i, delays.length - 1)] ?? 190
    const r = rng(hashSeed(config.seed, `quake:road:${roadId}`))
    const snapped = 1 + Math.floor(r.next() * 3)
    events.push({
      id: `earthquake:road:${roadId}`,
      disaster: 'earthquake',
      at,
      targetType: 'road',
      targetId: roadId,
      targetName: road.name,
      traffic: 'blocked',
      level: '断裂',
      basis: [
        `震级 ${magnitude} 下该路段沿线出现 ${snapped} 处断裂点`,
        `断裂时刻 = 演练开始 + ${at}s（固定延迟）`,
        '判定依据：路面错台/塌陷，车辆不可通行',
      ],
      reason: `地震导致「${road.name}」断裂（${snapped} 处断点），路段中断`,
      metrics: { magnitude, damageRatio: Math.min(0.99, 0.45 + snapped * 0.1) },
      geometry: { kind: 'road', roadId },
    })
  })

  if (opts.blockedStagingId) {
    const st = model.net.staging.find((s) => s.id === opts.blockedStagingId)
    if (st) {
      const distM = Math.hypot(st.lngLat[0] - epicenter[0], st.lngLat[1] - epicenter[1]) * 111000
      events.push({
        id: `earthquake:staging:${st.id}`,
        disaster: 'earthquake',
        at: 120,
        targetType: 'staging',
        targetId: st.id,
        targetName: st.name,
        traffic: 'blocked',
        level: '不可用',
        basis: [
          `接驳点距震中 ${distM.toFixed(0)} 米`,
          '堆放物资倾覆、地面开裂，判定不具备交接条件',
          `不可用时刻 = 演练开始 + 120s（固定延迟）`,
        ],
        reason: `原接驳点「${st.name}」在地震中不可用，需换用仍可用的接驳点`,
        metrics: { magnitude, damageRatio: 0.6 },
        geometry: { kind: 'point', at: st.lngLat },
      })
    }
  }

  const hazardsAt = (t: SimTime): HazardSpec[] => {
    const out: HazardSpec[] = []
    for (const d of damages) {
      const b = model.buildings.find((x) => x.id === d.buildingId)
      if (!b) continue
      if (d.level === '轻微' && t < 40) continue
      out.push({
        id: `damage:${d.buildingId}`,
        kind: 'damage',
        path: b.footprint.map((p) => fromLocal(frame, p)),
        level: d.level,
        label: `${b.name} · ${d.level}（${Math.round(d.ratio * 100)}%）`,
      })
    }
    for (const ev of events) {
      if (ev.targetType !== 'road' || ev.at > t) continue
      const road = model.net.roads.find((r) => r.id === ev.targetId)
      if (!road) continue
      out.push({
        id: `rupture:${road.id}`,
        kind: 'rupture',
        path: road.points.map((p) => (Array.isArray(p) ? (p as LngLat) : ([p.lng, p.lat] as LngLat))),
        label: `${road.name} 断裂`,
      })
    }
    return out
  }

  return {
    kind: 'earthquake',
    events: events.sort((a, b) => a.at - b.at),
    scenario: {
      id: 'earthquake',
      title: '地震演练（多点路段中断 + 原接驳点不可用）',
      summary:
        '社区中心发生 5.8 级地震：楼栋按震中距与楼层出现不同受损等级，多处路段按固定延迟断裂，原接驳点失去交接条件。规划器应改用仍可用的接驳点或围栏临时接驳点完成接力。',
      fixedInputs: [
        `震级：${magnitude}，震中：社区中心`,
        `断路点：${opts.rupturedRoadIds.length} 处（固定种子挑选）`,
        `断裂延迟：${delays.join('s / ')}s`,
        `原接驳点不可用时刻：+120s`,
        `受损等级判定：衰减系数 × 楼层放大 × 固定种子扰动`,
      ],
    },
    hazardsAt,
  }
}

