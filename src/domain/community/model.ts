import type { LngLat, Vec2 } from '../geo/types.ts'

/**
 * 社区模型（编辑器产出的“场景基准”）。
 *
 * 所有坐标以 WGS-84 经纬度保存（高德地图显示时转 GCJ-02）；
 * 同时缓存一份局部米制坐标（frame 以围栏第一个顶点为原点），
 * 用于楼栋校验、内部路网寻路与灾情判定。
 *
 * 所有对象 ID 稳定：编辑操作只增删对象，不重排 ID。
 */

export type BuildingStyle = 'residential' | 'highrise' | 'public'

export interface Fence {
  /** WGS-84 顶点，顺序即多边形环（支持凹多边形） */
  polygon: LngLat[]
  /** 局部米制顶点（缓存，与 polygon 同步） */
  localVertices: Vec2[]
  areaM2: number
}

export interface Building {
  id: string
  name: string
  /** 局部中心 */
  local: { c: Vec2; u: Vec2; w: number; d: number }
  /** 底面四角（局部） */
  footprint: Vec2[]
  /** 中心（WGS-84） */
  center: LngLat
  floors: number
  floorHeightM: number
  widthM: number
  depthM: number
  rotationDeg: number
  volumeM3: number
  style: BuildingStyle
  /** 楼栋入口（贴墙中点，局部米制 + WGS-84） */
  entrance: { edgeIndex: number; doorPoint: Vec2; doorLngLat: LngLat }
  /** 重点住户数（独居老人 / 行动不便等，需要优先补给）；缺省视为 0 */
  vulnerable?: number
}

export interface Gate {
  id: string
  name: string
  lngLat: LngLat
  local: Vec2
  /** 演练水深（米），由灾情引擎写入 */
  depthM?: number
}

export interface Staging {
  id: string
  name: string
  lngLat: LngLat
  local: Vec2
  /** 演练水深（米），由灾情引擎写入 */
  depthM?: number
}

export type RoadPoint = LngLat | { lng: number; lat: number }

export interface Road {
  id: string
  /** 端点与折点序列（WGS-84）；首尾必须是门/入口/接驳点或手绘拐点 */
  points: RoadPoint[]
  name: string
  /** 'user' 手绘或调整；'suggested' 生成后未确认 */
  status: 'user' | 'suggested'
}

export interface Net {
  gates: Gate[]
  staging: Staging[]
  roads: Road[]
}

export interface FenceValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
  areaM2: number
  selfIntersection?: { indexA: number; indexB: number; point: Vec2 }
}

export interface CommunityModel {
  version: 2
  id: string
  name: string
  address: string
  center: LngLat
  fence: Fence
  buildings: Building[]
  net: Net
  /** 楼栋批量生成参数 */
  generation: { count: number; floors: number; floorHeightM: number; widthM: number; depthM: number }
  /** 每层户数（人口估算口径，简化假设）；缺省按 4 户/层 */
  unitsPerFloor?: number
  createdAt: string
  updatedAt: string
}

export interface BatchOptions {
  count: number
  floors: number
  floorHeightM: number
  widthM: number
  depthM: number
  /** 是否保留已有楼栋 */
  keepExisting: boolean
  /** 随机种子（保证可复现） */
  seed: number
}

export type BatchResult =
  | { ok: true; model: CommunityModel; placed: number; warning?: string }
  | { ok: false; reason: 'too_many' | 'tight' | 'invalid'; message: string; capacity: number; placed: number }
