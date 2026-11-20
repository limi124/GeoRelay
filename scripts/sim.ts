/**
 * 无头演练批处理。
 *
 * 与浏览器共用同一个模拟器（src/domain/sim/engine.ts），因此同一 seed + 同一步长
 * 必然得到同一封路序列与同一执行结果 —— 这是「可复现」与后续训练排序策略的基础。
 *
 * 用法：
 *   node --experimental-strip-types --no-warnings scripts/sim.ts
 *   node --experimental-strip-types --no-warnings scripts/sim.ts --seed=42 --step=5 --json
 *   node --experimental-strip-types --no-warnings scripts/sim.ts --no-auto-confirm
 */
import { advance, confirmCandidate, createEngine, planRoads, resetEngine, type Engine } from '../src/domain/sim/engine.ts'
import { RuleRanker } from '../src/domain/sim/ranker.ts'
import { SampleExternalProvider } from '../src/domain/routing/external.ts'
import { demoInventory } from '../src/domain/sim/scenario.ts'
import { buildDemoCommunity } from './community-fixture.ts'

interface Args {
  seed: number
  step: number
  max: number
  json: boolean
  autoConfirm: boolean
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback: string): string => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`))
    return hit ? hit.slice(name.length + 3) : fallback
  }
  return {
    seed: Number.parseInt(get('seed', '42'), 10),
    step: Math.max(1, Number.parseInt(get('step', '5'), 10)),
    max: Number.parseInt(get('max', '2400'), 10),
    json: argv.includes('--json'),
    autoConfirm: !argv.includes('--no-auto-confirm'),
  }
}

export async function runDrill(args: Args): Promise<{ engine: Engine; confirmed: number }> {
  const community = buildDemoCommunity(args.seed)
  const pharmacies = Object.values(demoInventory(community.pharmacies, args.seed))
  const engine = createEngine({
    community: community.model,
    seed: args.seed,
    pharmacies,
    provider: new SampleExternalProvider((id) => pharmacies.find((p) => p.id === id)?.name ?? id),
    ranker: new RuleRanker(),
    startLabel: '08:00',
    durationS: args.max,
  })
  engine.state.clock.running = true

  let confirmed = 0
  const handled = new Set<string>()
  for (let t = 0; t < args.max; t += args.step) {
    await advance(engine, args.step)
    if (!args.autoConfirm) continue
    for (const ps of Object.values(engine.state.planSets)) {
      if (ps.confirmedCandidateId || handled.has(ps.id)) continue
      // 每个受影响任务取一个可行候选；同一候选集可能覆盖多个任务
      const tasks = [...new Set(ps.candidates.map((c) => c.taskId))]
      for (const taskId of tasks) {
        const best = ps.candidates.filter((c) => c.feasible && c.taskId === taskId).sort((a, b) => b.score - a.score)[0]
        if (!best) continue
        const r = confirmCandidate(engine, ps.id, best.id)
        if (r.ok) confirmed++
      }
      handled.add(ps.id)
    }
    if (engine.state.status === 'finished') break
  }
  return { engine, confirmed }
}

function fmtTime(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.round(t % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function summarize(engine: Engine, confirmed: number): string {
  const s = engine.state
  const lines: string[] = []
  lines.push('═ GeoRelay 无头演练摘要 ' + '═'.repeat(46))
  lines.push(`社区：${s.communityName} · 种子 ${engine.seed} · 阈值 ${s.config.depthThresholdM} 米 · 时长 ${Math.round(s.config.durationS / 60)} 分钟`)
  lines.push('')
  lines.push('封路事件（结构化）')
  const closures = Object.values(s.closures)
  if (!closures.length) lines.push('  （无）')
  for (const c of closures) {
    lines.push(`  ${fmtTime(c.at)}  ${c.roadName}  水深 ${c.depthM.toFixed(2)}m ≥ 阈值 ${c.thresholdM.toFixed(2)}m  ${c.reason}`)
  }
  lines.push('')
  lines.push('候选与确认（状态快照 → 可行候选 → 选中方案）')
  const sets = Object.values(s.planSets)
  if (!sets.length) lines.push('  （无候选集）')
  for (const ps of sets) {
    const feasible = ps.candidates.filter((c) => c.feasible).length
    const chosen = ps.candidates.find((c) => c.id === ps.confirmedCandidateId)
    lines.push(`  ${fmtTime(ps.at)} ${ps.id}`)
    lines.push(`    快照：${ps.snapshot}`)
    lines.push(`    候选 ${ps.candidates.length} 个，可行 ${feasible} 个，排序：${ps.rankingMode}`)
    for (const c of ps.candidates.slice(0, 6)) {
      lines.push(`      [${c.feasible ? '可行' : '不可行'}] ${c.title} · 预计 ${(Math.max(...c.eta) / 60).toFixed(0)} 分钟 · 余量 ${(c.slackS / 60).toFixed(1)} 分钟`)
      if (!c.feasible) for (const r of c.reason.slice(0, 3)) lines.push(`         × ${r}`)
    }
    lines.push(`    选中：${chosen ? chosen.title : '（未确认，保持原派单）'}`)
  }
  lines.push('')
  lines.push('任务执行结果')
  for (const task of s.tasks) {
    const plan = s.plans[s.assignments[task.id]]
    const result = s.record.results.find((r) => r.taskId === task.id)
    const state = plan ? plan.phase : 'unassigned'
    const roads = plan ? planRoads(engine, plan).length : 0
    lines.push(
      `  ${task.code} ${task.targetName.padEnd(8, ' ')} 阶段 ${state.padEnd(14)} 送达 ${result ? fmtTime(result.at) : '—'}  时限 ${task.deadlineLabel}  ${result ? (result.slaMet ? '满足' : '超时') : '—'}  途经路段 ${roads}`,
    )
  }
  lines.push('')
  lines.push(`确认次数 ${confirmed} · 事件 ${s.events.length} 条 · 记录快照 ${s.record.snapshots.length} 条 · 库存变更 ${s.record.inventory.length} 条`)
  lines.push('═'.repeat(68))
  return lines.join('\n')
}

function toJson(engine: Engine): unknown {
  const s = engine.state
  return {
    seed: engine.seed,
    config: s.config,
    closures: Object.values(s.closures),
    planSets: Object.values(s.planSets).map((ps) => ({
      id: ps.id,
      at: ps.at,
      snapshot: ps.snapshot,
      rankingMode: ps.rankingMode,
      confirmedCandidateId: ps.confirmedCandidateId,
      candidates: ps.candidates.map((c) => ({
        id: c.id,
        taskId: c.taskId,
        kind: c.kind,
        title: c.title,
        feasible: c.feasible,
        eta: c.eta,
        slackS: c.slackS,
        checks: c.checks,
        reason: c.reason,
        isRelay: c.isRelay,
      })),
    })),
    tasks: s.tasks,
    assignments: s.assignments,
    results: s.record.results,
    confirmations: s.record.confirmations,
    events: s.events.map((e) => ({ at: e.at, kind: e.kind, message: e.message })),
  }
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/sim.ts')
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const { engine, confirmed } = await runDrill(args)
  // 复现性自检：同 seed 再跑一遍，比较封路序列与执行结果
  const second = await runDrill(args)
  const key = (e: Engine): string =>
    JSON.stringify({
      closures: Object.values(e.state.closures).map((c) => [c.roadName, c.at, Math.round(c.depthM * 1000)]),
      results: e.state.record.results.map((r) => [r.taskId, r.at, r.status]),
      confirmations: e.state.record.confirmations.map((c) => [c.at, c.candidateId]),
    })
  const reproducible = key(engine) === key(second.engine)

  if (args.json) {
    process.stdout.write(JSON.stringify({ ...(toJson(engine) as object), reproducible, confirmed }, null, 2) + '\n')
  } else {
    console.log(summarize(engine, confirmed))
    console.log(`\n可复现自检（同 seed 跑两遍）：${reproducible ? '通过 ✓' : '不一致 ✗'}`)
    // 重置后状态检查
    resetEngine(engine)
    console.log(`重置检查：t=${engine.state.clock.t}s，封路数=${Object.keys(engine.state.closures).length}，分配数=${Object.keys(engine.state.assignments).length}`)
  }
  process.exitCode = reproducible ? 0 : 1
}
