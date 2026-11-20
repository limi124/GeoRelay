import type { LngLat } from '../geo/types.ts'
import type { CommunityModel } from '../community/model.ts'
import type { DrillConfig, SimTime } from '../sim/types.ts'
import { haversine } from '../geo/wgs84.ts'
import { hashSeed, rng } from '../util/rng.ts'
import type { DisasterPlan, HazardSpec, ImpactEvent } from './types.ts'

/**
 * 火灾演练场景（固定、可复跑）。
 *
 * 设定：一栋楼在演练开始后固定时刻起火。烟雾以「起火时刻 + 固定延迟」向前推进，
 * 前锋半径只由演练时钟决定（同一场景同一种子必然复现）。当烟雾到达楼栋入口时，
 * 入口不可通行；到达相邻路段时，路段不可通行。
 *
 * 判定全部可解释：每个事件都带距离、烟雾半径、烟雾等级与判定依据，
 * 不依赖任何随机可视化 —— 随机只用在固定的场景参数上（起火楼的挑选由调用方给定）。
 */

export interface FireOptions {
  /** 起火楼栋（由引擎按固定规则挑选，保证可复跑） */
  ignitionBuildingId: string
  /** 'no_alt'：备用入口同样被烟雾覆盖，用于验证“无可行配送路线” */
  variant?: 'with_alt' | 'no_alt'
  /** 场景固定延迟（秒），默认值即演练脚本 */
  delays?: { ignite: SimTime; door: SimTime; road: SimTime }
}

/** 烟雾前锋半径（米）：起燃前为 0，之后按固定速度扩张，上限 150 米 */
export const SMOKE_SPEED_MPS = 0.55
export const SMOKE_MAX_M = 150

export function smokeRadiusAt(t: SimTime, igniteAt: SimTime): number {
  if (t <= igniteAt) return 0
  return Math.min(SMOKE_MAX_M, 6 + (t - igniteAt) * SMOKE_SPEED_MPS)
}

/** 烟雾浓度：越靠近前锋越低，0..1 */
export function smokeDensityAt(distanceM: number, radiusM: number): number {
  if (radiusM <= 0) return 0
  if (distanceM >= radiusM) return 0
  return Math.round((1 - distanceM / radiusM) * 1000) / 1000
}

export function planFire(model: CommunityModel, config: DrillConfig, opts: FireOptions): DisasterPlan {
  const delays = opts.delays ?? { ignite: 60, door: 150, road: 210 }
  const variant = opts.variant ?? 'with_alt'
  const ignition = model.buildings.find((b) => b.id === opts.ignitionBuildingId) ?? model.buildings[0]
  const center: LngLat = ignition.center
  const r = rng(hashSeed(config.seed, `fire:${ignition.id}`))
  // 固定场景里唯一的小随机量：火点相对楼栋中心的偏移（0–6 米），用来让起火点不总在正中心
  const jitterM = 6
  const angle = r.next() * Math.PI * 2
  const origin: LngLat = [center[0] + (Math.cos(angle) * jitterM) / 111319.49, center[1] + (Math.sin(angle) * jitterM) / 110574]

  const doorDistM = haversine(origin, ignition.entrance.doorLngLat)
  const radiusAtDoor = smokeRadiusAt(delays.door, delays.ignite)
  const doorDensity = smokeDensityAt(doorDistM, radiusAtDoor)

  const events: ImpactEvent[] = []

  events.push({
    id: `fire:building:${ignition.id}`,
    disaster: 'fire',
    at: delays.ignite,
    targetType: 'building',
    targetId: ignition.id,
    targetName: ignition.name,
    traffic: 'restricted',
    level: '起火',
    basis: [
      `固定演练场景：起火点为 ${ignition.name}`,
      `起火时刻 = 演练开始 + ${delays.ignite}s`,
      `楼栋中心距起火点 ${doorDistM.toFixed(0)} 米`,
    ],
    reason: `火灾演练：${ignition.name} 起火，烟雾开始向外扩散`,
    metrics: { smokeRadiusM: 6, smokeDensity: 1 },
    geometry: { kind: 'point', at: origin },
  })

  events.push({
    id: `fire:entrance:entrance:${ignition.id}`,
    disaster: 'fire',
    at: delays.door,
    targetType: 'entrance',
    targetId: `entrance:${ignition.id}`,
    targetName: `${ignition.name} 正门`,
    traffic: 'blocked',
    level: doorDensity >= 0.35 ? '浓烟' : '烟雾',
    basis: [
      `入口距起火点 ${doorDistM.toFixed(0)} 米`,
      `${delays.door}s 时烟雾前锋 ${radiusAtDoor.toFixed(0)} 米（速度 ${SMOKE_SPEED_MPS} m/s）`,
      `该入口烟雾浓度 ${doorDensity.toFixed(2)} ≥ 阈值 0.20，判定不可通行`,
    ],
    reason: `${ignition.name} 正门被烟雾覆盖，入口不可通行`,
    metrics: { smokeRadiusM: radiusAtDoor, smokeDensity: doorDensity, distanceToIgnitionM: doorDistM },
    geometry: { kind: 'point', at: ignition.entrance.doorLngLat },
  })

  if (variant === 'no_alt') {
    const altDist = doorDistM + 8
    events.push({
      id: `fire:entrance:entranceAlt:${ignition.id}`,
      disaster: 'fire',
      at: delays.door,
      targetType: 'entrance',
      targetId: `entranceAlt:${ignition.id}`,
      targetName: `${ignition.name} 备用入口`,
      traffic: 'blocked',
      level: '浓烟',
      basis: [
        `备用入口距起火点 ${altDist.toFixed(0)} 米（同侧相邻面）`,
        `烟雾前锋 ${radiusAtDoor.toFixed(0)} 米已覆盖该侧全部外立面`,
        '判定依据：备用入口与正门处于同一受烟侧，未能避开烟雾',
      ],
      reason: `${ignition.name} 备用入口同样被烟雾覆盖，该楼栋已无可用入口`,
      metrics: { smokeRadiusM: radiusAtDoor, smokeDensity: 0.9, distanceToIgnitionM: altDist },
      geometry: { kind: 'point', at: ignition.entrance.doorLngLat },
    })
  }

  // 相邻路段：取离起火点最近的一条路段，在烟雾前锋到达时封闭
  const nearestRoad = nearestRoadTo(model, origin)
  if (nearestRoad) {
    events.push({
      id: `fire:road:${nearestRoad.id}`,
      disaster: 'fire',
      at: delays.road,
      targetType: 'road',
      targetId: nearestRoad.id,
      targetName: nearestRoad.name,
      traffic: 'blocked',
      level: '烟雾封锁',
      basis: [
        `路段中点距起火点 ${nearestRoad.distanceM.toFixed(0)} 米`,
        `${delays.road}s 时烟雾前锋 ${smokeRadiusAt(delays.road, delays.ignite).toFixed(0)} 米已覆盖该路段`,
        '判定依据：能见度不足，路段禁止通行',
      ],
      reason: `烟雾覆盖「${nearestRoad.name}」，该路段封闭`,
      metrics: { smokeRadiusM: smokeRadiusAt(delays.road, delays.ignite), smokeDensity: 0.5, distanceToIgnitionM: nearestRoad.distanceM },
      geometry: { kind: 'road', roadId: nearestRoad.id },
    })
  }

  const hazardsAt = (t: SimTime): HazardSpec[] => {
    const radius = smokeRadiusAt(t, delays.ignite)
    const out: HazardSpec[] = []
    if (radius > 0) {
      out.push({ id: `smoke:${ignition.id}`, kind: 'smoke', center: origin, radiusM: radius, density: smokeDensityAt(radius * 0.35, radius), label: `烟雾范围 ≈ ${radius.toFixed(0)} 米` })
    }
    if (t >= delays.ignite) out.push({ id: `origin:${ignition.id}`, kind: 'fire-origin', center: origin, label: `起火点：${ignition.name}` })
    return out
  }

  return {
    kind: 'fire',
    events: events.sort((a, b) => a.at - b.at),
    scenario: {
      id: variant === 'no_alt' ? 'fire-no-alt' : 'fire',
      title: variant === 'no_alt' ? '火灾演练（备用入口也被烟雾覆盖）' : '火灾演练（目标楼栋入口被烟雾影响）',
      summary:
        variant === 'no_alt'
          ? '一栋楼起火，正门与备用入口先后被烟雾覆盖；用于验证“没有可行配送路线”时界面与规划器的表现。'
          : '一栋楼起火，烟雾推进导致该楼正门不可通行；规划器应改用备用入口生成改道候选。',
      fixedInputs: [
        `起火楼栋：${ignition.name}`,
        `起火时刻：+${delays.ignite}s`,
        `入口受阻时刻：+${delays.door}s（烟雾前锋 ${radiusAtDoor.toFixed(0)} 米）`,
        `路段封闭时刻：+${delays.road}s`,
        `烟雾扩张速度：${SMOKE_SPEED_MPS} m/s，上限 ${SMOKE_MAX_M} 米`,
      ],
    },
    hazardsAt,
  }
}

function nearestRoadTo(model: CommunityModel, p: LngLat): { id: string; name: string; distanceM: number } | null {
  let best: { id: string; name: string; distanceM: number } | null = null
  for (const road of model.net.roads) {
    if (road.points.length < 2) continue
    const a = road.points[0]
    const b = road.points[road.points.length - 1]
    const la = Array.isArray(a) ? a : [a.lng, a.lat]
    const lb = Array.isArray(b) ? b : [b.lng, b.lat]
    const mid: LngLat = [(la[0] + lb[0]) / 2, (la[1] + lb[1]) / 2]
    const d = haversine(p, mid)
    if (!best || d < best.distanceM) best = { id: road.id, name: road.name, distanceM: d }
  }
  return best
}
