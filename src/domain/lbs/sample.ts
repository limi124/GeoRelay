import type { LngLat, Vec2 } from '../geo/types.ts'
import { haversine, offsetMeters } from '../geo/wgs84.ts'
import { normalize, sub } from '../geo/geometry.ts'
import type { ExternalRoute, LbsClient, LbsStatus, Pharmacy, RoutePoint } from './types.ts'
import { hashSeed, rng } from '../util/rng.ts'

/**
 * 示例位置服务：没有高德凭据时使用。
 *
 * 附近药店由固定种子在社区周边生成；外部路线为带折点的“城市网格拟真路线”
 * （不是直线、也不是高德导航结果），并明确标注为示例数据。
 */
export class SampleLbsClient implements LbsClient {
  private reason: string
  private readonly center: LngLat
  private readonly seed: number

  constructor(center: LngLat, seed: number, reason = '未配置高德 Key') {
    this.center = center
    this.seed = seed
    this.reason = reason
  }

  status(): LbsStatus {
    return { mode: 'sample', reason: this.reason, configuredKey: false }
  }

  async aroundSearch(center: LngLat, radiusM: number, keywords: string): Promise<Pharmacy[]> {
    const r = rng(hashSeed(this.seed, `pharmacy:${keywords}`))
    const suffixes = ['康宁大药房', '便民药房', '平价药店', '社区健康药房', '济仁药店', '惠民大药房']
    const roads = ['人民路', '建设街', '滨河路', '花园巷', '朝阳路', '文华街']
    const count = 5
    const out: Pharmacy[] = []
    for (let i = 0; i < count; i++) {
      const ang = r.next() * Math.PI * 2
      const dist = radiusM * (0.32 + r.next() * 0.55)
      const p = offsetMeters(center, Math.cos(ang) * dist, Math.sin(ang) * dist)
      out.push({
        id: `sample-ph-${i + 1}`,
        name: `${roads[i % roads.length]}${suffixes[i % suffixes.length]}`,
        address: `示例地址 · ${roads[i % roads.length]}${100 + r.int(200)} 号`,
        lngLat: p,
        distanceM: Math.round(haversine(center, p)),
        source: 'sample',
      })
    }
    return out.sort((a, b) => a.distanceM - b.distanceM)
  }

  async driveRoute(points: RoutePoint[]): Promise<ExternalRoute> {
    if (points.length < 2) {
      return { ok: false, path: [], distanceM: 0, durationS: 0, source: 'sample', error: '路线至少需要起点和终点' }
    }
    // 拟真：沿“城市网格”折线行驶（先东西后南北，带两个转弯点），避免把直线伪装成导航
    const path: LngLat[] = [points[0].lngLat]
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1].lngLat
      const b = points[i].lngLat
      const r = rng(hashSeed(this.seed, `route:${i}:${a[0].toFixed(4)}:${b[0].toFixed(4)}`))
      const k1 = 0.28 + r.next() * 0.18
      const k2 = 0.62 + r.next() * 0.18
      const p1: LngLat = [a[0] + (b[0] - a[0]) * k1, a[1] + (b[1] - a[1]) * 0.04]
      const p2: LngLat = [p1[0] + (b[0] - a[0]) * (k2 - k1), a[1] + (b[1] - a[1]) * (k2 - k1)]
      const p3: LngLat = [b[0] + (r.next() - 0.5) * 0.0004, b[1] - (b[1] - a[1]) * 0.12]
      path.push(p1, p2, p3, b)
    }
    let total = 0
    for (let i = 1; i < path.length; i++) total += haversine(path[i - 1], path[i])
    // 直线距离 × 1.25 的绕行系数（道路网格折线本身已体现绕行）
    const straight = haversine(points[0].lngLat, points[points.length - 1].lngLat)
    const distanceM = Math.round(Math.max(total, straight * 1.18))
    const durationS = Math.round(distanceM / 7.2) // 市区 26 km/h
    return {
      ok: true,
      path,
      distanceM,
      durationS,
      source: 'sample',
      error: undefined,
      note: '示例路线（按城市网格模拟绕行，非高德导航结果）',
      steps: path.slice(1).map((p, i) => ({
        instruction: `沿示例道路行驶至第 ${i + 1} 个路口`,
        distanceM: Math.round(haversine(path[i], p)),
      })),
    }
  }

  async geocode(query: string, city?: string): Promise<{ lngLat: LngLat; formatted?: string } | null> {
    const q = query.trim()
    if (!q) return null
    // 示例模式：以当前社区中心为基准，按查询文本生成稳定的偏移点，模拟“搜到的地址”
    const r = rng(hashSeed(this.seed, `geo:${q}`))
    const ang = r.next() * Math.PI * 2
    const d = 600 + r.next() * 4200
    const p = offsetMeters(this.center, Math.cos(ang) * d, Math.sin(ang) * d)
    return { lngLat: p, formatted: `${q}（示例定位 · ${city ?? '当前城市'}）` }
  }

  async inputTips(query: string, city?: string): Promise<Array<{ name: string; address?: string; lngLat: LngLat }>> {
    const q = query.trim()
    if (!q) return []
    const names = [`${q}小区`, `${q}花园`, `${q}社区服务中心`, `${q}南门`, `${q}幼儿园`]
    const out: Array<{ name: string; address?: string; lngLat: LngLat }> = []
    for (let i = 0; i < names.length; i++) {
      const r = rng(hashSeed(this.seed, `tip:${q}:${i}`))
      const p = offsetMeters(this.center, (r.next() - 0.5) * 5000, (r.next() - 0.5) * 5000)
      out.push({ name: names[i], address: `示例地址 · ${city ?? '当前城市'}`, lngLat: p })
    }
    return out
  }
}

/** 计算折线上某点的朝向（供地图标记旋转） */
export function headingOf(path: LngLat[], at: number): Vec2 {
  if (path.length < 2) return { x: 0, y: 1 }
  const idx = Math.max(0, Math.min(path.length - 2, Math.floor(at * (path.length - 1))))
  return normalize(sub({ x: path[idx + 1][0], y: path[idx + 1][1] }, { x: path[idx][0], y: path[idx][1] }))
}
