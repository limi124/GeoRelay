import type { CommunityModel } from '../community/model.ts'
import type { DrillConfig, DisasterKind, SimTime } from '../sim/types.ts'
import type { DisasterPlan, ImpactEvent } from './types.ts'
import { planFlood } from './flood.ts'
import { planFire } from './fire.ts'
import { planEarthquake } from './earthquake.ts'
import type { Vec2 } from '../geo/types.ts'

/**
 * 灾种统一入口。
 *
 * 三种灾情都产出同一套 `DisasterPlan`：结构化影响事件 + 场景说明 + 地图几何。
 * 规划器、可达性、指挥台与 AI 分析只消费这一套结构，
 * 所以切换灾种不需要另写调度器。
 */

export interface PlanDisasterInput {
  kind: DisasterKind
  model: CommunityModel
  config: DrillConfig
  /** 内涝：强制受淹路段（引擎按派单挑选） */
  floodTargetRoadId?: string | null
  /** 火灾：起火楼栋 */
  fireIgnitionBuildingId?: string
  fireVariant?: 'with_alt' | 'no_alt'
  /** 地震：必须中断的路段与要作废的原接驳点 */
  quakeRupturedRoadIds?: string[]
  quakeBlockedStagingId?: string | null
  /** 路段的局部坐标折线（内涝按切片算水深） */
  roadPoints: Array<{ id: string; points: Vec2[] }>
}

export type FloodPlanLike = ReturnType<typeof planFlood>

export interface DisasterBundle {
  plan: DisasterPlan
  /** 内涝保留原来的水深模型（界面显示水深、涨水历史） */
  flood: FloodPlanLike | null
}

export function planDisaster(input: PlanDisasterInput): DisasterBundle {
  if (input.kind === 'flood') {
    const flood = planFlood(input.model, input.config, input.roadPoints, {
      forceFlood: input.floodTargetRoadId ? [input.floodTargetRoadId] : [],
    })
    const events: ImpactEvent[] = flood.closures.map((c) => {
      const road = input.model.net.roads.find((r) => r.id === c.roadId)
      const at = c.at
      return {
        id: `flood:road:${c.roadId}`,
        disaster: 'flood',
        at,
        targetType: 'road',
        targetId: c.roadId,
        targetName: road?.name ?? c.roadId,
        traffic: 'blocked',
        level: '积水封闭',
        basis: [
          `演练水深 ${c.depthM.toFixed(2)} 米 ≥ 封路阈值 ${c.thresholdM.toFixed(2)} 米`,
          `涨水过程按演练时钟推进（固定种子）`,
          `触发时刻 = 演练开始 + ${Math.round(at)}s`,
        ],
        reason: `内涝积水达到封路阈值（${c.thresholdM} 米）`,
        metrics: { depthM: c.depthM, thresholdM: c.thresholdM },
        geometry: { kind: 'road', roadId: c.roadId },
      }
    })
    return {
      plan: {
        kind: 'flood',
        events,
        scenario: {
          id: 'flood',
          title: '内涝演练（涨水 → 阈值封路 → 改派）',
          summary: '降雨使主动脉积水，水深达到阈值后封路，派生改派候选。',
          fixedInputs: [
            `封路阈值：${input.config.depthThresholdM} 米`,
            `强制受淹路段：${input.floodTargetRoadId ?? '无'}`,
            input.config.untilAllEvacuated ? '结束条件：全员到达围栏外集结点' : `演练时长：${Math.round(input.config.durationS / 60)} 分钟`,
          ],
        },
        hazardsAt: () => [],
      },
      flood,
    }
  }

  if (input.kind === 'fire') {
    const plan = planFire(input.model, input.config, {
      ignitionBuildingId: input.fireIgnitionBuildingId ?? input.model.buildings[0].id,
      variant: input.fireVariant ?? 'with_alt',
    })
    return { plan, flood: null }
  }

  const plan = planEarthquake(input.model, input.config, {
    rupturedRoadIds: input.quakeRupturedRoadIds ?? [],
    blockedStagingId: input.quakeBlockedStagingId ?? null,
  })
  return { plan, flood: null }
}

/** 某个时刻已生效的影响事件，按目标分组，便于界面与可达性判定 */
export function activeImpacts(plan: DisasterPlan, t: SimTime): ImpactEvent[] {
  return plan.events.filter((e) => e.at <= t && e.traffic !== 'open')
}

export * from './types.ts'
export { planFlood, roadDepthAt, historyFor, floodedSegments } from './flood.ts'
export { planFire, smokeRadiusAt, smokeDensityAt } from './fire.ts'
export { planEarthquake } from './earthquake.ts'
