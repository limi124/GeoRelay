import type { LngLat } from '../geo/types.ts'

/**
 * 外部道路分类（只用于示例路线与说明文字，不构造社区路网）。
 * 这里刻意保持简单：大门名与药店相对位置决定“外部道路标识”。
 */
export function classifyRoad(gateId: string, pharmacy: LngLat): { label: string; via: LngLat } {
  const dir = pharmacy[0] > 0 ? '东' : '西'
  void gateId
  return { label: `城市主干道（${dir}向）`, via: pharmacy }
}
