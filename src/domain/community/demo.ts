import {
  addGate,
  addStaging,
  confirmRoads,
  createEmptyModel,
  generateBuildings,
  makeFence,
  makeRectFence,
  suggestNetwork,
  touch,
} from './operations.ts'
import type { CommunityModel } from './model.ts'
import { offsetMeters } from '../geo/wgs84.ts'
import type { LngLat } from '../geo/types.ts'
import { resetIdCounter, setIdNamespace } from '../util/id.ts'

/**
 * 预置演练场景用的固定社区。
 *
 * 与编辑台「载入演示社区」同构（凹形围栏 + 12 栋楼 + 两个大门 + 两个接驳点），
 * 区别是这里固定了 ID 命名空间，所以三个一键演练在同一台机器上可复跑，
 * 生成的 roadId / buildingId 每次都一致，便于对照与验收断言。
 */
export const PRESET_CENTER: LngLat = [121.4737, 31.2304]

export function buildPresetCommunity(): CommunityModel {
  setIdNamespace('preset')
  resetIdCounter()
  const center = PRESET_CENTER
  const ring = makeRectFence(center, 150, 8)
  const concave = ring.map((p, i) => (i === 2 ? offsetMeters(center, -30, 40) : p))
  let next: CommunityModel = touch({ ...createEmptyModel(center, '预置演练社区'), fence: makeFence(concave), center })
  next = addGate(next, offsetMeters(center, -140, -20), '西门')
  next = addGate(next, offsetMeters(center, 70, 130), '北门')
  next = addStaging(next, offsetMeters(center, -20, 10), '中央接驳点')
  next = addStaging(next, offsetMeters(center, 40, 70), '北侧接驳点')
  const gen = generateBuildings(next, { count: 12, floors: 8, floorHeightM: 2.9, widthM: 22, depthM: 15, keepExisting: false, seed: 42 })
  if (!gen.ok) throw new Error(`预置社区生成失败：${gen.message}`)
  next = suggestNetwork(gen.model)
  next = confirmRoads(next)
  // 复位命名空间：预置社区构建完就结束，避免之后手绘的对象也带 preset 前缀
  setIdNamespace('')
  return next
}
