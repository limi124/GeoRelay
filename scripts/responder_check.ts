import assert from 'node:assert/strict'
import { advance, createEngine, dispatchFirefighters, resetEngine, tick, type Engine } from '../src/domain/sim/engine.ts'
import { advance as clockAdvance } from '../src/domain/sim/clock.ts'
import { RuleRanker } from '../src/domain/sim/ranker.ts'
import { SampleExternalProvider } from '../src/domain/routing/external.ts'
import { demoInventory, externalOrigin } from '../src/domain/sim/scenario.ts'
import { pathLengthM, pointAtFraction } from '../src/domain/geo/path.ts'
import { pointInPolygon } from '../src/domain/geo/geometry.ts'
import { toLocal } from '../src/domain/geo/wgs84.ts'
import type { ImpactEvent } from '../src/domain/disaster/types.ts'
import type { DisasterKind } from '../src/domain/sim/types.ts'
import { buildDemoCommunity } from './community-fixture.ts'

// Run: node --experimental-strip-types --no-warnings scripts/responder_check.ts
let passed = 0
let failed = 0
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`PASS ${name}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${name}`, error)
  }
}

function makeEngine(disaster: DisasterKind = 'fire', seed = 42): Engine {
  const community = buildDemoCommunity(seed)
  community.model.updatedAt = new Date(0).toISOString()
  return createEngine({
    community: community.model,
    seed,
    startMs: 0,
    pharmacies: Object.values(demoInventory(community.pharmacies, seed)),
    provider: new SampleExternalProvider(),
    ranker: new RuleRanker(),
    disaster,
    durationS: 2400,
  })
}

function impact(engine: Engine, at: number, patch: Partial<ImpactEvent> = {}): ImpactEvent {
  const b = engine.view.model.buildings[0]
  return {
    id: `test-impact:${at}`,
    disaster: engine.state.disaster,
    at,
    targetType: 'building',
    targetId: b.id,
    targetName: b.name,
    traffic: 'restricted',
    level: '起火',
    basis: ['Focused test impact'],
    reason: 'Focused test impact',
    ...patch,
  }
}

function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`)
}

function responseEvents(engine: Engine) {
  return engine.state.events.filter((e) => e.kind === 'responder_dispatched' || e.kind === 'responder_arrived')
}

function supplyState(engine: Engine) {
  const s = engine.state
  return { agents: s.agents, tasks: s.tasks, assignments: s.assignments, plans: s.plans, inventory: s.inventory, results: s.record.results, inventoryRecord: s.record.inventory }
}

await test('all three disasters dispatch once, only when an actual impact occurs', async () => {
  for (const kind of ['fire', 'earthquake', 'flood'] as const) {
    const engine = makeEngine(kind)
    const first = engine.disaster.plan.events.find((e) => e.traffic === 'blocked' || e.targetType === 'building')!
    assert.ok(first)
    assert.deepEqual(engine.state.responders, [])
    await advance(engine, first.at - 0.25)
    assert.equal(engine.state.responders.length, 0)
    tick(engine, 0.25)
    const r = engine.state.responders[0]
    assert.ok(r)
    assert.equal(r.dispatchedAt, first.at)
    assert.equal(r.progress, 0)
    assert.deepEqual(r.position, r.origin)
    assert.equal(r.speedMps, 80 / 3.6)
    assert.equal(engine.state.agents.length, 4)
    assert.ok(engine.state.agents.every((a) => a.role === 'external' || a.role === 'internal'))
    await advance(engine, 450)
    assert.equal(engine.state.responders.length, 1)
    assert.equal(responseEvents(engine).filter((e) => e.kind === 'responder_dispatched').length, 1)
    assert.equal(dispatchFirefighters(engine), r)
  }
})

await test('warnings do not dispatch; mid-tick impact counts only remaining travel time', async () => {
  const engine = makeEngine()
  engine.disaster.plan.events = [
    impact(engine, 1, { targetType: 'road', traffic: 'restricted' }),
    impact(engine, 2, { traffic: 'open', metrics: { damageRatio: 0 } }),
    impact(engine, 3, { traffic: 'restricted', metrics: { damageRatio: 0 } }),
    impact(engine, 7.25),
  ]
  tick(engine, 5)
  assert.equal(engine.state.responders.length, 0)
  tick(engine, 5)
  const r = engine.state.responders[0]
  assert.equal(r.dispatchedAt, 7.25)
  close(r.progress * r.pathLengthM, 2.75 * (80 / 3.6))
  close(r.remainingS, r.pathLengthM / r.speedMps - 2.75)
  assert.deepEqual(r.position, pointAtFraction(r.path, r.progress))
  assert.equal(responseEvents(engine)[0].at, 7.25)
  await advance(engine, 5)
  assert.equal(engine.state.responders.length, 1)
})

await test('blocking roads, entrances, staging, and open-but-damaged buildings trigger at t=0', () => {
  for (const targetType of ['road', 'entrance', 'staging', 'building'] as const) {
    const engine = makeEngine('earthquake')
    engine.disaster.plan.events = [impact(engine, 0, {
      targetType,
      traffic: targetType === 'building' ? 'open' : 'blocked',
      metrics: targetType === 'building' ? { damageRatio: 0.1 } : {},
    })]
    tick(engine, 2)
    const r = engine.state.responders[0]
    assert.ok(r)
    assert.equal(r.dispatchedAt, 0)
    close(r.progress * r.pathLengthM, 2 * r.speedMps)
    tick(engine, 2)
    assert.equal(responseEvents(engine).length, 1)
  }
})

await test('manual dispatch is deterministic, labelled, independent, and does not call routing', () => {
  const engine = makeEngine()
  const before = structuredClone(supplyState(engine))
  engine.provider.leg = async () => { throw new Error('Responder must not request a supply route') }
  const r = dispatchFirefighters(engine)!
  assert.equal(dispatchFirefighters(engine), r)
  assert.deepEqual(supplyState(engine), before)
  assert.deepEqual(r.origin, externalOrigin(engine.view.model.center, engine.seed, 2, engine.state.config.externalOriginRadiusM))
  assert.equal(r.originSource, 'sample')
  assert.ok(r.originName.includes('非真实消防站'))
  assert.equal(r.routeSource, 'sample')
  assert.ok(r.routeNote.includes('模拟') && r.routeNote.includes('未验证'))
  assert.equal(r.pathLengthM, pathLengthM(r.path))
  assert.equal(r.remainingS, r.pathLengthM / r.speedMps)
  assert.deepEqual(r.path, [r.origin, r.target])
  assert.ok(engine.view.model.net.gates.some((g) => JSON.stringify(g.lngLat) === JSON.stringify(r.target)))
  assert.ok(r.targetName.includes('集结点'))
  const local = toLocal(engine.view.router.verts.frame, r.target)
  assert.ok(engine.view.model.buildings.every((b) => !pointInPolygon(local, b.footprint)))
  assert.deepEqual(dispatchFirefighters(makeEngine()), r)
  const event = responseEvents(engine)[0]
  assert.deepEqual(event.refs, { responderIds: [r.id] })
  assert.equal(engine.state.record.events.find((e) => e.id === event.id), event)
})

await test('pause freezes responders; UI speed scales time once; explicit advance still works', async () => {
  const engine = makeEngine()
  const r = dispatchFirefighters(engine)!
  const initial = structuredClone(r)
  tick(engine, clockAdvance(engine.state.clock, 100))
  await advance(engine, 0)
  assert.deepEqual(r, initial)
  engine.state.clock.running = true
  engine.state.clock.speed = 4
  tick(engine, clockAdvance(engine.state.clock, 0.5))
  close(r.progress * r.pathLengthM, 2 * r.speedMps)
  engine.state.clock.running = false
  const paused = structuredClone(r)
  tick(engine, clockAdvance(engine.state.clock, 100))
  assert.deepEqual(r, paused)
  engine.state.clock.running = true
  engine.state.clock.speed = 60
  tick(engine, clockAdvance(engine.state.clock, 0.02))
  close(r.progress * r.pathLengthM, 3.2 * r.speedMps)
  engine.state.clock.running = false
  await advance(engine, 2)
  close(r.progress * r.pathLengthM, 5.2 * r.speedMps)
})

await test('arrival has exact ETA, emits once, and does not clear hazards or complete rescue', async () => {
  const engine = makeEngine()
  const control = makeEngine()
  const r = dispatchFirefighters(engine)!
  const eta = r.dispatchedAt + r.pathLengthM / r.speedMps
  await advance(engine, eta - 0.01)
  assert.equal(r.status, 'dispatched')
  close(r.remainingS, 0.01)
  await advance(engine, 0.02)
  assert.equal(r.status, 'arrived')
  assert.equal(r.progress, 1)
  assert.equal(r.remainingS, 0)
  assert.deepEqual(r.position, r.target)
  close(r.arrivedAt!, eta)
  const arrival = responseEvents(engine).find((e) => e.kind === 'responder_arrived')!
  close(arrival.at, eta)
  assert.ok(arrival.message.includes('不代表救援成功'))
  const arrived = structuredClone(r)
  await advance(engine, 200)
  await advance(control, eta - 0.01)
  await advance(control, 0.02)
  await advance(control, 200)
  assert.deepEqual(r, arrived)
  assert.equal(responseEvents(engine).filter((e) => e.kind === 'responder_arrived').length, 1)
  assert.deepEqual(supplyState(engine), supplyState(control))
  assert.deepEqual(engine.state.closures, control.state.closures)
  assert.deepEqual(engine.state.blockedDoors, control.state.blockedDoors)
  assert.deepEqual(engine.state.blockedStaging, control.state.blockedStaging)
  assert.deepEqual(engine.state.impacts, control.state.impacts)
  assert.deepEqual(engine.disaster.plan.hazardsAt(engine.state.clock.t), control.disaster.plan.hazardsAt(control.state.clock.t))
  assert.ok(!engine.state.events.some((e) => e.kind === 'road_cleared'))
  assert.ok(engine.state.record.results.every((r) => r.status !== 'rescued' && r.status !== 'assist_completed'))
})

await test('same seed and elapsed simulation time are independent of tick partition', () => {
  const a = makeEngine()
  const b = makeEngine()
  a.disaster.plan.events = [impact(a, 7.25)]
  b.disaster.plan.events = [impact(b, 7.25)]
  for (const dt of [5, 5, 5, 2]) tick(a, dt)
  for (let i = 0; i < 17; i++) tick(b, 1)
  assert.deepEqual(a.state.responders, b.state.responders)
})

await test('reset removes responders and response events, preserves speed, and replays dispatch', async () => {
  const engine = makeEngine()
  engine.state.clock.speed = 60
  const original = structuredClone(dispatchFirefighters(engine)!)
  await advance(engine, 400)
  resetEngine(engine)
  assert.deepEqual(engine.state.responders, [])
  assert.deepEqual(responseEvents(engine), [])
  assert.equal(engine.state.clock.t, 0)
  assert.equal(engine.state.clock.running, false)
  assert.equal(engine.state.clock.speed, 60)
  assert.deepEqual(engine.pendingProposals, [])
  assert.deepEqual(dispatchFirefighters(engine), original)
  resetEngine(engine)
  await advance(engine, 60)
  assert.equal(engine.state.responders.length, 1)
  assert.equal(engine.state.responders[0].dispatchedAt, 60)
})

await test('missing gates use staging; blocked or in-building nodes use an exterior simulated point', () => {
  const engine = makeEngine()
  engine.view.model.net.gates = []
  const r = dispatchFirefighters(engine)!
  assert.ok(engine.view.model.net.staging.some((st) => JSON.stringify(st.lngLat) === JSON.stringify(r.target)))
  const fallback = makeEngine()
  for (const g of fallback.view.model.net.gates) g.lngLat = [...fallback.view.model.buildings[0].center]
  for (const st of fallback.view.model.net.staging) fallback.state.blockedStaging[st.id] = impact(fallback, 0, { targetType: 'staging', targetId: st.id, traffic: 'blocked' })
  const outer = dispatchFirefighters(fallback)!
  assert.ok(outer.targetName.includes('外围模拟集结点'))
  assert.ok(!pointInPolygon(toLocal(fallback.view.router.verts.frame, outer.target), fallback.view.model.fence.localVertices))
  assert.ok(!pointInPolygon(toLocal(fallback.view.router.verts.frame, outer.origin), fallback.view.model.fence.localVertices))
})

await test('non-round drill end clamps travel, cannot restart, and disallows new finished dispatch', async () => {
  const engine = makeEngine()
  engine.state.config.durationS = 2.5
  const r = dispatchFirefighters(engine)!
  await advance(engine, 10)
  assert.equal(engine.state.clock.t, 2.5)
  assert.equal(engine.state.status, 'finished')
  close(r.progress * r.pathLengthM, 2.5 * r.speedMps)
  const ended = structuredClone(r)
  tick(engine, 5)
  assert.deepEqual(r, ended)
  assert.equal(dispatchFirefighters(engine), r)
  const empty = makeEngine()
  empty.state.status = 'finished'
  assert.equal(dispatchFirefighters(empty), null)
  empty.state.status = 'editing'
  assert.equal(dispatchFirefighters(empty), null)
})

console.log(`Responder checks: ${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
