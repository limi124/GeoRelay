import type { CommunityRouter } from '../routing/internal.ts'
import type { LngLat, Vec2 } from '../geo/types.ts'
import { fromLocal } from '../community/frame.ts'
import { add, dist, lerp, normalize, perpLeft, pointInPolygon, polygonSignedArea, polylineIntersectsSegment, projectOnPolyline, scale, sub } from '../geo/geometry.ts'
import type { BlockedSets } from './planner.ts'
import { hashSeed, rng } from '../util/rng.ts'

export type EvacuationStatus = 'queued' | 'moving' | 'blocked' | 'rescuing' | 'arrived'
export type RescuePriority = 'efficiency' | 'vulnerable'
export const RESCUE_PRIORITY_LABELS: Record<RescuePriority, string> = {
  efficiency: '效率优先',
  vulnerable: '老人及重点住户优先',
}

export interface EvacuationGroup {
  id: string
  buildingId: string
  residents: number
  releaseAt: number
  status: EvacuationStatus
  position: LngLat
  vertices: string[]
  roads: string[]
  edgeM: number
  assembly: LngLat | null
  departed: boolean
  rescueRemainingS?: number
  responderId?: string
  gateQueuedAt?: number
}

export const EVACUATION_SPEED_MPS = 1
export const estimatedResidents = (floors: number, unitsPerFloor = 4): number => Math.round(floors * unitsPerFloor * 2.6)

export function addEvacuationGroups(router: CommunityRouter, groups: EvacuationGroup[], buildingIds: string[], now: number, seed: number): void {
  const queued = new Set(groups.map((g) => g.buildingId))
  const selected = new Set(buildingIds)
  for (const b of router.model.buildings) {
    if (!selected.has(b.id) || queued.has(b.id)) continue
    const door = router.verts.byNode.get(`entrance:${b.id}`)
    const random = rng(hashSeed(seed, b.id))
    let remaining = estimatedResidents(b.floors, router.model.unitsPerFloor)
    let releaseAt = now + random.int(9)
    for (let batch = 1; remaining > 0; batch++) {
      let residents = Math.min(remaining, 5 + random.int(26))
      const remainder = remaining - residents
      if (remainder > 0 && remainder < 5) residents = remaining <= 30 ? remaining : remaining - 5
      groups.push({
        id: `${b.id}:${batch}`, buildingId: b.id, residents, releaseAt,
        status: 'queued', position: b.entrance.doorLngLat,
        vertices: door ? [door.id] : [], roads: [], edgeM: 0, assembly: null, departed: false,
      })
      remaining -= residents
      releaseAt += 5 + random.int(26)
    }
  }
}

export function stepEvacuation(router: CommunityRouter, groups: EvacuationGroup[], blocked: BlockedSets, seconds: number, now: number): void {
  if (groups.every((group) => group.status === 'arrived')) return
  const gates = new Map<string, Vec2>()
  for (const gate of router.model.net.gates) {
    const id = router.gateVertex(gate.id)
    const vertex = id ? router.verts.byId.get(id) : undefined
    const outside = vertex ? assemblyOutside(router, vertex.pos) : null
    if (id && outside) gates.set(id, outside)
  }
  const roads = new Set(blocked.roads)
  for (const road of router.model.net.roads) if (road.status !== 'user') roads.add(road.id)
  for (const link of router.verts.links) if (link.roadId.endsWith(':alt') && link.roadId.startsWith('access:')) roads.add(link.roadId)

  const occupiedGates = new Map<string, EvacuationGroup>()
  for (const group of groups) {
    if (group.status === 'moving' && group.vertices.length === 1 && group.assembly && group.edgeM > 0) {
      occupiedGates.set(group.vertices[0], group)
    }
  }
  const gateRequests = new Map<string, Array<{ group: EvacuationGroup; budget: number }>>()
  for (const group of groups) {
    if (group.status === 'arrived' || group.status === 'rescuing' || group.releaseAt > now) continue
    if (!group.vertices.length) {
      group.status = 'blocked'
      continue
    }
    const [at, next] = group.vertices
    const invalid = group.vertices.some((id, i) => (i > 0 || group.edgeM === 0) && blocked.verts.has(id)) || group.roads.some((id) => roads.has(id))
    if (group.edgeM === 0 && (invalid || !next)) {
      const path = router.router.shortest([at], [...gates.keys()], blocked.verts, roads)
      group.vertices = path.pathVertices.length ? path.pathVertices : [at]
      group.roads = path.roadIds
    }
    const assembly = gates.get(group.vertices.at(-1)!)
    group.assembly = assembly ? fromLocal(router.verts.frame, assembly) : null
    group.status = 'blocked'
    let budget = Math.min(seconds, now - group.releaseAt) * EVACUATION_SPEED_MPS
    while (group.vertices.length > 1) {
      const [from, to] = group.vertices
      if (roads.has(group.roads[0]) || blocked.verts.has(to)) break
      group.status = 'moving'
      if (budget <= 0) break
      const length = router.router.distanceBetween(from, to)
      const advance = Math.min(budget, Math.max(0, length - group.edgeM))
      group.edgeM += advance
      if (advance > 0) group.departed = true
      budget -= advance
      const a = router.verts.byId.get(from)!.pos
      const b = router.verts.byId.get(to)!.pos
      group.position = fromLocal(router.verts.frame, lerp(a, b, length ? group.edgeM / length : 1))
      if (group.edgeM < length) break
      group.edgeM = 0
      group.vertices.shift()
      group.roads.shift()
    }
    if (group.vertices.length !== 1 || !assembly || blocked.verts.has(group.vertices[0])) {
      group.gateQueuedAt = undefined
      continue
    }
    const gateId = group.vertices[0]
    const waiting = gateRequests.get(gateId) ?? []
    group.gateQueuedAt ??= now - budget / EVACUATION_SPEED_MPS
    waiting.push({ group, budget })
    gateRequests.set(gateId, waiting)
    group.status = 'moving'
  }
  for (const [gateId, requests] of gateRequests) {
    const gate = router.verts.byId.get(gateId)!.pos
    const assembly = gates.get(gateId)!
    const distance = dist(gate, assembly)
    const crossing = occupiedGates.get(gateId)
    requests.sort((a, b) => Number(b.group === crossing) - Number(a.group === crossing) || a.group.gateQueuedAt! - b.group.gateQueuedAt!)
    let available = seconds
    for (const { group, budget } of requests) {
      const time = Math.min(available, budget / EVACUATION_SPEED_MPS)
      if (time <= 0) continue
      const speed = distance / Math.max(distance / EVACUATION_SPEED_MPS, group.residents / 2)
      const advance = Math.min(distance - group.edgeM, time * speed)
      group.edgeM += advance
      if (advance > 0) group.departed = true
      group.position = fromLocal(router.verts.frame, lerp(gate, assembly, distance ? group.edgeM / distance : 1))
      group.status = group.edgeM >= distance - 1e-9 ? 'arrived' : 'moving'
      group.gateQueuedAt = undefined
      available = group.status === 'arrived' ? Math.max(0, time - (speed > 0 ? advance / speed : 0)) : 0
    }
  }
}

export function evacuationByBuilding(groups: EvacuationGroup[]) {
  const totals = new Map<string, { inside: number; waiting: number; arrived: number; residents: number; rescuing: number }>()
  for (const group of groups) {
    const count = totals.get(group.buildingId) ?? { inside: 0, waiting: 0, arrived: 0, residents: 0, rescuing: 0 }
    count.residents += group.residents
    if (!group.departed && group.status !== 'arrived') count.inside += group.residents
    if (group.status === 'blocked') count.waiting += group.residents
    if (group.status === 'arrived') count.arrived += group.residents
    if (group.status === 'rescuing') count.rescuing += group.residents
    totals.set(group.buildingId, count)
  }
  return totals
}

const transferSeconds = (group: EvacuationGroup): number => 45 + group.residents * 0.6

export function rescueQueue(router: CommunityRouter, groups: EvacuationGroup[], priority: RescuePriority): EvacuationGroup[] {
  const vulnerable = new Map(router.model.buildings.map((building) => [building.id, building.vulnerable ?? 0]))
  const activeBuildings = new Set(groups.filter((group) => group.status === 'rescuing').map((group) => group.buildingId))
  return groups.filter((group) => group.status === 'blocked' && !activeBuildings.has(group.buildingId)).sort((a, b) => {
    if (priority === 'vulnerable') {
      const difference = (vulnerable.get(b.buildingId) ?? 0) - (vulnerable.get(a.buildingId) ?? 0)
      if (difference) return difference
    }
    return b.residents / transferSeconds(b) - a.residents / transferSeconds(a)
  })
}

export function stepProfessionalRescue(router: CommunityRouter, groups: EvacuationGroup[], outside: LngLat, seconds: number, priority: RescuePriority, responderId: string): EvacuationGroup | undefined {
  const group = groups.find((g) => g.status === 'rescuing' && g.responderId === responderId) ?? rescueQueue(router, groups, priority)[0]
  if (!group || seconds <= 0) return
  const starting = group.status !== 'rescuing'
  if (starting) {
    group.status = 'rescuing'
    group.responderId = responderId
    group.rescueRemainingS = transferSeconds(group)
    const gate = router.model.net.gates.find((g) => assemblyOutside(router, g.local))
    const assembly = gate ? assemblyOutside(router, gate.local) : null
    group.assembly = assembly ? fromLocal(router.verts.frame, assembly) : outside
    group.vertices = []
    group.roads = []
  }
  group.rescueRemainingS = Math.max(0, group.rescueRemainingS! - seconds)
  if (group.rescueRemainingS === 0) {
    group.position = group.assembly!
    group.departed = true
    group.status = 'arrived'
  }
  return starting ? group : undefined
}

function assemblyOutside(router: CommunityRouter, gate: Vec2): Vec2 | null {
  const fence = router.verts.frameLocal
  if (fence.length < 3) return null
  const nearest = projectOnPolyline(gate, [...fence, fence[0]])
  if (nearest.distance > 30) return null
  const edge = sub(fence[(nearest.seg + 1) % fence.length], fence[nearest.seg])
  const normal = scale(normalize(perpLeft(edge)), polygonSignedArea(fence) > 0 ? -1 : 1)
  const outside = add(nearest.point, scale(normal, Math.max(14, nearest.distance + 4)))
  if (pointInPolygon(outside, fence)) return null
  if (router.model.buildings.some((b) => pointInPolygon(outside, b.footprint) || polylineIntersectsSegment([...b.footprint, b.footprint[0]], gate, outside))) return null
  return outside
}
