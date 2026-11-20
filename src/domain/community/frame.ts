import type { LngLat, LocalFrame, Vec2 } from '../geo/types.ts'
import { localFrame, toLocal, toLngLat } from '../geo/wgs84.ts'
import { polygonArea, polygonInteriorPoint } from '../geo/geometry.ts'

/** 社区共享的平面米制坐标系：原点 = 围栏第一个顶点 */
export type Frame = LocalFrame

export interface FrameInfo {
  frame: LocalFrame
  localPoly: Vec2[]
  centroid: Vec2
  areaM2: number
}

/** 建立局部平面坐标系（经纬度 → 米制），返回围栏顶点、内部焦点与面积 */
export function localFrameFromFence(polygon: LngLat[]): FrameInfo {
  const origin: LngLat = polygon[0] ?? [0, 0]
  const frame = localFrame(origin)
  const localPoly = polygon.map((p) => toLocal(frame, p))
  return { frame, localPoly, centroid: polygonInteriorPoint(localPoly), areaM2: polygonArea(localPoly) }
}

export function toLocalIn(frame: LocalFrame, p: LngLat): Vec2 {
  return toLocal(frame, p)
}

export function fromLocal(frame: LocalFrame, v: Vec2): LngLat {
  return toLngLat(frame, v)
}
