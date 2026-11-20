import type { LngLat } from '../geo/types.ts'

/** 周边搜索的候选药店/物资点 */
export interface Pharmacy {
  id: string
  name: string
  address?: string
  lngLat: LngLat
  distanceM: number
  tel?: string
  /** 数据来源：'amap' 来自高德周边搜索；'sample' 为示例数据（明确标注） */
  source: 'amap' | 'sample'
}

export interface RoutePoint {
  lngLat: LngLat
  name?: string
}

export interface ExternalRoute {
  ok: boolean
  /** 途经点顺序对应的折线 */
  path: LngLat[]
  distanceM: number
  durationS: number
  source: 'amap' | 'sample'
  /** 失败原因（接口错误、无结果等），绝不把直线伪装成导航路线 */
  error?: string
  steps?: Array<{ instruction: string; distanceM: number }>
  /** 规划说明（示例数据时提示） */
  note?: string
}

export interface LbsStatus {
  mode: 'amap' | 'sample'
  /** 未使用高德的原因 */
  reason?: string
  /** 服务端是否已配置高德 Key */
  configuredKey: boolean
}

/**
 * 地图位置服务接口。社区内部路网不使用本接口（内路一律用 Dijkstra）。
 * - Web 端：通过 /api/amap 代理调用高德 Web 服务；
 * - 批处理/测试：使用带固定种子的示例实现，保证可复现。
 */
export interface LbsClient {
  status(): LbsStatus
  /** 周边搜索（关键字默认“药店”） */
  aroundSearch(center: LngLat, radiusM: number, keywords: string): Promise<Pharmacy[]>
  /** 多途经点路线：起点 → 药店 → 社区大门 */
  driveRoute(points: RoutePoint[]): Promise<ExternalRoute>
  /** 地址 → 坐标（WGS-84） */
  geocode(query: string, city?: string): Promise<{ lngLat: LngLat; formatted?: string } | null>
  /** POI 输入提示（地址搜索） */
  inputTips(query: string, city?: string): Promise<Array<{ name: string; address?: string; lngLat: LngLat }>>
}
