import assert from 'node:assert/strict'
import { buildPresetCommunity } from '../src/domain/community/demo.ts'
import { pointInPolygon } from '../src/domain/geo/geometry.ts'
import { toLocalIn } from '../src/domain/community/frame.ts'
import { createEngine, orderEvacuation, resetEngine, tick } from '../src/domain/sim/engine.ts'
import { SampleExternalProvider } from '../src/domain/routing/external.ts'
import { RuleRanker } from '../src/domain/sim/ranker.ts'
import { estimatedResidents, evacuationByBuilding } from '../src/domain/sim/evacuation.ts'

const community = buildPresetCommunity()
const engine = createEngine({ community, seed: 42, disaster: 'flood', pharmacies: [], provider: new SampleExternalProvider(), ranker: new RuleRanker() })
engine.disaster.plan.events = []
const ids = community.buildings.map((b) => b.id)
orderEvacuation(engine, [...ids, ids[0]])
const batchCount = engine.state.evacuation.length
orderEvacuation(engine, ids)
assert.equal(engine.state.evacuation.length, batchCount)
assert.ok(batchCount > ids.length)
const expectedPeople = community.buildings.reduce((total, b) => total + estimatedResidents(b.floors, community.unitsPerFloor), 0)
assert.equal(evacuationByBuilding(engine.state.evacuation).size, ids.length)
assert.equal(engine.state.evacuation.reduce((total, batch) => total + batch.residents, 0), expectedPeople)
assert.ok(engine.state.evacuation.every((batch) => batch.residents >= 5 && batch.residents <= 30 && !batch.departed))

const router = engine.view.router
for (let i = 0; i < 9 && !engine.state.evacuation.some((batch) => batch.departed && batch.roads.length); i++) tick(engine, 1)
const group = engine.state.evacuation.find((batch) => batch.departed && batch.roads.length)!
assert.ok(group)
const initialResidents = estimatedResidents(community.buildings.find((b) => b.id === group.buildingId)!.floors, community.unitsPerFloor)
const remaining = evacuationByBuilding(engine.state.evacuation).get(group.buildingId)!.inside
assert.ok(remaining > 0 && remaining < initialResidents)
const position = group.position
const sealed = group.roads[0]
engine.state.closures[sealed] = { roadId: sealed } as typeof engine.state.closures[string]
tick(engine, 5)
assert.equal(group.status, 'blocked')
assert.deepEqual(group.position, position)
delete engine.state.closures[sealed]
let sawQueue = false
for (let i = 0; i < 400 && engine.state.evacuation.some((g) => g.status !== 'arrived'); i++) {
  tick(engine, 5)
  sawQueue ||= engine.state.evacuation.some((batch) => batch.gateQueuedAt !== undefined)
  const crossing = engine.state.evacuation.filter((batch) => batch.status === 'moving' && batch.vertices.length === 1 && batch.edgeM > 0)
  assert.equal(new Set(crossing.map((batch) => batch.vertices[0])).size, crossing.length)
}
assert.ok(sawQueue)
assert.ok(engine.state.evacuation.every((g) => g.status === 'arrived'))
assert.ok(engine.state.evacuation.every((g) => !pointInPolygon(toLocalIn(router.verts.frame, g.position), router.verts.frameLocal)))

resetEngine(engine)
assert.equal(engine.state.evacuation.length, 0)
const first = community.buildings[0]
engine.state.impacts.collapse = { targetType: 'building', targetId: first.id, level: '倒塌' } as typeof engine.state.impacts[string]
orderEvacuation(engine, [first.id])
for (let i = 0; i < 2; i++) tick(engine, 5)
assert.equal(engine.state.evacuation[0].status, 'blocked')
assert.deepEqual(engine.state.evacuation[0].position, first.entrance.doorLngLat)

for (const disaster of ['flood', 'fire', 'earthquake'] as const) {
  const scenario = createEngine({ community, seed: 42, disaster, untilAllEvacuated: true, durationS: 40, pharmacies: [], provider: new SampleExternalProvider(), ranker: new RuleRanker() })
  for (let i = 0; i < 36; i++) tick(scenario, 5)
  assert.equal(scenario.state.status, 'running')
  assert.ok(scenario.state.clock.t > scenario.state.config.durationS)
  orderEvacuation(scenario, ids)
  for (let i = 0; i < 1200 && scenario.state.status === 'running'; i++) tick(scenario, 5)
  assert.equal(scenario.state.status, 'finished')
  assert.equal(evacuationByBuilding(scenario.state.evacuation).size, ids.length)
  assert.equal(scenario.state.evacuation.reduce((total, batch) => total + batch.residents, 0), expectedPeople)
  const { frame, frameLocal } = scenario.view.router.verts
  assert.ok(scenario.state.evacuation.every((g) => g.status === 'arrived' && !pointInPolygon(toLocalIn(frame, g.position), frameLocal)))
}
console.log('Evacuation checks passed: closures, exterior assembly, collapse, reset, and all-resident completion for all three scenarios')

const continuous = createEngine({ community, seed: 42, untilAllEvacuated: true, continueAfterEvacuation: true, pharmacies: [], provider: new SampleExternalProvider(), ranker: new RuleRanker() })
continuous.disaster.plan.events = []
orderEvacuation(continuous, ids)
for (let i = 0; i < 400 && continuous.state.evacuationCompletedAt === undefined; i++) tick(continuous, 5)
const completedAt = continuous.state.evacuationCompletedAt
if (completedAt === undefined) throw new Error('All evacuees should reach assembly')
tick(continuous, 5)
assert.equal(continuous.state.status, 'running')
assert.equal(continuous.state.clock.t, completedAt + 5)
assert.equal(continuous.state.events.filter((event) => event.message.includes('进入灾情监测')).length, 1)
