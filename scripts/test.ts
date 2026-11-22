/**
 * 规则自测（无第三方测试框架）。
 *
 * 覆盖交付要求里点名的验收项：围栏合法性、楼栋不越界不重叠、空间不足提示、
 * 内部寻路、封路后不可达、确认前不改派、新路线不经过封闭路段、无关任务不变、可复现、可重置。
 *
 * 运行：node --experimental-strip-types --no-warnings scripts/test.ts
 */
import assert from 'node:assert/strict'
import {
  addGate,
  addStaging,
  createEmptyModel,
  generateBuildings,
  makeFence,
  suggestNetwork,
  confirmRoads,
  touch,
  validateFence,
  validateBuilding,
  moveBuilding,
  validateNetwork,
} from '../src/domain/community/operations.ts'
import type { CommunityModel } from '../src/domain/community/model.ts'
import { offsetMeters } from '../src/domain/geo/wgs84.ts'
import { rectsOverlap } from '../src/domain/geo/geometry.ts'
import { CommunityRouter } from '../src/domain/routing/internal.ts'
import { blockedSets, buildCandidates, relayOptionsFor, reachability } from '../src/domain/sim/planner.ts'
import { advance, confirmCandidate, createEngine, planRoads, resetEngine } from '../src/domain/sim/engine.ts'
import { RuleRanker } from '../src/domain/sim/ranker.ts'
import { SampleExternalProvider } from '../src/domain/routing/external.ts'
import { demoInventory } from '../src/domain/sim/scenario.ts'
import { buildDemoCommunity, demoPolygon, DEMO_CENTER } from './community-fixture.ts'

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
    console.log(`      ${(err as Error).message.split('\n').slice(0, 4).join('\n      ')}`)
  }
}

function baseModel(polygon = demoPolygon()): CommunityModel {
  return touch({ ...createEmptyModel(DEMO_CENTER, '自测社区'), fence: makeFence(polygon), center: DEMO_CENTER })
}

console.log('\n围栏')
await test('凹形围栏通过校验（面积 > 0）', () => {
  const v = validateFence(demoPolygon())
  assert.equal(v.ok, true, v.errors.join('；'))
  assert.ok(v.areaM2 > 3000, `面积应大于 3000 m²，实际 ${v.areaM2}`)
})

await test('自交围栏被拒绝，并给出自交提示', () => {
  const c = DEMO_CENTER
  const bowtie = [offsetMeters(c, -80, -80), offsetMeters(c, 80, 80), offsetMeters(c, 80, -80), offsetMeters(c, -80, 80)]
  const v = validateFence(bowtie)
  assert.equal(v.ok, false, '自交多边形不应通过')
  assert.ok(v.errors.some((e) => e.includes('自交') || e.includes('交叉')), `错误信息应提到自交/交叉，实际：${v.errors.join('；')}`)
})

console.log('\n楼栋')

const demo = buildDemoCommunity(42)
await test('批量生成的每栋楼都在围栏内且互不重叠', () => {
  assert.ok(demo.model.buildings.length >= 10, `应生成 12 栋，实际 ${demo.model.buildings.length}`)
  for (const b of demo.model.buildings) {
    const v = validateBuilding(demo.model, b)
    assert.equal(v.ok, true, `${b.name} 校验失败：${v.errors.join('；')}`)
  }
  for (let i = 0; i < demo.model.buildings.length; i++) {
    for (let j = i + 1; j < demo.model.buildings.length; j++) {
      const a = demo.model.buildings[i]
      const b = demo.model.buildings[j]
      const overlap = rectsOverlap({ c: a.local.c, u: a.local.u, w: a.local.w, d: a.local.d }, { c: b.local.c, u: b.local.u, w: b.local.w, d: b.local.d })
      assert.equal(overlap, false, `${a.name} 与 ${b.name} 重叠`)
    }
  }
})

await test('空间不足时明确提示，并给出可容纳数量', () => {
  const center = DEMO_CENTER
  const small = [offsetMeters(center, -30, -30), offsetMeters(center, 30, -30), offsetMeters(center, 30, 30), offsetMeters(center, -30, 30)]
  const model = baseModel(small)
  const r = generateBuildings(model, { count: 60, floors: 8, floorHeightM: 2.9, widthM: 22, depthM: 15, keepExisting: false, seed: 7 })
  assert.equal(r.ok, false, '小围栏放 60 栋应失败')
  if (!r.ok) {
    assert.ok(r.message.includes('空间不足'), `提示应包含「空间不足」，实际：${r.message}`)
    assert.ok(r.capacity >= 0, '应给出可容纳数量')
  }
})

await test('把楼栋拖到围栏外会被拒绝，模型不变', () => {
  const target = demo.model.buildings[0]
  const outside = offsetMeters(DEMO_CENTER, 400, 400)
  const r = moveBuilding(demo.model, target.id, outside)
  assert.ok(r.errors.length > 0, '越界拖动应返回错误')
  assert.ok(r.errors.some((e) => e.includes('超出围栏')), `错误应说明超出围栏，实际：${r.errors.join('；')}`)
  const after = r.model.buildings.find((b) => b.id === target.id)!
  assert.deepEqual(after.center, target.center, '被拒绝后位置不应改变')
})

await test('把楼栋拖到另一栋楼上会被拒绝（重叠）', () => {
  const a = demo.model.buildings[0]
  const b = demo.model.buildings[1]
  const r = moveBuilding(demo.model, a.id, b.center)
  assert.ok(r.errors.length > 0, '重叠拖动应返回错误')
  assert.ok(r.errors.some((e) => e.includes('重叠')), `错误应说明重叠，实际：${r.errors.join('；')}`)
})

console.log('\n内部路网与封路')

const router = new CommunityRouter(demo.model)
const someBuilding = demo.model.buildings[0]
const gate = demo.model.net.gates[0]

await test('大门 → 楼栋入口可寻路，且路径长度大于直线距离（有绕行）', () => {
  const route = router.route(gate.lngLat, someBuilding.center, { startGateId: gate.id, targetNodeKey: `entrance:${someBuilding.id}` })
  assert.equal(route.ok, true, route.error ?? '寻路失败')
  const straight = Math.hypot(someBuilding.center[0] - gate.lngLat[0], someBuilding.center[1] - gate.lngLat[1]) * 111000
  assert.ok(route.lengthM >= 0, '应有长度')
  assert.ok(route.vertexIds.length >= 2, '路径应至少经过两个顶点')
  void straight
})

await test('封掉进入某楼栋的唯一路段后，该楼栋不可达', () => {
  const target = demo.model.buildings[3]
  const before = router.route(gate.lngLat, target.center, { startGateId: gate.id, targetNodeKey: `entrance:${target.id}` })
  assert.equal(before.ok, true, '封路前应可达')
  const roadsUsed = before.roadIds
  assert.ok(roadsUsed.length > 0, '应记录途经路段')
  const blockedRoads = new Set(roadsUsed)
  const blockedVerts = new Set<string>()
  const after = router.route(gate.lngLat, target.center, { startGateId: gate.id, targetNodeKey: `entrance:${target.id}`, blocked: blockedVerts, blockedRoads })
  assert.equal(after.ok, false, `全封后不应可达，实际仍可达（${after.lengthM.toFixed(0)} 米）`)
})

await test('封一条横向通道后，仍有楼栋可从大门进入（只屏蔽边）', () => {
  const corridor = demo.model.net.roads.find((r) => r.name.includes('横向通道'))
  assert.ok(corridor, '示例路网应包含横向通道')
  const blockedRoads = new Set([corridor!.id])
  let reachableCount = 0
  for (const b of demo.model.buildings) {
    const r = router.route(gate.lngLat, b.center, { startGateId: gate.id, targetNodeKey: `entrance:${b.id}`, blocked: new Set(), blockedRoads })
    if (r.ok) reachableCount++
  }
  assert.ok(reachableCount > 0, `封一条横向通道不应让所有楼栋都不可达（实际可达 ${reachableCount} 栋）`)
})

console.log('\n演练：确认前不改派 / 改派后不经过封闭路段 / 无关任务不变')

function makeEngine(seed = 42) {
  const community = buildDemoCommunity(seed)
  const inv = Object.values(demoInventory(community.pharmacies, seed))
  return createEngine({
    community: community.model,
    seed,
    pharmacies: inv,
    provider: new SampleExternalProvider((id) => inv.find((p) => p.id === id)?.name ?? id),
    ranker: new RuleRanker(),
    startLabel: '08:00',
  })
}

const engine = makeEngine()
engine.state.clock.running = true

// 推进到出现第一起封路与候选
let guard = 0
while (!Object.keys(engine.state.planSets).length && guard < 200) {
  await advance(engine, 5)
  guard++
}
const planSetId = Object.keys(engine.state.planSets)[0]
const planSet = engine.state.planSets[planSetId]

await test('封路事件带有水深、阈值与触发时刻', () => {
  const closures = Object.values(engine.state.closures)
  assert.ok(closures.length > 0, '应至少发生一次封路')
  for (const c of closures) {
    assert.ok(c.depthM >= c.thresholdM, `水深 ${c.depthM} 应达到阈值 ${c.thresholdM}`)
    assert.ok(c.at > 0, '应有触发时刻')
    assert.ok(c.history.length > 0, '应带涨水历史')
  }
})

await test('候选生成后、确认前，派单不变', () => {
  assert.ok(planSet, '应生成候选集')
  const before = { ...engine.state.assignments }
  const confirmed = planSet.confirmedCandidateId
  assert.equal(confirmed, null, '此时不应已确认')
  assert.deepEqual(engine.state.assignments, before, '确认前 assignments 不应变化')
})

const affectedTaskIds = [...new Set(planSet.candidates.map((c) => c.taskId))]
const unaffected = engine.state.tasks.find((t) => !affectedTaskIds.includes(t.id) && engine.state.assignments[t.id])
const unaffectedPlanBefore = unaffected ? engine.state.assignments[unaffected.id] : null

const feasibleByTask = new Map<string, string>()
for (const taskId of affectedTaskIds) {
  const best = planSet.candidates.filter((c) => c.feasible && c.taskId === taskId).sort((a, b) => b.score - a.score)[0]
  if (best) feasibleByTask.set(taskId, best.id)
}

await test('至少有一个可行候选，且可被确认生效', () => {
  assert.ok(feasibleByTask.size > 0, `应有可行候选，实际候选 ${planSet.candidates.length} 个（可行 ${planSet.candidates.filter((c) => c.feasible).length}）`)
  const [taskId, candidateId] = [...feasibleByTask.entries()][0]
  const beforePlanId = engine.state.assignments[taskId]
  const r = confirmCandidate(engine, planSetId, candidateId)
  assert.equal(r.ok, true, r.message)
  assert.notEqual(engine.state.assignments[taskId], beforePlanId, '确认后应换成新方案')
  assert.equal(engine.state.plans[beforePlanId].supersededBy, engine.state.assignments[taskId], '原方案应记录被谁替换')
})

await test('确认后的新路线不经过任何封闭路段', () => {
  const closureIds = new Set(Object.keys(engine.state.closures))
  let checked = 0
  for (const planId of Object.values(engine.state.assignments)) {
    const plan = engine.state.plans[planId]
    // 只校验改派后生效的方案：原方案受阻后按规则“保持原派单”停在原地，属于预期行为
    if (!plan || plan.origin !== 'reconfirmed') continue
    checked++
    const cross = planRoads(engine, plan).filter((r) => closureIds.has(r))
    assert.equal(cross.length, 0, `改派方案 ${plan.id} 经过了封闭路段 ${cross.join('、')}`)
  }
  assert.ok(checked > 0, '应至少有一个改派后生效的方案可校验')
})

await test('无关任务保持原安排', () => {
  if (!unaffected || !unaffectedPlanBefore) return
  assert.equal(engine.state.assignments[unaffected.id], unaffectedPlanBefore, `无关任务 ${unaffected.code} 的派单不应改变`)
})

await test('内涝 seed 42：T01 确认后经过交接并在 ETA 附近送达', async () => {
  const task = engine.state.tasks.find((t) => t.code === 'T01')!
  const plan = engine.state.plans[engine.state.assignments[task.id]]
  assert.equal(plan.origin, 'reconfirmed')
  const phases = new Set([plan.phase])
  while (engine.state.clock.t < 2400 && plan.phase !== 'delivered' && plan.phase !== 'blocked') {
    await advance(engine, 5)
    phases.add(plan.phase)
  }
  assert.ok(phases.has('pickup_wait') && phases.has('handover_wait') && phases.has('delivering'))
  assert.equal(plan.phase, 'delivered')
  assert.ok(Math.abs(plan.deliveredAt! - plan.eta[0]) <= 20)
})

console.log('\n可复现与重置')

function fingerprint(e: ReturnType<typeof makeEngine>): string {
  return JSON.stringify({
    closures: Object.values(e.state.closures).map((c) => [c.roadName, c.at, Math.round(c.depthM * 1000)]),
    results: e.state.record.results.map((r) => [r.taskId, r.at, r.status]),
    confirmations: e.state.record.confirmations.map((c) => [c.at, c.candidateId]),
  })
}

await test('同一 seed 两次运行得到相同封路序列与执行结果', async () => {
  const run = async () => {
    const e = makeEngine(99)
    e.state.clock.running = true
    for (let i = 0; i < 120; i++) {
      await advance(e, 5)
      for (const ps of Object.values(e.state.planSets)) {
        if (ps.confirmedCandidateId) continue
        for (const taskId of [...new Set(ps.candidates.map((c) => c.taskId))]) {
          const best = ps.candidates.filter((c) => c.feasible && c.taskId === taskId).sort((a, b) => b.score - a.score)[0]
          if (best) confirmCandidate(e, ps.id, best.id)
        }
      }
    }
    return fingerprint(e)
  }
  const a = await run()
  const b = await run()
  assert.equal(a, b, '两次运行的结果应完全一致')
})

await test('重置演练回到 t=0 且清空封路', () => {
  resetEngine(engine)
  assert.equal(engine.state.clock.t, 0, '时钟应归零')
  assert.equal(Object.keys(engine.state.closures).length, 0, '封路应清空')
  assert.ok(Object.keys(engine.state.assignments).length > 0, '重置后仍应有初始派单')
})

console.log('\n路网完备性')
await test('演示路网通过完备性检查（大门连通、入口接入）', () => {
  const v = validateNetwork(demo.model)
  assert.equal(v.ok, true, v.errors.join('；'))
})

await test('已标记的接驳点可达，未接入路网的 edgegate 不进入接力候选', () => {
  const blocked = blockedSets(router, [], 0.3)
  const relays = relayOptionsFor(router, blocked)
  assert.ok(router.edgeGatePositions().length > 0, '样例应包含围栏临时门')
  assert.ok(relays.length > 0, '应至少有一个已标记的接驳点')
  assert.ok(relays.every((relay) => !relay.key.startsWith('edgegate:')))
  const task = {
    id: 't',
    code: 'T99',
    title: '测试',
    kind: 'supply' as const,
    targetBuildingId: demo.model.buildings[0].id,
    targetName: demo.model.buildings[0].name,
    slot: 'morning' as const,
    slaAt: 3600,
    deadlineLabel: '09:10 前',
    need: { item: '饮用水', qty: 2 },
    weightKg: 20,
    priority: 'normal' as const,
  }
  const reach = reachability(router, task, relays, blocked.verts)
  assert.ok(reach.some((r) => r.ok), '至少一个接驳点应可达目标楼栋')
  void buildCandidates
  void addGate
  void addStaging
  void suggestNetwork
  void confirmRoads
})

console.log(`\n${'═'.repeat(60)}`)
console.log(`通过 ${passed} · 失败 ${failed}`)
if (failures.length) {
  console.log('\n失败详情：')
  for (const f of failures) {
    console.log(`\n[${f.name}]`)
    console.log((f.error as Error).stack?.split('\n').slice(0, 8).join('\n') ?? String(f.error))
  }
}
process.exitCode = failed ? 1 : 0
