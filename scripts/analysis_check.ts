/** Focused domain checks: node --experimental-strip-types --no-warnings scripts/analysis_check.ts */
import assert from 'node:assert/strict'
import { analyzeResilience, type ResilienceOptions, type ResilienceReport } from '../src/domain/community/analysis.ts'
import type { Building, CommunityModel, Road } from '../src/domain/community/model.ts'
import { createEmptyModel } from '../src/domain/community/operations.ts'
import { fromLocal, localFrameFromFence } from '../src/domain/community/frame.ts'
import { rectCorners } from '../src/domain/geo/geometry.ts'
import { CommunityRouter } from '../src/domain/routing/internal.ts'
import { buildDemoCommunity, DEMO_CENTER } from './community-fixture.ts'

let passed = 0
let failed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`PASS ${name}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${name}`, error)
  }
}
function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-6, `Expected ${expected}, received ${actual}`)
}

const sample = buildDemoCommunity(42).model
const frame = localFrameFromFence(sample.fence.polygon).frame
const world = (x: number, y = 0) => fromLocal(frame, { x, y })
function building(id: string, x: number): Building {
  const local = { c: { x, y: 10 }, u: { x: 1, y: 0 }, w: 20, d: 20 }
  return {
    ...sample.buildings[0], id, name: id, local,
    center: world(x, 10), footprint: rectCorners(local), widthM: 20, depthM: 20,
    entrance: { edgeIndex: 0, doorPoint: { x, y: 0 }, doorLngLat: world(x) },
    vulnerable: 0,
  }
}
function road(id: string, points: Road['points']): Road {
  return { id, name: id, points, status: 'user' }
}
/** Known metre geometry, retaining the existing sample's model/fence conventions. */
function lineModel(doorX = 100, stagingX = 90): CommunityModel {
  return {
    ...structuredClone(sample), buildings: [building('b1', doorX)],
    net: {
      gates: [{ id: 'g1', name: 'gate', local: { x: 0, y: 0 }, lngLat: world(0) }],
      staging: [{ id: 's1', name: 'staging', local: { x: stagingX, y: 0 }, lngLat: world(stagingX) }],
      roads: [road('main', [world(0), world(stagingX), world(doorX)])],
    },
  }
}
const primary = 'entrance:b1'
const alternate = 'entranceAlt:b1'
function hasIssue(report: ResilienceReport, kind: string, targetId?: string, level?: string): boolean {
  return report.issues.some((i) => i.kind === kind && i.targetId === targetId && (!level || i.level === level))
}
function assertNotSafe(report: ResilienceReport): void {
  assert.ok(report.issues.length > 0, 'EditorSidebar must not enter its empty-issues coverage-good branch')
  assert.ok(report.issues.some((i) => i.level === 'high'), 'Incomplete input must remain a high-priority issue')
  assert.ok(!report.issues.some((i) => /覆盖良好|属于高风险慢响应区域|合理半径/.test(i.message)))
}

test('staging starts at its own vertex, not via a gate; geometric distance excludes turn cost', () => {
  const model = lineModel()
  model.net.roads = [road('approach', [world(0), world(90)]), road('delivery', [world(90), world(100)])]
  const router = new CommunityRouter(model)
  const legacy = router.route(model.net.staging[0].lngLat, model.buildings[0].entrance.doorLngLat, { targetNodeKey: primary })
  const report = analyzeResilience(model)
  close(report.buildings[0].stagingDistanceM, 10)
  close(report.buildings[0].gateDistanceM, 100)
  assert.ok(legacy.lengthM > report.buildings[0].stagingDistanceM + 100)
  const path = router.router.shortest(['g1'], [primary], new Set())
  assert.ok(path.cost > path.distance)
  assert.equal(report.summary.avgGateDistanceM, 100)
})

test('each gate uses its explicit ID, even when another gate has identical coordinates', () => {
  const model = lineModel()
  model.net.gates = [{ ...model.net.gates[0], id: 'disconnected' }, model.net.gates[0]]
  const report = analyzeResilience(model)
  close(report.buildings[0].gateDistanceM, 100)
  assert.equal(report.buildings[0].gateStatus, 'reachable')
})

test('sample results match explicit source/door routing and do not mutate inputs', () => {
  const before = JSON.stringify(sample)
  const options: ResilienceOptions = {
    blockedRoadIds: new Set([sample.net.roads[0].id]),
    blockedDoorIds: new Set([`entrance:${sample.buildings[0].id}`]),
    blockedStagingIds: new Set([sample.net.staging[0].id]),
  }
  const router = new CommunityRouter(sample)
  const blocked = new Set([`entrance:${sample.buildings[0].id}`, sample.net.staging[0].id])
  const roads = new Set(options.blockedRoadIds)
  const report = analyzeResilience(sample, options)
  for (const b of report.buildings) {
    const doors = [`entrance:${b.id}`, `entranceAlt:${b.id}`]
    for (const kind of ['gate', 'staging'] as const) {
      const sources = kind === 'gate' ? sample.net.gates : sample.net.staging
      const distances = sources.flatMap((s) => doors.flatMap((door) => {
        const result = router.router.shortest([router.verts.byNode.get(`${kind}:${s.id}`)!.id], [door], blocked, roads)
        return result.pathVertices.length ? [result.distance] : []
      }))
      close(b[kind === 'gate' ? 'gateDistanceM' : 'stagingDistanceM'], distances.length ? Math.min(...distances) : -1)
    }
  }
  assert.equal(JSON.stringify(sample), before)
  assert.deepEqual([...options.blockedRoadIds!], [sample.net.roads[0].id])
  assert.deepEqual([...options.blockedDoorIds!], [`entrance:${sample.buildings[0].id}`])
  assert.deepEqual([...options.blockedStagingIds!], [sample.net.staging[0].id])
  assert.deepEqual(analyzeResilience(sample, options), report)
})

test('connected staging does not hide disconnected external gate access', () => {
  const model = lineModel()
  model.net.roads = [road('delivery', [world(90), world(100)])]
  const report = analyzeResilience(model)
  close(report.buildings[0].stagingDistanceM, 10)
  assert.equal(report.buildings[0].gateStatus, 'unreachable')
  assert.equal(report.buildings[0].reachable, true)
  assert.equal(report.summary.avgGateDistanceM, -1)
  assert.equal(report.summary.isolatedCount, 0)
  assert.ok(hasIssue(report, 'gate-gap', 'b1', 'high'))
})

test('staging-only network is evaluated without inventing a gate', () => {
  const model = lineModel()
  model.net.gates = []
  const report = analyzeResilience(model)
  close(report.buildings[0].stagingDistanceM, 10)
  assert.equal(report.buildings[0].gateStatus, 'unavailable')
  assert.equal(report.summary.gateReachableCount, 0)
  assert.equal(report.summary.avgGateDistanceM, -1)
  assert.ok(hasIssue(report, 'gate-gap', undefined, 'high'))
})

test('gate-only network distinguishes missing staging from zero-distance coverage', () => {
  const model = lineModel()
  model.net.staging = []
  const report = analyzeResilience(model)
  close(report.buildings[0].gateDistanceM, 100)
  assert.equal(report.buildings[0].stagingStatus, 'unavailable')
  assert.equal(report.summary.avgStagingDistanceM, -1)
  assert.equal(report.summary.stagingReachableCount, 0)
  assert.ok(hasIssue(report, 'staging-gap', undefined, 'high'))
})

test('missing all sources is unassessed, not proven isolation', () => {
  const model = lineModel()
  model.net.gates = []
  model.net.staging = []
  const report = analyzeResilience(model)
  assert.equal(report.summary.unassessedCount, 1)
  assert.equal(report.summary.isolatedCount, 0)
  assert.equal(report.buildings[0].reachable, false)
  assert.equal(report.buildings[0].singleEntry, false)
  assertNotSafe(report)
})

test('road closure blocks edges, not the staging junction shared by another road', () => {
  const model = lineModel()
  model.net.roads = [road('approach', [world(0), world(90)]), road('delivery', [world(90), world(100)])]
  const report = analyzeResilience(model, { blockedRoadIds: ['approach'] })
  close(report.buildings[0].stagingDistanceM, 10)
  assert.equal(report.buildings[0].gateStatus, 'unreachable')
  assert.equal(report.buildings[0].reachableEntryCount, 2)
})

test('both candidate doors count; closing the primary uses the derived alternate with a warning', () => {
  const model = lineModel()
  const before = analyzeResilience(model)
  assert.equal(before.buildings[0].reachableEntryCount, 2)
  assert.equal(before.buildings[0].singleEntry, false)
  const after = analyzeResilience(model, { blockedDoorIds: [primary] })
  assert.equal(after.buildings[0].reachableEntryCount, 1)
  assert.equal(after.buildings[0].singleEntry, true)
  close(after.buildings[0].stagingDistanceM, Math.hypot(10, 21.5))
  assert.ok(hasIssue(after, 'single-entry', 'b1', 'high'))
  assert.ok(after.issues.some((i) => i.message.includes('仅推导的备用门')))
})

test('closing the alternate leaves one primary door; closing both gives modeled isolation', () => {
  const model = lineModel()
  const one = analyzeResilience(model, { blockedDoorIds: new Set([alternate]) })
  close(one.buildings[0].stagingDistanceM, 10)
  assert.equal(one.buildings[0].singleEntry, true)
  assert.ok(hasIssue(one, 'single-entry', 'b1', 'medium'))
  const none = analyzeResilience(model, { blockedDoorIds: [primary, alternate] })
  assert.equal(none.buildings[0].reachableEntryCount, 0)
  assert.equal(none.buildings[0].singleEntry, false)
  assert.equal(none.buildings[0].gateStatus, 'unreachable')
  assert.equal(none.summary.isolatedCount, 1)
  assert.equal(none.summary.unassessedCount, 0)
  assert.equal(none.summary.avgStagingDistanceM, -1)
  assert.equal(none.summary.avgGateDistanceM, -1)
  assert.ok(hasIssue(none, 'isolated', 'b1', 'high'))
})

test('severed primary road can use the alternate; its synthetic access edge can also be blocked', () => {
  const model = lineModel()
  const alternateOnly = analyzeResilience(model, { blockedRoadIds: ['main'] })
  assert.equal(alternateOnly.buildings[0].reachable, true)
  assert.equal(alternateOnly.buildings[0].singleEntry, true)
  assert.ok(hasIssue(alternateOnly, 'single-entry', 'b1', 'high'))
  const isolated = analyzeResilience(model, { blockedRoadIds: ['main', 'access:b1:alt'] })
  assert.equal(isolated.summary.isolatedCount, 1)
})

test('blocked staging ID removes the graph vertex, including transit through that vertex', () => {
  const model = lineModel()
  const report = analyzeResilience(model, { blockedStagingIds: ['s1'] })
  assert.equal(report.buildings[0].stagingStatus, 'unreachable')
  assert.equal(report.buildings[0].gateStatus, 'unreachable')
  assert.equal(report.summary.isolatedCount, 1)
  assert.ok(hasIssue(report, 'staging-gap', undefined, 'high'))
  model.net.roads.push(road('bypass', [world(0), world(100)]))
  const bypass = analyzeResilience(model, { blockedStagingIds: ['s1'] })
  close(bypass.buildings[0].gateDistanceM, 100)
  assert.equal(bypass.buildings[0].stagingDistanceM, -1)
  assert.ok(hasIssue(bypass, 'staging-gap', 'b1', 'high'))
})

test('nearest remaining staging point is used after one is disabled', () => {
  const model = lineModel()
  model.net.staging.push({ id: 's2', name: 'other', local: { x: 70, y: 30 }, lngLat: world(70, 30) })
  model.net.roads.push(road('other', [world(0), world(70, 30), world(100)]))
  const report = analyzeResilience(model, { blockedStagingIds: ['s1'] })
  close(report.buildings[0].stagingDistanceM, Math.hypot(30, 30))
  assert.equal(report.buildings[0].stagingStatus, 'reachable')
})

test('mixed reachable/unreachable averages use separate reachable denominators', () => {
  const model = lineModel()
  model.buildings.push(building('b2', 200))
  model.net.roads.push(road('second', [world(90), world(200)]))
  const report = analyzeResilience(model, { blockedDoorIds: ['entrance:b2', 'entranceAlt:b2'] })
  assert.equal(report.summary.totalBuildings, 2)
  assert.equal(report.summary.isolatedCount, 1)
  assert.equal(report.summary.stagingReachableCount, 1)
  assert.equal(report.summary.gateReachableCount, 1)
  assert.equal(report.summary.avgStagingDistanceM, 10)
  assert.equal(report.summary.avgGateDistanceM, 100)
})

test('zero-distance reachable samples are included in the mean', () => {
  const model = lineModel()
  // Derived alternate b1 is at (100, 21.5), exactly at the staging source.
  model.net.staging[0] = { ...model.net.staging[0], local: { x: 100, y: 21.5 }, lngLat: world(100, 21.5) }
  model.buildings.push(building('b2', 200))
  model.net.roads = [road('main', [world(0), world(100), world(100, 21.5), world(200)])]
  const report = analyzeResilience(model)
  close(report.buildings[0].stagingDistanceM, 0)
  close(report.buildings[1].stagingDistanceM, 100)
  assert.equal(report.summary.stagingReachableCount, 2)
  assert.equal(report.summary.avgStagingDistanceM, 50)
})

test('empty model, empty buildings, absent roads and invalid fence never claim coverage', () => {
  const noBuildings = lineModel()
  noBuildings.buildings = []
  const noRoads = lineModel()
  noRoads.net.roads = []
  const invalidFence = lineModel()
  invalidFence.fence.polygon = [world(0), world(100, 100), world(0, 100), world(100)]
  for (const model of [createEmptyModel(DEMO_CENTER, 'empty'), noBuildings, noRoads, invalidFence]) {
    const report = analyzeResilience(model)
    assertNotSafe(report)
    assert.equal(report.summary.avgGateDistanceM, -1)
    assert.equal(report.summary.avgStagingDistanceM, -1)
    assert.equal(report.summary.isolatedCount, 0)
    for (const b of report.buildings) {
      assert.equal(b.gateStatus, 'unavailable')
      assert.equal(b.stagingStatus, 'unavailable')
      assert.equal(b.reachable, false)
    }
  }
})

test('suggested and degenerate roads are not sufficient input for coverage', () => {
  const suggested = lineModel()
  suggested.net.roads[0].status = 'suggested'
  const degenerate = lineModel()
  degenerate.net.roads[0].points = [world(0), world(0)]
  for (const model of [suggested, degenerate]) {
    const report = analyzeResilience(model)
    assertNotSafe(report)
    assert.equal(report.summary.unassessedCount, 1)
    assert.equal(report.summary.avgStagingDistanceM, -1)
  }
  const mixed = lineModel()
  mixed.net.roads = [road('approach', [world(0), world(90)]), { ...road('delivery', [world(90), world(100)]), status: 'suggested' }]
  const report = analyzeResilience(mixed, { blockedDoorIds: [alternate] })
  assert.equal(report.summary.isolatedCount, 1, 'An unconfirmed delivery road must not supply a route')
  assertNotSafe(report)
})

test('250/300/500 metre cutoffs are strict demo assumptions, not professional limits', () => {
  const gateBoundary = analyzeResilience(lineModel(250, 50))
  assert.equal(hasIssue(gateBoundary, 'gate-gap', 'b1'), false)
  const gateOver = analyzeResilience(lineModel(250.1, 50))
  assert.ok(hasIssue(gateOver, 'gate-gap', 'b1', 'medium'))
  const stagingBoundary = analyzeResilience(lineModel(350, 50))
  assert.equal(hasIssue(stagingBoundary, 'distant', 'b1'), false)
  const stagingOver = analyzeResilience(lineModel(350.1, 50))
  assert.ok(hasIssue(stagingOver, 'distant', 'b1', 'medium'))
  assert.ok(hasIssue(stagingOver, 'staging-gap', undefined, 'medium'), 'Compare unrounded mean with threshold')
  const farBoundary = analyzeResilience(lineModel(550, 50))
  assert.ok(hasIssue(farBoundary, 'distant', 'b1', 'medium'))
  const farOver = analyzeResilience(lineModel(550.1, 50))
  assert.ok(hasIssue(farOver, 'distant', 'b1', 'high'))
  for (const report of [gateOver, stagingOver, farBoundary, farOver]) {
    for (const issue of report.issues.filter((i) => i.message.includes('阈值'))) {
      assert.ok(issue.message.includes('演示假设') && issue.message.includes('非专业标准'))
    }
  }
})

test('vulnerable and partial-coverage issues sort high first; means identify excluded buildings', () => {
  const model = lineModel(650, 50)
  model.buildings[0].vulnerable = 3
  model.buildings.push(building('b2', 200))
  const report = analyzeResilience(model, { blockedDoorIds: ['entrance:b2', 'entranceAlt:b2'] })
  assert.equal(report.summary.vulnerableTotal, 3)
  assert.equal(report.summary.distantCount, 1)
  assert.equal(report.summary.avgStagingDistanceM, 600)
  assert.ok(hasIssue(report, 'vulnerable-distant', 'b1', 'high'))
  assert.ok(report.issues.some((i) => i.kind === 'staging-gap' && i.message.includes('1/2')))
  const priorities = { high: 0, medium: 1, low: 2 }
  const ranks = report.issues.map((i) => priorities[i.level])
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b))
})

test('short routes still disclose derived-door and coverage limitations to the unchanged UI', () => {
  const report = analyzeResilience(lineModel())
  assert.ok(report.issues.length > 0)
  const assumption = report.issues.find((i) => i.kind === 'assumption')!
  assert.ok(assumption.message.includes('非专业标准'))
  assert.ok(assumption.suggestion.includes('自动推导'))
  assert.ok(assumption.suggestion.includes('不构成安全'))
})

console.log(`\nAnalysis checks: ${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
