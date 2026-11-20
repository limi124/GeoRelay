/**
 * 最小共享类型定义：几何基础类型。
 * 坐标统一使用 WGS-84 经纬度 [lng, lat]，距离单位为米。
 */
export type LngLat = [number, number]

export interface Vec2 {
  x: number
  y: number
}

/** 局部平面米制坐标（以某个锚点为原点的切平面近似） */
export interface LocalFrame {
  origin: LngLat
  /** 每度经度对应的米数（已乘 cos(lat)） */
  mxPerDegLng: number
  /** 每度纬度对应的米数 */
  myPerDegLat: number
}

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type TurnSide = 'left' | 'right' | 'straight'

/** 沿折线的定位：第 seg 段内 t∈[0,1) 处 */
export interface PathPose {
  seg: number
  t: number
}
