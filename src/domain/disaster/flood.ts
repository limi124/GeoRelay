import type { Vec2 } from '../geo/types.ts'
import type { CommunityModel } from '../community/model.ts'
import type { DrillConfig, RoadClosureEvidence, SimTime } from '../sim/types.ts'
import { hashSeed, rng } from '../util/rng.ts'
import { localFrameFromFence } from '../community/frame.ts'
import { lerp, pointAtDistance, polylineLength } from '../geo/geometry.ts'

/**
 * 内涝灾情引擎。
 *
 * - 以“路段切片”为单元，给每条用户确认的路段一条涨水曲线（峰值由演练种子决定）；
 * - 演练时钟逐步推进，水深越过阈值时发出结构化封路事件（路段 ID、水深、阈值、触发时刻、涨水历史、原因、灾种）；
 * - 火灾 / 地震后续复用同一事件结构：只需替换灾种与判定函数，不改规划器与界面。
 */

export interface SegmentDepth {
  roadId: string
  index: number
  a: Vec2
  b: Vec2
  peakM: number
  riseAt: SimTime
  peakAt: SimTime
  /** 达到阈值（封路）的时刻 */
  closesAt: SimTime | null
}

export interface FloodPlan {
  segments: SegmentDepth[]
  thresholdM: number
  /** 全部封路事件（按时刻排序），浏览器与批量模拟共用 */
  closures: Array<RoadClosureEvidence & { segmentIndex: number }>
}

export interface FloodPlanOptions {
  /**
   * 指定必然受淹的路段（演练脚本用）。
   * 没有它时所有路段的峰值都低于阈值，演练里永远不会封路；
   * 有了它演练主线才可解释：降雨先淹特定主动脉，再触发改派。
   */
  forceFlood?: string[]
  /** 永远不淹的路段（例如通往临时接驳点的救命通道） */
  keepDry?: string[]
}

export function planFlood(
  model: CommunityModel,
  config: DrillConfig,
  roads: Array<{ id: string; points: Vec2[] }>,
  opts: FloodPlanOptions = {},
): FloodPlan {
  const threshold = config.depthThresholdM
  const force = new Set(opts.forceFlood ?? [])
  const dry = new Set(opts.keepDry ?? [])
  const { centroid } = localFrameFromFence(model.fence.polygon)
  const lowDir = { x: Math.cos(-Math.PI / 4), y: Math.sin(-Math.PI / 4) }
  const segs: SegmentDepth[] = []
  for (const road of roads) {
    const pts = road.points
    const total = polylineLength(pts)
    const pieces = Math.max(1, Math.round(total / 30))
    const forced = force.has(road.id)
    for (let i = 0; i < pieces; i++) {
      const a = pointAtDistance(pts, (i / pieces) * total)
      const b = pointAtDistance(pts, ((i + 1) / pieces) * total)
      const mid = lerp(a, b, 0.5)
      const r = rng(hashSeed(config.seed, `seg:${road.id}:${i}`))
      // 越靠低洼方向（围栏东南）越容易积水
      const exposure = ((mid.x - centroid.x) * lowDir.x + (mid.y - centroid.y) * lowDir.y) / 120
      const [lo, hi] = config.depthPeakM
      let peak = Math.max(0.05, (lo + r.next() * (hi - lo)) * (0.78 + 0.5 * Math.max(-0.6, Math.min(1.2, exposure))))
      if (forced) {
        // 强制受淹：峰值高于阈值，形成一个明确可解释的封路事件
        peak = threshold + 0.06 + r.next() * 0.1
      } else if (dry.has(road.id)) {
        peak = Math.min(peak, threshold * 0.4)
      } else {
        // 非强制路段保持低于阈值：演练主线只封“该封的那段”，其余道路保持可用以便改派
        peak = Math.min(peak, threshold * 0.82)
      }
      const riseAt = forced ? 40 + r.next() * 60 : 40 + r.next() * 120
      const riseDur = forced ? 150 + r.next() * 120 : 220 + r.next() * 260
      segs.push({
        roadId: road.id,
        index: i,
        a,
        b,
        peakM: Math.round(peak * 1000) / 1000,
        riseAt: Math.round(riseAt),
        peakAt: Math.round(riseAt + riseDur),
        closesAt: null,
      })
    }
  }
  const closures: FloodPlan['closures'] = []
  for (const s of segs) {
    if (s.peakM < threshold) continue
    s.closesAt = Math.round(crossingTime(s, threshold))
    closures.push({
      roadId: s.roadId,
      roadName: '',
      depthM: s.peakM,
      thresholdM: threshold,
      at: s.closesAt,
      history: [],
      reason: `内涝积水达到封路阈值（${threshold} 米）`,
      disaster: 'flood',
      segmentIndex: s.index,
    })
  }
  closures.sort((a, b) => a.at - b.at)
  return { segments: segs, thresholdM: threshold, closures }
}

function depthAt(s: SegmentDepth, t: SimTime): number {
  if (t <= s.riseAt) return 0
  if (t >= s.peakAt) return s.peakM
  const k = (t - s.riseAt) / (s.peakAt - s.riseAt)
  return s.peakM * Math.pow(k, 1.35)
}

export function segmentDepthAt(s: SegmentDepth, t: SimTime): number {
  return Math.round(depthAt(s, t) * 1000) / 1000
}

export function crossingTime(s: SegmentDepth, threshold: number): number {
  if (s.peakM < threshold) return Infinity
  let lo = s.riseAt
  let hi = s.peakAt
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (depthAt(s, mid) < threshold) lo = mid
    else hi = mid
  }
  return hi
}

/** 某路段全部切片在 t 时刻的最大水深 */
export function roadDepthAt(plan: FloodPlan, roadId: string, t: SimTime): number {
  let d = 0
  for (const s of plan.segments) if (s.roadId === roadId) d = Math.max(d, segmentDepthAt(s, t))
  return d
}

/** 路段第一次达到阈值的时刻（用于“触发时刻”展示） */
export function roadCrossingAt(plan: FloodPlan, roadId: string): SimTime | null {
  let best: SimTime | null = null
  for (const s of plan.segments) {
    if (s.roadId !== roadId || s.closesAt === null) continue
    if (best === null || s.closesAt < best) best = s.closesAt
  }
  return best
}

/** 受淹切片（地图水面积） */
export function floodedSegments(plan: FloodPlan, t: SimTime): Array<{ roadId: string; a: Vec2; b: Vec2; depthM: number; widthM: number }> {
  const out: Array<{ roadId: string; a: Vec2; b: Vec2; depthM: number; widthM: number }> = []
  for (const s of plan.segments) {
    const d = segmentDepthAt(s, t)
    if (d < 0.02) continue
    out.push({ roadId: s.roadId, a: s.a, b: s.b, depthM: d, widthM: 6 + d * 40 })
  }
  return out
}

export function historyFor(plan: FloodPlan, roadId: string, t: SimTime, samples = 6): Array<[SimTime, number]> {
  const out: Array<[SimTime, number]> = []
  for (let i = 0; i <= samples; i++) {
    const tt = Math.round((t * i) / samples)
    out.push([tt, roadDepthAt(plan, roadId, tt)])
  }
  return out
}

export function nextClosure(plan: FloodPlan, from: SimTime): FloodPlan['closures'][number] | null {
  return plan.closures.find((c) => c.at > from) ?? null
}

/** 某时刻所有已封闭路段 */
export function closedRoadsAt(plan: FloodPlan, t: SimTime): string[] {
  return plan.closures.filter((c) => c.at <= t).map((c) => c.roadId)
}
