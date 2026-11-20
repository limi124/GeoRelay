import type { LngLat } from '../geo/types.ts'
import type { ExternalLeg } from '../sim/types.ts'
import type { LbsClient } from '../lbs/types.ts'
import { hashSeed, rng } from '../util/rng.ts'
import { haversine, offsetMeters } from '../geo/wgs84.ts'
import { classifyRoad } from './roads.ts'

/**
 * 外部段提供者：外部段只负责“界外 → 药店 → 社区大门/围栏接驳点”。
 *  - AmapExternalProvider：调用 /api/amap 代理的高德驾车路线；
 *  - SampleExternalProvider：没有凭据时的示例路线（沿示例道路网格折行，明确标注）。
 * 两者接口一致，规划器不关心具体实现。内部路网一律不走这里。
 */
export interface ExternalLegRequest {
  origin: LngLat
  pharmacyId: string
  pharmacyLngLat: LngLat
  gateId: string
  gateLngLat: LngLat
  /** 外部 Agent 标识（用于稳定的示例路线） */
  agentSeed: string
  /** 该接入点是否是围栏临时接驳点（而非用户标记的大门） */
  gateIsPerimeter: boolean
}

export interface ExternalLegProvider {
  readonly kind: 'amap' | 'sample'
  leg(req: ExternalLegRequest): Promise<ExternalLeg>
  cacheKey(req: ExternalLegRequest): string
}

export class SampleExternalProvider implements ExternalLegProvider {
  readonly kind = 'sample' as const
  private readonly nameOf: (id: string) => string

  constructor(nameOf: (id: string) => string = (id) => id) {
    this.nameOf = nameOf
  }

  cacheKey(req: ExternalLegRequest): string {
    return `sample|${req.agentSeed}|${req.pharmacyId}|${req.gateId}`
  }

  async leg(req: ExternalLegRequest): Promise<ExternalLeg> {
    const via = classifyRoad(req.gateId, req.pharmacyLngLat).via
    const path = gridPath([req.origin, via, req.pharmacyLngLat, req.gateLngLat], hashSeed(17, req.agentSeed))
    let dist = 0
    for (let i = 1; i < path.length; i++) dist += haversine(path[i - 1], path[i])
    return {
      pharmacy: { id: req.pharmacyId, name: this.nameOf(req.pharmacyId), lngLat: req.pharmacyLngLat, source: 'sample' },
      atGate: req.gateId,
      path,
      durationS: dist / 7.2,
      distanceM: dist,
      routeSource: 'sample',
      routeNote: '示例路线：按示例道路网格模拟（非高德导航结果，未接入真实数据）',
    }
  }
}

export class AmapExternalProvider implements ExternalLegProvider {
  readonly kind = 'amap' as const
  private readonly lbs: LbsClient
  private readonly nameOf: (id: string) => string

  constructor(lbs: LbsClient, nameOf: (id: string) => string = (id) => id) {
    this.lbs = lbs
    this.nameOf = nameOf
  }

  cacheKey(req: ExternalLegRequest): string {
    return `amap|${req.agentSeed}|${req.pharmacyId}|${req.gateId}`
  }

  async leg(req: ExternalLegRequest): Promise<ExternalLeg> {
    const via = classifyRoad(req.gateId, req.pharmacyLngLat).via
    const res = await this.lbs.driveRoute([
      { lngLat: req.origin },
      { lngLat: via },
      { lngLat: req.pharmacyLngLat },
      { lngLat: req.gateLngLat },
    ])
    const base = {
      pharmacy: { id: req.pharmacyId, name: this.nameOf(req.pharmacyId), lngLat: req.pharmacyLngLat, source: 'amap' as const },
      atGate: req.gateId,
    }
    if (!res.ok) {
      // 失败时明确说明原因；不使用直线代替导航路线（规划器会据此判定候选不可行 / 需复核）
      return {
        ...base,
        path: [],
        durationS: 0,
        distanceM: 0,
        routeSource: 'amap',
        routeNote: `高德路线接口失败：${res.error ?? '未知原因'}。本候选不使用直线代替导航路线。`,
      }
    }
    return { ...base, path: res.path, durationS: res.durationS, distanceM: res.distanceM, routeSource: 'amap', routeNote: '高德驾车路线' }
  }
}

export function externalLegOk(leg: ExternalLeg | null | undefined): boolean {
  return Boolean(leg && leg.path.length > 1 && leg.durationS > 0)
}

function gridPath(points: LngLat[], seed: number): LngLat[] {
  const out: LngLat[] = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const r = rng(hashSeed(seed, `grid:${i}:${a[0].toFixed(5)}:${b[0].toFixed(5)}`))
    const k1 = 0.25 + r.next() * 0.2
    const k2 = 0.6 + r.next() * 0.2
    out.push([a[0] + (b[0] - a[0]) * k1, a[1]])
    out.push([a[0] + (b[0] - a[0]) * k2, a[1] + (b[1] - a[1]) * (k2 - k1)])
    out.push([b[0] + (b[1] - a[1]) * 0.08, b[1] - (b[1] - a[1]) * 0.1])
    out.push(b)
  }
  return out
}

/** 外部 Agent 演练起点（演练数据） */
export function demoAgentOrigin(center: LngLat, index: number, radiusM = 2600): LngLat {
  const ang = Math.PI * 0.15 + index * Math.PI * 0.55
  return offsetMeters(center, Math.cos(ang) * radiusM, Math.sin(ang) * radiusM)
}
