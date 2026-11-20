import type { LngLat } from '../geo/types.ts'
import type { DisasterKind, SimTime } from '../sim/types.ts'

/**
 * 灾情事件（三种灾种共用一套结构）。
 *
 * 统一字段：灾种、事件 ID、演练时刻、受影响对象、通行变化、判定依据。
 * 规划器、可达性判定、界面与 AI 分析都只读这一套结构，
 * 因此火灾/地震不需要各自一套调度器 —— 只是影响事件的来源不同。
 */

export type ImpactTargetType = 'road' | 'entrance' | 'staging' | 'building'

/** 通行变化：blocked=不可通行/不可用；restricted=可通行但受限；open=恢复 */
export type TrafficChange = 'blocked' | 'restricted' | 'open'

export interface ImpactEvent {
  /** 稳定 ID：`${disaster}:${targetType}:${targetId}`（同一场景可复跑） */
  id: string
  disaster: DisasterKind
  /** 演练时刻（秒，自演练开始） */
  at: SimTime
  targetType: ImpactTargetType
  /** 路段 ID / 入口节点键 / 接驳点 ID / 楼栋 ID */
  targetId: string
  targetName: string
  traffic: TrafficChange
  /** 影响等级（火灾=烟雾等级，地震=受损等级，内涝=积水深度） */
  level: string
  /** 判定依据（给人看也可给 AI 读） */
  basis: string[]
  /** 一句话原因 */
  reason: string
  /** 可量化指标 */
  metrics?: {
    depthM?: number
    thresholdM?: number
    smokeRadiusM?: number
    smokeDensity?: number
    distanceToIgnitionM?: number
    damageRatio?: number
    magnitude?: number
  }
  geometry?: { kind: 'circle'; center: LngLat; radiusM: number } | { kind: 'point'; at: LngLat } | { kind: 'road'; roadId: string }
  /** 模型证据（仅专业模型算例的事件有）：可追溯到算例、采样点、数值与演练规则 */
  evidence?: {
    runId: string
    model: 'fds' | 'openquake'
    engineVersion: string
    caseId: string
    sampleId?: string
    assetId?: string
    metric: string
    value: number | null
    unit: string
    comparator: 'lt' | 'lte' | 'gt' | 'gte'
    threshold: number
    ruleId: string
    ruleLabel: string
    atS: number
    layers: { model: string; rule: string }
  }
}

/** 地图图层用的灾情几何（火灾烟雾、地震受损楼栋、断路） */
export type HazardSpec =
  | { id: string; kind: 'risk'; center: LngLat; radiusM: number; path?: LngLat[]; priority: boolean; focused: boolean; label: string; color?: string }
  | { id: string; kind: 'urgency'; path: LngLat[]; center: LngLat; color: string; label: string }
  | { id: string; kind: 'smoke'; center: LngLat; radiusM: number; density: number; label: string }
  | { id: string; kind: 'fire-origin'; center: LngLat; label: string }
  | { id: string; kind: 'damage'; path: LngLat[]; level: '轻微' | '中等' | '严重' | '倒塌'; label: string }
  | { id: string; kind: 'rupture'; path: LngLat[]; label: string }

export interface DisasterPlan {
  kind: DisasterKind
  /** 按时刻排序的影响事件 */
  events: ImpactEvent[]
  /** 固定场景说明（界面上直接展示，便于复跑对照） */
  scenario: { id: string; title: string; summary: string; fixedInputs: string[] }
  /** 每帧提供给地图的灾情几何 */
  hazardsAt(t: SimTime): HazardSpec[]
  /** 专业模型算例来源（简化演示时为空） */
  provenance?: {
    level: 'model' | 'imported' | 'simplified'
    label: string
    model: 'fds' | 'openquake'
    disaster: 'fire' | 'earthquake'
    runId: string
    caseId: string
    engineVersion: string
    solverCommand: string
    inputs: Array<{ path: string; note?: string }>
    outputs: Array<{ path: string; note?: string; unit?: string }>
    notes: string[]
    scope: string
    ranAt: string | null
  }
  /** 该算例换算出的模型事件（含证据），供证据面板与 AI 引用 */
  modelEvents?: ImpactEvent[]
}

export function impactRoadId(ev: ImpactEvent): string | null {
  return ev.targetType === 'road' && ev.traffic === 'blocked' ? ev.targetId : null
}

export function impactsActiveAt(plan: DisasterPlan, t: SimTime): ImpactEvent[] {
  return plan.events.filter((e) => e.at <= t)
}

export function impactsComingAt(plan: DisasterPlan, t: SimTime): ImpactEvent[] {
  return plan.events.filter((e) => e.at > t)
}
