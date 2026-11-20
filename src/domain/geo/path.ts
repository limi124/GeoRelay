import type { LngLat } from '../geo/types.ts'
import { haversine } from '../geo/wgs84.ts'
import { localFrame, toLocal } from '../geo/wgs84.ts'
import { pointAtDistance } from '../geo/geometry.ts'

/**
 * 折线行走工具：按比例取点、按路程取点、折线总长。
 * 平面换算统一用 WGS-84 切平面（米），避免混合坐标系。
 */
export function pathLengthM(path: LngLat[]): number {
  let s = 0
  for (let i = 1; i < path.length; i++) s += haversine(path[i - 1], path[i])
  return s
}

export function pointAtFraction(path: LngLat[], fraction: number): LngLat {
  if (!path.length) return [0, 0]
  if (path.length === 1) return path[0]
  const frame = localFrame(path[0])
  const local = path.map((p) => toLocal(frame, p))
  const total = pathLengthM(path)
  const pt = pointAtDistance(local, total * Math.max(0, Math.min(1, fraction)))
  return [frame.origin[0] + pt.x / frame.mxPerDegLng, frame.origin[1] + pt.y / frame.myPerDegLat]
}

export function pointAtMeters(path: LngLat[], meters: number): LngLat {
  if (!path.length) return [0, 0]
  const total = pathLengthM(path)
  return pointAtFraction(path, total > 0 ? meters / total : 0)
}

/** 折线方向（度，用于标记旋转） */
export function headingOf(path: LngLat[], fraction: number): number {
  if (path.length < 2) return 0
  const a = pointAtFraction(path, Math.max(0, fraction - 0.01))
  const b = pointAtFraction(path, Math.min(1, fraction + 0.01))
  const frame = localFrame(a)
  const pa = toLocal(frame, a)
  const pb = toLocal(frame, b)
  return (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI
}
