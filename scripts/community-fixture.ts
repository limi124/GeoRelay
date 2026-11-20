/**
 * 演示社区夹具（批处理与自测共用）。
 *
 * 刻意做成凹形（L 形缺口）围栏 + 两个大门 + 两个接驳点 + 12 栋楼，
 * 与界面「载入演示社区」同构，保证无头验证覆盖的正是界面能走通的路径。
 */
import {
  addGate,
  addRoad,
  addStaging,
  confirmRoads,
  createEmptyModel,
  generateBuildings,
  makeFence,
  suggestNetwork,
  touch,
  validateFence,
  validateNetwork,
} from '../src/domain/community/operations.ts'
import type { CommunityModel } from '../src/domain/community/model.ts'
import { offsetMeters } from '../src/domain/geo/wgs84.ts'
import { resetIdCounter, setIdNamespace } from '../src/domain/util/id.ts'
import type { LngLat } from '../src/domain/geo/types.ts'
import type { Pharmacy } from '../src/domain/lbs/types.ts'

export const DEMO_CENTER: LngLat = [121.4737, 31.2304]

export function demoPolygon(center: LngLat = DEMO_CENTER): LngLat[] {
  // 逆时针绕一圈，第 3 个点向内凹进，形成 L 形缺口
  const shape: Array<[number, number]> = [
    [-150, -120],
    [40, -120],
    [40, -30],
    [150, -30],
    [150, 120],
    [-60, 120],
    [-60, 40],
    [-150, 40],
  ]
  return shape.map(([dx, dy]) => offsetMeters(center, dx, dy))
}

export interface DemoCommunity {
  model: CommunityModel
  pharmacies: Pharmacy[]
}

export function buildDemoCommunity(seed = 42): DemoCommunity {
  // 固定 ID 命名空间：同一 seed 在任何进程里都生成同一套对象 ID，便于复现与对照
  setIdNamespace(`s${seed}`)
  resetIdCounter()
  const center = DEMO_CENTER
  const polygon = demoPolygon(center)
  const fenceCheck = validateFence(polygon)
  if (!fenceCheck.ok) throw new Error(`演示围栏不可用：${fenceCheck.errors.join('；')}`)

  let model: CommunityModel = touch({ ...createEmptyModel(center, '演示社区'), fence: makeFence(polygon), center })
  const gen = generateBuildings(model, { count: 12, floors: 8, floorHeightM: 2.9, widthM: 22, depthM: 15, keepExisting: false, seed })
  if (!gen.ok) throw new Error(`演示楼栋生成失败：${gen.message}`)
  model = gen.model

  model = addGate(model, offsetMeters(center, -140, -20), '西门')
  model = addGate(model, offsetMeters(center, 60, 130), '北门')
  model = addStaging(model, offsetMeters(center, -20, 10), '中央接驳点')
  model = addStaging(model, offsetMeters(center, 30, 70), '北侧接驳点')

  model = suggestNetwork(model)
  model = connectOrphanEntrances(model)
  model = confirmRoads(model)

  const netCheck = validateNetwork(model)
  if (!netCheck.ok) throw new Error(`演示路网不可用：${netCheck.errors.join('；')}`)

  const pharmacies: Pharmacy[] = [
    { id: 'ph-1', name: '康宁大药房（演练）', lngLat: offsetMeters(center, 900, 700), distanceM: 1140, source: 'sample' },
    { id: 'ph-2', name: '便民药房（演练）', lngLat: offsetMeters(center, -1100, 520), distanceM: 1217, source: 'sample' },
    { id: 'ph-3', name: '惠民大药房（演练）', lngLat: offsetMeters(center, 640, -980), distanceM: 1170, source: 'sample' },
    { id: 'ph-4', name: '济仁药店（演练）', lngLat: offsetMeters(center, -760, -880), distanceM: 1163, source: 'sample' },
  ]
  return { model, pharmacies }
}

/** 兜底：示例路网没覆盖到的楼栋入口，补一条直角折线接到最近的路段点上 */
function connectOrphanEntrances(model: CommunityModel): CommunityModel {
  const linked = new Set<string>()
  for (const road of model.net.roads) {
    for (const p of road.points) {
      const lng = Array.isArray(p) ? p[0] : p.lng
      const lat = Array.isArray(p) ? p[1] : p.lat
      for (const b of model.buildings) {
        if (Math.abs(b.entrance.doorLngLat[0] - lng) < 1e-6 && Math.abs(b.entrance.doorLngLat[1] - lat) < 1e-6) linked.add(b.id)
      }
    }
  }
  let out = model
  const gate = out.net.gates[0]
  if (!gate) return out
  for (const b of out.buildings) {
    if (linked.has(b.id)) continue
    let anchor: LngLat = [gate.lngLat[0], gate.lngLat[1]]
    let bestD = Infinity
    for (const road of out.net.roads) {
      for (const p of road.points) {
        const lng = Array.isArray(p) ? p[0] : p.lng
        const lat = Array.isArray(p) ? p[1] : p.lat
        const d = Math.hypot(lng - b.entrance.doorLngLat[0], lat - b.entrance.doorLngLat[1])
        if (d < bestD) {
          bestD = d
          anchor = [lng, lat]
        }
      }
    }
    const elbow: LngLat = [(anchor[0] + b.entrance.doorLngLat[0]) / 2, anchor[1]]
    out = addRoad(out, [anchor, elbow, b.entrance.doorLngLat], `${b.name} 接管`)
  }
  return out
}
