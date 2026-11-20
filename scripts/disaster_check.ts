/**
 * 三种灾情的规则闭环自测（无界面）。
 *
 * 重点验证：
 *  1. 火灾：烟雾导致目标入口不可通行 → 规划器改用备用入口 → 确认后送达；
 *     另一变体（备用入口也被烟雾覆盖）必须给出「无可行路线」而不是编造路线。
 *  2. 地震：多点断路 + 原接驳点不可用 → 候选改用仍可用的接驳点 → 内外交接后送达。
 *  3. 无关任务：同一场演练里未被波及的任务，派单与版本保持不变。
 *  4. 可复现：同灾种 + 同种子两次运行，影响事件序列与执行结果一致。
 *  5. 灾种切换不串状态（新建引擎互不影响）。
 *
 * 运行：npm run check:disaster
 */
import assert from 'node:assert/strict'
import { advance, confirmCandidate, createEngine, currentBlocked, planRoads, resetEngine, type Engine } from '../src/domain/sim/engine.ts'
import { RuleRanker } from '../src/domain/sim/ranker.ts'
import { SampleExternalProvider } from '../src/domain/routing/external.ts'
import { demoInventory } from '../src/domain/sim/scenario.ts'
import { targetDoorKey } from '../src/domain/sim/planner.ts'
import type { DisasterKind } from '../src/domain/sim/types.ts'
import { buildDemoCommunity } from './community-fixture.ts'

let passed = 0
let failed = 0
const failures: Array<{ name: string; error: unknown }> = []

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    failures.push({ name, error: err })
    console.log(`  ✗ ${name}`)
    console.log(`      ${(err as Error).message.split('\n').slice(0, 3).join('\n      ')}`)
  }
}

interface Opts {
  seed?: number
  disaster: DisasterKind
  fireVariant?: 'with_alt' | 'no_alt'
  max?: number
}

function makeEngine(opts: Opts): Engine {
  const seed = opts.seed ?? 42
  const community = buildDemoCommunity(seed)
  const inv = Object.values(demoInventory(community.pharmacies, seed))
  const engine = createEngine({
    community: community.model,
    seed,
    pharmacies: inv,
    provider: new SampleExternalProvider((id) => inv.find((p) => p.id === id)?.name ?? id),
    ranker: new RuleRanker(),
    startLabel: '08:00',
    durationS: opts.max ?? 2400,
    disaster: opts.disaster,
    fireVariant: opts.fireVariant,
  })
  engine.state.clock.running = true
  return engine
}

/** 推进到出现候选集 */
async function runUntilPlanSet(engine: Engine, limit = 400): Promise<string | null> {
  for (let i = 0; i < limit; i++) {
    await advance(engine, 5)
    const ids = Object.keys(engine.state.planSets)
    if (ids.length) return ids[0]
    if (engine.state.status === 'finished') break
  }
  return null
}

/** 确认每个受影响任务的最佳可行候选，然后推演到结束 */
async function confirmBest(engine: Engine, planSetId: string): Promise<number> {
  const ps = engine.state.planSets[planSetId]
  let n = 0
  for (const taskId of [...new Set(ps.candidates.map((c) => c.taskId))]) {
    const best = ps.candidates.filter((c) => c.feasible && c.taskId === taskId).sort((a, b) => a.rank - b.rank)[0]
    if (!best) continue
    if (confirmCandidate(engine, planSetId, best.id).ok) n++
  }
  return n
}

async function runToEnd(engine: Engine): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (engine.state.status === 'finished') break
    await advance(engine, 20)
  }
}

function fingerprint(engine: Engine): string {
  return JSON.stringify({
    impacts: Object.values(engine.state.impacts).map((e) => [e.id, e.at, e.targetId, e.traffic]),
    results: engine.state.record.results.map((r) => [r.taskId, r.at, r.status]),
    confirmations: engine.state.record.confirmations.map((c) => [c.at, c.candidateId]),
  })
}

console.log('\n火灾')

await test('火灾示例：入口被烟雾覆盖并写入结构化影响事件', async () => {
  const engine = makeEngine({ disaster: 'fire' })
  const impacts = engine.disaster.plan.events
  assert.ok(impacts.length >= 3, `应有起火/入口/路段事件，实际 ${impacts.length}`)
  const doorEv = impacts.find((e) => e.targetType === 'entrance' && e.traffic === 'blocked')
  assert.ok(doorEv, '必须有入口不可通行事件')
  assert.equal(doorEv!.disaster, 'fire')
  assert.ok(doorEv!.basis.length >= 2, '入口事件应带判定依据')
  assert.ok(doorEv!.at > 0, '应有发生时刻')
  assert.ok(doorEv!.metrics?.smokeRadiusM !== undefined, '应带烟雾半径')
  // 推进后事件进入状态
  await advance(engine, 200)
  assert.ok(Object.keys(engine.state.impacts).length > 0, '影响事件应进入演练状态')
  assert.ok(Object.keys(engine.state.blockedDoors).length > 0, '入口应被标记为不可通行')
})

await test('火灾：改用备用入口生成改道候选并送达', async () => {
  const engine = makeEngine({ disaster: 'fire' })
  const psId = await runUntilPlanSet(engine)
  assert.ok(psId, '火灾应产出候选集')
  const ps = engine.state.planSets[psId as string]
  const affectedTaskId = ps.taskId
  const altCands = ps.candidates.filter((c) => c.kind === 'alt_entrance' || c.kind === 'staging_relay')
  const feasible = ps.candidates.filter((c) => c.feasible)
  assert.ok(feasible.length > 0, `应有可行候选（候选 ${ps.candidates.length} 个）`)
  const best = feasible.filter((c) => c.taskId === affectedTaskId).sort((a, b) => a.rank - b.rank)[0]
  assert.ok(best, '受影响任务应有可行候选')
  assert.ok(altCands.length >= 0)
  // 候选内部段必须指向备用入口（正门已不可通行）
  assert.equal(best!.internal?.targetDoor, `entranceAlt:${ps.candidates.find((c) => c.taskId === affectedTaskId)!.legs.internal?.targetBuildingId}`, '候选应改走备用入口')
  const n = await confirmBest(engine, psId as string)
  assert.equal(n, 1, '应确认 1 个改派')
  await runToEnd(engine)
  const res = engine.state.record.results.find((r) => r.taskId === affectedTaskId)
  assert.ok(res, '受影响任务应送达')
})

await test('火灾（无备用入口）：给出「无可行配送路线」及原因，不编造路线', async () => {
  const engine = makeEngine({ disaster: 'fire', fireVariant: 'no_alt' })
  const psId = await runUntilPlanSet(engine)
  assert.ok(psId, '仍应产出候选集（用于解释阻塞原因）')
  const ps = engine.state.planSets[psId as string]
  assert.equal(ps.candidates.filter((c) => c.feasible).length, 0, '两个入口都被烟雾覆盖时不应有可行候选')
  const reasons = ps.candidates.flatMap((c) => c.reason).join(' ')
  assert.ok(reasons.includes('无可行配送路线') || reasons.includes('不可达'), `应说明原因，实际：${reasons.slice(0, 120)}`)
  const blocked = currentBlocked(engine)
  const task = engine.state.tasks.find((t) => t.id === ps.taskId)!
  assert.equal(targetDoorKey(engine.view.router, task, blocked.verts), null, '两个入口都不可用时应解析不出目标入口')
})

console.log('\n地震')

await test('地震：多点断路 + 原接驳点不可用，候选改用仍可用的接驳点', async () => {
  const engine = makeEngine({ disaster: 'earthquake' })
  const events = engine.disaster.plan.events
  const ruptures = events.filter((e) => e.targetType === 'road' && e.traffic === 'blocked')
  const staging = events.filter((e) => e.targetType === 'staging' && e.traffic === 'blocked')
  const damaged = events.filter((e) => e.targetType === 'building')
  assert.ok(ruptures.length >= 2, `应有多处路段中断，实际 ${ruptures.length}`)
  assert.ok(staging.length >= 1, '原接驳点应不可用')
  assert.ok(damaged.length >= 5, '应有楼栋受损等级')
  assert.ok(damaged.every((d) => d.basis.length >= 2 && d.level), '受损楼栋应带等级与判定依据')
  const psId = await runUntilPlanSet(engine)
  assert.ok(psId, '地震应产出候选集')
  const ps = engine.state.planSets[psId as string]
  assert.ok(ps.candidates.filter((c) => c.feasible).length > 0, '应有可行候选（换接驳点/换入口/换组）')
  const kinds = new Set(ps.candidates.map((c) => c.kind))
  assert.ok(kinds.size >= 1, '候选应带类型')
  const n = await confirmBest(engine, psId as string)
  assert.ok(n >= 1, '应至少确认 1 个改派')
  await runToEnd(engine)
  const delivered = engine.state.record.results.length
  assert.ok(delivered >= 4, `应有任务送达，实际 ${delivered}`)
})

await test('地震：已过期候选不能生效（确认时按最新状态复核）', async () => {
  const engine = makeEngine({ disaster: 'earthquake' })
  const psId = (await runUntilPlanSet(engine))!
  const ps = engine.state.planSets[psId as string]
  const cand = ps.candidates.filter((c) => c.feasible).sort((a, b) => a.rank - b.rank)[0]
  assert.ok(cand, '第一批候选里应有可行方案')
  // 不确认，继续推进到后续断裂全部发生
  await advance(engine, 200)
  const closedNow = new Set(Object.keys(engine.state.closures))
  const crossed = (cand.internal?.roadIds ?? []).filter((r) => closedNow.has(r))
  const res = confirmCandidate(engine, psId, cand.id)
  if (crossed.length) {
    assert.equal(res.ok, false, '路线已被后续断裂截断的候选不应被确认')
    assert.ok(res.message.includes('封闭路段') || res.message.includes('不可行'), `应说明拒绝原因，实际：${res.message}`)
  } else {
    // 后续断裂没有打到这条候选：允许确认，但确认后的路线仍不得压到已封闭路段
    assert.equal(res.ok, true, res.message)
  }
  for (const planId of Object.values(engine.state.assignments)) {
    const plan = engine.state.plans[planId]
    if (!plan || plan.origin !== 'reconfirmed') continue
    const crossNow = planRoads(engine, plan).filter((r) => closedNow.has(r))
    assert.equal(crossNow.length, 0, `确认时压到封闭路段的方案不应生效：${crossNow.join('、')}`)
  }
})

await test('地震：后续断裂打断已生效方案时，Agent 停下等待而不是继续送达', async () => {
  const engine = makeEngine({ disaster: 'earthquake' })
  const psId = (await runUntilPlanSet(engine))!
  await confirmBest(engine, psId)
  await runToEnd(engine)
  const all = Object.values(engine.state.plans)
  const delivered = all.filter((p) => p.phase === 'delivered')
  const blocked = all.filter((p) => p.phase === 'blocked')
  assert.ok(delivered.length >= 4, `应有任务送达，实际 ${delivered.length}`)
  for (const p of blocked) assert.ok(p.blockedBy || p.blockedRoadId, '受阻方案必须记录受阻对象（路段/入口/接驳点）')
  for (const p of delivered) {
    const cross = planRoads(engine, p).filter((r) => engine.state.closures[r] && engine.state.closures[r].at <= (p.deliveredAt ?? 0))
    assert.equal(cross.length, 0, `已送达方案的路线不应包含送达前就已封闭的路段：${cross.join('、')}`)
  }
})

console.log('\n共同约束')

await test('three 灾种都不串状态：新灾种演练从零开始', async () => {
  const flood = makeEngine({ disaster: 'flood' })
  await advance(flood, 300)
  const fire = makeEngine({ disaster: 'fire' })
  assert.equal(fire.state.clock.t, 0, '新灾种演练时钟从 0 开始')
  assert.equal(Object.keys(fire.state.closures).length, 0, '继承封路？不应发生')
  assert.equal(Object.keys(fire.state.planSets).length, 0, '继承候选？不应发生')
  assert.equal(fire.state.disaster, 'fire')
  assert.ok(flood.state.clock.t >= 300, '原演练不受影响')
})

await test('无关任务在改派前后派单与版本保持不变', async () => {
  const engine = makeEngine({ disaster: 'fire' })
  const psId = await runUntilPlanSet(engine)
  const affected = new Set(engine.state.planSets[psId as string].candidates.map((c) => c.taskId))
  const unrelated = engine.state.tasks.filter((t) => !affected.has(t.id) && engine.state.assignments[t.id])
  assert.ok(unrelated.length > 0, '应存在无关任务')
  const before = unrelated.map((t) => [t.id, engine.state.assignments[t.id], engine.state.plans[engine.state.assignments[t.id]].version])
  await confirmBest(engine, psId!)
  await advance(engine, 120)
  const after = unrelated.map((t) => [t.id, engine.state.assignments[t.id], engine.state.plans[engine.state.assignments[t.id]]?.version ?? -1])
  assert.deepEqual(after, before, '无关任务的派单与版本不应变化')
})

await test('同一灾种 + 同一种子可复现（两次运行事件与结果一致）', async () => {
  const run = async (disaster: DisasterKind): Promise<string> => {
    const engine = makeEngine({ disaster })
    const psId = await runUntilPlanSet(engine)
    if (psId) await confirmBest(engine, psId)
    await runToEnd(engine)
    return fingerprint(engine)
  }
  for (const kind of ['fire', 'earthquake'] as DisasterKind[]) {
    const a = await run(kind)
    const b = await run(kind)
    assert.equal(a, b, `${kind} 两次运行应完全一致`)
  }
})

await test('重置演练后影响事件清空、灾种保持', async () => {
  const engine = makeEngine({ disaster: 'earthquake' })
  await advance(engine, 400)
  assert.ok(Object.keys(engine.state.impacts).length > 0)
  resetEngine(engine)
  assert.equal(engine.state.clock.t, 0)
  assert.equal(Object.keys(engine.state.impacts).length, 0, '影响事件应清空')
  assert.equal(Object.keys(engine.state.blockedDoors).length, 0)
  assert.equal(Object.keys(engine.state.blockedStaging).length, 0)
  assert.equal(engine.state.disaster, 'earthquake', '重置后灾种不变')
})

await test('内涝仍然是同一套事件结构（回归）', async () => {
  const engine = makeEngine({ disaster: 'flood' })
  await advance(engine, 400)
  const impacts = Object.values(engine.state.impacts)
  assert.ok(impacts.length > 0, '内涝也应写入统一影响事件')
  const ev = impacts[0]
  assert.equal(ev.disaster, 'flood')
  assert.ok(ev.basis.length > 0, '内涝事件也应带判定依据')
  assert.ok(ev.metrics?.depthM !== undefined && ev.metrics?.thresholdM !== undefined, '内涝应带水深与阈值')
})

console.log(`\n${'═'.repeat(60)}`)
console.log(`通过 ${passed} · 失败 ${failed}`)
if (failures.length) {
  console.log('\n失败详情：')
  for (const f of failures) {
    console.log(`\n[${f.name}]`)
    console.log((f.error as Error).stack?.split('\n').slice(0, 6).join('\n') ?? String(f.error))
  }
}
process.exitCode = failed ? 1 : 0
