/**
 * 无头调度对照实验：同一场内涝下，「保持原派单」与「事件触发后改派」的差别。
 *
 * 两条策略共用**完全相同**的输入：同一个演示社区、同一个随机种子、同一步长、
 * 同一仿真时长、同一外生灾情（封路事件由社区+种子决定，运行前就固定）。
 * 因此两组的封路序列必须逐条相同 —— 脚本会断言这一点。
 *
 * 策略：
 *   static  静态基线：保留原派单。Agent 遇到封路就停在原地，不做任何改派。
 *   rules   规则调度：只为「受影响任务」挑选**通过规则校验**的可行候选并在无头实验中
 *           模拟指挥员确认。候选来自现有规则规划器，排序复用 CandidateRanker 接口
 *           （默认 RuleRanker）。这里不碰 Web 指挥台的人工确认流程。
 *
 * 用法：
 *   npm run compare
 *   npm run compare -- --seeds=42,7,99 --step=5 --max=2400
 *   npm run compare -- --json > artifacts/compare.json
 *   npm run compare -- --seeds=42 --no-repro
 *
 * 这个脚本只做「评估基线」：不训练模型、不新增依赖、不改规划器规则。
 */
import { advance, confirmCandidate, createEngine, planRoads, type Engine } from '../src/domain/sim/engine.ts'
import type { CandidateRanker } from '../src/domain/sim/ranker.ts'
import { RuleRanker } from '../src/domain/sim/ranker.ts'
import { SampleExternalProvider } from '../src/domain/routing/external.ts'
import { demoInventory } from '../src/domain/sim/scenario.ts'
import type { Plan, Task } from '../src/domain/sim/types.ts'
import { buildDemoCommunity } from './community-fixture.ts'

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

export type Strategy = 'static' | 'rules'

interface Args {
  seeds: number[]
  step: number
  max: number
  json: boolean
  repro: boolean
  out: string | null
}

const DEFAULT_SEEDS = [42, 7, 99]

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback: string): string => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`))
    return hit ? hit.slice(name.length + 3) : fallback
  }
  const seeds = get('seeds', DEFAULT_SEEDS.join(','))
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n))
  return {
    seeds: seeds.length ? seeds : DEFAULT_SEEDS,
    step: Math.max(1, Number.parseInt(get('step', '5'), 10)),
    max: Math.max(300, Number.parseInt(get('max', '2400'), 10)),
    json: argv.includes('--json'),
    repro: !argv.includes('--no-repro'),
    out: get('out', '') || null,
  }
}

// ---------------------------------------------------------------------------
// 指标口径（同时写进 JSON，便于以后和 AI / RL 策略对照）
// ---------------------------------------------------------------------------

export const METRIC_DEFINITIONS = {
  taskTotal: '派生出任务的总数（由社区楼栋决定，两组相同）',
  delivered: '演练结束时状态为已送达的任务数（不含受阻停在原地）',
  onTime: '已送达且送达时刻 ≤ 任务时限的任务数',
  late: '已送达但送达时刻 > 任务时限的任务数',
  unfinished: '演练结束时仍未送达的任务数（受阻/在途）。这类任务**不参与**送达耗时统计',
  reroutes: '本组实际生效的改派次数（成功确认并替换派单的次数）；静态基线按定义恒为 0',
  affectedTasks: '曾经被封路打断、需要重新规划的任务数（两组都统计：Agent 途中被封闭路段截断即计入）',
  tasksWithoutFeasible: '被封路影响但当时没有任何可行候选的任务数（照实保留，不剔除）。静态基线不评估候选，因此恒为 0',
  unfinishedReason: '未完成任务的原因：blocked=受阻停在原地等待（静态基线常见）；in_transit=已改派但演练结束时仍在途；not_assigned=没有派单',
  deliverySecondsEndToEnd:
    '已送达任务的端到端送达耗时（演练秒，自演练开始 t=0 起算）。只对已送达任务求均值/中位数；未送达任务不计入、不按 0 处理',
  deliverySecondsAfterDispatch:
    '已送达任务自派单生效起的耗时（演练秒）：改派方案从确认时刻起算，原方案从 t=0 起算',
} as const

// ---------------------------------------------------------------------------
// 单组实验
// ---------------------------------------------------------------------------

export interface TaskOutcome {
  taskId: string
  code: string
  targetName: string
  deadlineLabel: string
  slaAt: number
  delivered: boolean
  deliveredAt: number | null
  onTime: boolean | null
  planId: string | null
  planOrigin: 'baseline' | 'reconfirmed' | null
  planVersion: number | null
  agentName: string | null
  confirmedAt: number | null
  deliverySecondsEndToEnd: number | null
  deliverySecondsAfterDispatch: number | null
  blockedRoadId: string | null
  roadsUsed: string[]
  crossedClosedRoads: string[]
  /** 演练结束时的方案阶段 */
  finalPhase: string | null
  /** 未完成任务的原因；已送达为 null */
  unfinishedReason: 'blocked' | 'in_transit' | 'not_assigned' | null
}

export interface PlanSetRecord {
  id: string
  at: number
  eventId: string
  snapshot: string
  rankingMode: string
  rankingNote?: string
  candidates: Array<{
    id: string
    taskId: string
    kind: string
    title: string
    feasible: boolean
    rank: number
    score: number
    slackS: number
    eta: number[]
    isRelay: boolean
    checks: Array<{ id: string; label: string; ok: boolean; detail: string }>
    reason: string[]
    dispatchReason: string
    roadIds: string[]
  }>
  confirmed: { candidateId: string; taskId: string; title: string; score: number; rank: number; at: number } | null
}

export interface RunMetrics {
  taskTotal: number
  delivered: number
  onTime: number
  late: number
  unfinished: number
  reroutes: number
  affectedTasks: number
  tasksWithoutFeasible: number
  deliveryCount: number
  deliveryMeanS: number | null
  deliveryMedianS: number | null
  deliveryAfterDispatchMeanS: number | null
}

export interface RunResult {
  seed: number
  strategy: Strategy
  step: number
  max: number
  ranToEnd: boolean
  finalClock: number
  closures: Array<{ roadId: string; roadName: string; at: number; depthM: number; thresholdM: number }>
  metrics: RunMetrics
  tasks: TaskOutcome[]
  planSets: PlanSetRecord[]
  confirmationAt: number[]
  /** 供复现性比较的指纹（不含随机 ID，只含决策与结果） */
  fingerprint: string
}

export interface RunOptions {
  seed: number
  strategy: Strategy
  step: number
  max: number
  ranker?: CandidateRanker
  disaster?: Engine['state']['disaster']
  onReward?(candidate: Engine['state']['planSets'][string]['candidates'][number], at: number, reward: number): void
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function round(n: number | null, digits = 1): number | null {
  if (n === null) return null
  const k = 10 ** digits
  return Math.round(n * k) / k
}

/** 距离演练开始（t=0）的秒数 */
function deliveryEndToEnd(plan: Plan | undefined): number | null {
  if (!plan || plan.deliveredAt === null) return null
  return plan.deliveredAt
}

/** 自派单生效起的秒数：改派方案从确认时刻算，原方案从 0 算 */
function deliveryAfterDispatch(plan: Plan | undefined): number | null {
  if (!plan || plan.deliveredAt === null) return null
  return plan.deliveredAt - (plan.confirmedAt ?? 0)
}

export async function runStrategy(opts: RunOptions): Promise<RunResult> {
  const ranker = opts.ranker ?? new RuleRanker()
  const community = buildDemoCommunity(opts.seed)
  const pharmacies = Object.values(demoInventory(community.pharmacies, opts.seed))
  const engine: Engine = createEngine({
    community: community.model,
    seed: opts.seed,
    pharmacies,
    provider: new SampleExternalProvider((id) => pharmacies.find((p) => p.id === id)?.name ?? id),
    ranker,
    startLabel: '08:00',
    durationS: opts.max,
    disaster: opts.disaster,
  })
  engine.state.clock.running = true

  /** 已处理过的 (候选集, 任务)，避免同一候选集对同一任务反复改派 */
  const handled = new Set<string>()
  const affectedTaskIds = new Set<string>()
  const noFeasibleTaskIds = new Set<string>()
  const confirmationsAt: number[] = []
  const attempts: Array<{ candidate: Engine['state']['planSets'][string]['candidates'][number]; at: number; planId: string }> = []

  const safetyCap = Math.ceil(opts.max / opts.step) + 10
  let iterations = 0
  while (engine.state.status === 'running' && iterations < safetyCap) {
    iterations++
    await advance(engine, opts.step)

    // 受影响任务：两组都统计 —— 只要 Agent 途中被封闭路段截断就计入
    for (const [taskId, planId] of Object.entries(engine.state.assignments)) {
      const plan = engine.state.plans[planId]
      if (plan?.phase === 'blocked') affectedTaskIds.add(taskId)
    }

    if (opts.strategy !== 'rules') continue

    // 规则调度：只处理受影响任务，且只接受通过规则校验的可行候选
    for (const ps of Object.values(engine.state.planSets)) {
      const taskIds = [...new Set(ps.candidates.map((c) => c.taskId))]
      for (const taskId of taskIds) {
        const key = `${ps.id}|${taskId}`
        if (handled.has(key)) continue
        handled.add(key)
        affectedTaskIds.add(taskId)
        // 复用排序接口的结果：rank 越小越优；只取 feasible
        const feasible = ps.candidates.filter((c) => c.taskId === taskId && c.feasible).sort((a, b) => a.rank - b.rank)
        if (!feasible.length) {
          noFeasibleTaskIds.add(taskId)
          continue
        }
        const chosen = feasible[0]
        const res = confirmCandidate(engine, ps.id, chosen.id, '无头实验')
        if (res.ok) {
          confirmationsAt.push(engine.state.clock.t)
          if (opts.onReward && res.planId) attempts.push({ candidate: chosen, at: ps.at, planId: res.planId })
        }
      }
    }
  }

  const s = engine.state
  for (const { candidate, at, planId } of attempts) {
    const result = s.record.results.find((entry) => entry.planId === planId && entry.status === 'delivered')
    // Credit only the dispatched version that actually completed the delivery.
    const reward = result ? (result.slaMet ? 1 : 0.25) - 0.2 * Math.min(1, (result.at - at) / 1800) : -1
    opts.onReward?.(candidate, at, reward)
  }
  const closedRoadIds = new Set(Object.keys(s.closures))

  const tasks: TaskOutcome[] = s.tasks.map((task: Task) => {
    const planId = s.assignments[task.id] ?? null
    const plan = planId ? s.plans[planId] : undefined
    const result = s.record.results.find((r) => r.taskId === task.id)
    const roads = plan ? planRoads(engine, plan) : []
    const delivered = plan?.phase === 'delivered' && Boolean(result)
    const unfinishedReason: TaskOutcome['unfinishedReason'] = delivered
      ? null
      : !plan
        ? 'not_assigned'
        : plan.phase === 'blocked'
          ? 'blocked'
          : 'in_transit'
    return {
      taskId: task.id,
      code: task.code,
      targetName: task.targetName,
      deadlineLabel: task.deadlineLabel,
      slaAt: task.slaAt,
      delivered,
      deliveredAt: plan?.deliveredAt ?? null,
      onTime: result ? result.slaMet : null,
      planId,
      planOrigin: plan?.origin ?? null,
      planVersion: plan?.version ?? null,
      agentName: plan?.agentName ?? null,
      confirmedAt: plan?.confirmedAt ?? null,
      deliverySecondsEndToEnd: deliveryEndToEnd(plan),
      deliverySecondsAfterDispatch: deliveryAfterDispatch(plan),
      blockedRoadId: plan?.blockedRoadId ?? null,
      roadsUsed: roads,
      crossedClosedRoads: roads.filter((r) => closedRoadIds.has(r)),
      finalPhase: plan?.phase ?? null,
      unfinishedReason,
    }
  })

  const deliveredTasks = tasks.filter((t) => t.delivered)
  const e2e = deliveredTasks.map((t) => t.deliverySecondsEndToEnd).filter((n): n is number => n !== null)
  const after = deliveredTasks.map((t) => t.deliverySecondsAfterDispatch).filter((n): n is number => n !== null)

  const planSets: PlanSetRecord[] = Object.values(s.planSets).map((ps) => {
    const confirmed = ps.confirmedCandidateId ? ps.candidates.find((c) => c.id === ps.confirmedCandidateId) : undefined
    return {
      id: ps.id,
      at: ps.at,
      eventId: ps.eventId,
      snapshot: ps.snapshot,
      rankingMode: ps.rankingMode,
      rankingNote: ps.rankingNote,
      candidates: ps.candidates.map((c) => ({
        id: c.id,
        taskId: c.taskId,
        kind: c.kind,
        title: c.title,
        feasible: c.feasible,
        rank: c.rank,
        score: c.score,
        slackS: c.slackS,
        eta: c.eta,
        isRelay: c.isRelay,
        checks: c.checks,
        reason: c.reason,
        dispatchReason: c.dispatchReason,
        roadIds: c.internal?.roadIds ?? [],
      })),
      confirmed: confirmed
        ? {
            candidateId: confirmed.id,
            taskId: confirmed.taskId,
            title: confirmed.title,
            score: confirmed.score,
            rank: confirmed.rank,
            at: ps.confirmedAt ?? 0,
          }
        : null,
    }
  })

  const metrics: RunMetrics = {
    taskTotal: tasks.length,
    delivered: deliveredTasks.length,
    onTime: deliveredTasks.filter((t) => t.onTime === true).length,
    late: deliveredTasks.filter((t) => t.onTime === false).length,
    unfinished: tasks.filter((t) => !t.delivered).length,
    reroutes: s.record.confirmations.length,
    affectedTasks: affectedTaskIds.size,
    tasksWithoutFeasible: noFeasibleTaskIds.size,
    deliveryCount: deliveredTasks.length,
    deliveryMeanS: round(mean(e2e)),
    deliveryMedianS: round(median(e2e)),
    deliveryAfterDispatchMeanS: round(mean(after)),
  }

  const closures = Object.values(s.closures)
    .sort((a, b) => a.at - b.at)
    .map((c) => ({ roadId: c.roadId, roadName: c.roadName, at: c.at, depthM: c.depthM, thresholdM: c.thresholdM }))

  // 指纹刻意不含随机对象 ID，只含「决策 + 结果」，用于跨进程比较同一策略是否可复现
  const fingerprint = JSON.stringify({
    closures: closures.map((c) => [c.roadName, c.at, Math.round(c.depthM * 1000)]),
    confirmations: s.record.confirmations.map((c) => [c.at, (c.candidateId ?? '').replace(/#.*/, ''), c.note]),
    tasks: tasks.map((t) => [t.code, t.delivered, t.deliveredAt, t.onTime, t.planOrigin, t.planVersion]),
    metrics,
  })

  return {
    seed: opts.seed,
    strategy: opts.strategy,
    step: opts.step,
    max: opts.max,
    ranToEnd: s.status === 'finished',
    finalClock: s.clock.t,
    closures,
    metrics,
    tasks,
    planSets,
    confirmationAt: confirmationsAt,
    fingerprint,
  }
}

// ---------------------------------------------------------------------------
// 校验：同灾情 / 静态无改派 / 规则不穿封闭路段 / 同种子可复现
// ---------------------------------------------------------------------------

export interface Assertions {
  sameDisaster: { ok: boolean; detail: string }
  staticNoReroute: { ok: boolean; detail: string }
  rulesAvoidClosedRoads: { ok: boolean; detail: string }
  reproducible: { ok: boolean; detail: string }
}

export interface SeedComparison {
  seed: number
  static: RunResult
  rules: RunResult
  delta: {
    onTime: number
    unfinished: number
    reroutes: number
    deliveryMeanS: number | null
  }
  assertions: Assertions
  /** 没有差异时的原因说明（照实报告，不挑数据） */
  note: string | null
}

function compareClosures(a: RunResult, b: RunResult): { ok: boolean; detail: string } {
  const fmt = (r: RunResult): string => r.closures.map((c) => `${c.roadName}@${c.at}s/${c.depthM.toFixed(2)}m`).join(' | ') || '（无封路）'
  const same = fmt(a) === fmt(b)
  return { ok: same, detail: same ? fmt(a) : `静态：${fmt(a)} ／ 规则：${fmt(b)}` }
}

export async function compareSeed(seed: number, step: number, max: number, repro: boolean): Promise<SeedComparison> {
  const staticRun = await runStrategy({ seed, strategy: 'static', step, max })
  const rulesRun = await runStrategy({ seed, strategy: 'rules', step, max })

  const sameDisaster = compareClosures(staticRun, rulesRun)

  const staticNoReroute = {
    ok: staticRun.metrics.reroutes === 0,
    detail: `静态基线确认次数 ${staticRun.metrics.reroutes}`,
  }

  const offenders = rulesRun.tasks.filter((t) => t.crossedClosedRoads.length > 0)
  const rulesAvoidClosedRoads = {
    ok: offenders.length === 0,
    detail: offenders.length
      ? offenders.map((t) => `${t.code} 经过封闭路段`).join('；')
      : `检查 ${rulesRun.tasks.length} 个任务的最终路线，均未经过任何封闭路段`,
  }

  let reproducible = { ok: true, detail: '未执行（--no-repro）' }
  if (repro) {
    const staticAgain = await runStrategy({ seed, strategy: 'static', step, max })
    const rulesAgain = await runStrategy({ seed, strategy: 'rules', step, max })
    const staticSame = staticAgain.fingerprint === staticRun.fingerprint
    const rulesSame = rulesAgain.fingerprint === rulesRun.fingerprint
    reproducible = {
      ok: staticSame && rulesSame,
      detail: `静态 ${staticSame ? '一致' : '不一致'}，规则 ${rulesSame ? '一致' : '不一致'}（同种子各跑两遍）`,
    }
  }

  const delta = {
    onTime: rulesRun.metrics.onTime - staticRun.metrics.onTime,
    unfinished: rulesRun.metrics.unfinished - staticRun.metrics.unfinished,
    reroutes: rulesRun.metrics.reroutes - staticRun.metrics.reroutes,
    deliveryMeanS:
      rulesRun.metrics.deliveryMeanS !== null && staticRun.metrics.deliveryMeanS !== null
        ? round(rulesRun.metrics.deliveryMeanS - staticRun.metrics.deliveryMeanS)
        : null,
  }

  let note: string | null = null
  if (!staticRun.closures.length) {
    note = '该种子没有触发任何封路事件，两种策略必然无差异'
  } else if (rulesRun.metrics.affectedTasks === 0) {
    note = '该种子发生了封路，但没有任务被波及，两种策略无差异'
  } else if (rulesRun.metrics.reroutes === 0) {
    note = `该种子有 ${rulesRun.metrics.affectedTasks} 个任务受影响，但当时没有任何可行候选（缺少可达路线/库存/运力/时限），因此两组结果相同`
  } else if (delta.onTime === 0 && delta.unfinished === 0) {
    // 如实区分两种“持平”：改派后仍在途（时长被截断），与改派后成绩互换
    const stillMoving = rulesRun.tasks.filter((x) => x.unfinishedReason === 'in_transit').length
    const staticBlocked = staticRun.tasks.filter((x) => x.unfinishedReason === 'blocked').length
    note =
      stillMoving > 0 && staticBlocked > 0
        ? `该种子改派 ${rulesRun.metrics.reroutes} 次：静态基线里有 ${staticBlocked} 个任务受阻停等，改派后这 ${stillMoving} 个任务已进入配送但在演练时长内仍未送达，因此两组的按时完成与未完成数相同（不是改派无效，而是时长截断）`
        : `该种子改派 ${rulesRun.metrics.reroutes} 次，但两组的按时完成与未完成数相同`
  }

  return {
    seed,
    static: staticRun,
    rules: rulesRun,
    delta,
    assertions: { sameDisaster, staticNoReroute, rulesAvoidClosedRoads, reproducible },
    note,
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function fmtClock(t: number | null): string {
  if (t === null) return '—'
  const m = Math.floor(t / 60)
  const s = Math.round(t % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function fmtMin(sec: number | null): string {
  return sec === null ? '—' : `${(sec / 60).toFixed(1)} 分`
}

function pad(s: string, width: number): string {
  // 中文字符按 2 个宽度估算，保证表格对齐
  let w = 0
  for (const ch of s) w += /[\u4e00-\u9fa5（）：、，；]/.test(ch) ? 2 : 1
  return s + ' '.repeat(Math.max(0, width - w))
}

function printRunTable(cmp: SeedComparison): void {
  const closureText = cmp.static.closures.length
    ? cmp.static.closures.map((c) => `${c.roadName} ${fmtClock(c.at)} 水深${c.depthM.toFixed(2)}m≥${c.thresholdM.toFixed(2)}m`).join('；')
    : '无封路'
  console.log(`\n种子 ${cmp.seed}　封路：${closureText}`)
  const rows: Array<[string, string, string, string]> = [
    ['任务总数', String(cmp.static.metrics.taskTotal), String(cmp.rules.metrics.taskTotal), '—'],
    ['按时完成', String(cmp.static.metrics.onTime), String(cmp.rules.metrics.onTime), signed(cmp.delta.onTime)],
    ['超时完成', String(cmp.static.metrics.late), String(cmp.rules.metrics.late), signed(cmp.rules.metrics.late - cmp.static.metrics.late)],
    ['未完成', String(cmp.static.metrics.unfinished), String(cmp.rules.metrics.unfinished), signed(cmp.delta.unfinished)],
    ['改派次数', String(cmp.static.metrics.reroutes), String(cmp.rules.metrics.reroutes), signed(cmp.delta.reroutes)],
    ['受影响任务', String(cmp.static.metrics.affectedTasks), String(cmp.rules.metrics.affectedTasks), '—'],
    ['无可行改派任务', String(cmp.static.metrics.tasksWithoutFeasible), String(cmp.rules.metrics.tasksWithoutFeasible), '—'],
    ['已送达数', String(cmp.static.metrics.deliveryCount), String(cmp.rules.metrics.deliveryCount), '—'],
    ['送达耗时均值(端到端)', fmtMin(cmp.static.metrics.deliveryMeanS), fmtMin(cmp.rules.metrics.deliveryMeanS), cmp.delta.deliveryMeanS === null ? '—' : `${(cmp.delta.deliveryMeanS / 60).toFixed(1)} 分`],
    ['送达耗时中位数', fmtMin(cmp.static.metrics.deliveryMedianS), fmtMin(cmp.rules.metrics.deliveryMedianS), '—'],
    ['派单后耗时均值', fmtMin(cmp.static.metrics.deliveryAfterDispatchMeanS), fmtMin(cmp.rules.metrics.deliveryAfterDispatchMeanS), '—'],
  ]
  console.log(`  ${pad('指标', 22)}${pad('静态基线', 14)}${pad('规则调度', 14)}差值`)
  console.log('  ' + '─'.repeat(62))
  for (const [k, a, b, d] of rows) console.log(`  ${pad(k, 22)}${pad(a, 14)}${pad(b, 14)}${d}`)
  if (cmp.note) console.log(`  说明：${cmp.note}`)
}

function signed(n: number): string {
  if (n === 0) return '0'
  return n > 0 ? `+${n}` : String(n)
}

function printTaskDetail(cmp: SeedComparison): void {
  console.log('  任务明细：')
  console.log(`    ${pad('任务', 16)}${pad('静态基线', 26)}${pad('规则调度', 26)}`)
  console.log('    ' + '─'.repeat(68))
  for (let i = 0; i < cmp.static.tasks.length; i++) {
    const a = cmp.static.tasks[i]
    const b = cmp.rules.tasks[i]
    const fmt = (t: typeof a): string => {
      if (!t.delivered) {
        if (t.unfinishedReason === 'blocked') return '未送达（受阻停等）'
        if (t.unfinishedReason === 'in_transit') return `未送达（在途，${t.finalPhase ?? '—'}）`
        return '未送达（无派单）'
      }
      return `送达 ${fmtClock(t.deliveredAt)}${t.onTime ? ' 按时' : ' 超时'}${t.planVersion && t.planVersion > 1 ? ` v${t.planVersion}` : ''}`
    }
    console.log(`    ${pad(a.code + ' ' + a.targetName, 16)}${pad(fmt(a), 26)}${pad(fmt(b), 26)}`)
  }
}

function printAssertions(all: SeedComparison[]): boolean {
  console.log('\n校验')
  let ok = true
  const show = (label: string, items: Array<{ seed: number; ok: boolean; detail: string }>): void => {
    // --no-repro 时复现自检没有执行，必须显示为“跳过”，不能显示成通过
    const skipped = items.filter((i) => i.detail.startsWith('未执行'))
    const real = items.filter((i) => !i.detail.startsWith('未执行'))
    if (skipped.length) {
      console.log(`  – ${label}（已跳过：${skipped[0].detail}）`)
    }
    if (!real.length) return
    const bad = real.filter((i) => !i.ok)
    if (bad.length) {
      ok = false
      console.log(`  ✗ ${label}`)
      for (const b of bad) console.log(`      种子 ${b.seed}：${b.detail}`)
    } else {
      console.log(`  ✓ ${label}（${real.map((i) => i.seed).join(', ')}）`)
    }
  }
  show('两种策略面对同一外生灾情（封路序列逐条相同）', all.map((c) => ({ seed: c.seed, ...c.assertions.sameDisaster })))
  show('静态基线没有改派', all.map((c) => ({ seed: c.seed, ...c.assertions.staticNoReroute })))
  show('规则调度的最终路线不经过已封闭路段', all.map((c) => ({ seed: c.seed, ...c.assertions.rulesAvoidClosedRoads })))
  show('同一种子重复运行结果一致', all.map((c) => ({ seed: c.seed, ...c.assertions.reproducible })))
  return ok
}

function printDefinitions(): void {
  console.log('指标口径')
  for (const [k, v] of Object.entries(METRIC_DEFINITIONS)) console.log(`  · ${k}：${v}`)
  console.log('  说明：未送达任务不计入送达耗时；表格里的“—”表示该组没有已送达任务，而不是 0。')
}

export function toJsonPayload(all: SeedComparison[], args: Args): unknown {
  return {
    experiment: {
      name: 'georelay-headless-compare',
      version: 1,
      seeds: args.seeds,
      step: args.step,
      maxSeconds: args.max,
      strategies: ['static', 'rules'],
      ranker: 'rules.default（CandidateRanker 接口的默认实现，可替换为 AI / RL 策略）',
      repro: args.repro,
      command: `npm run compare -- --seeds=${args.seeds.join(',')} --step=${args.step} --max=${args.max}${args.out ? ` --out=${args.out}` : ''}${args.json ? ' --json' : ''}`,
    },
    metricDefinitions: METRIC_DEFINITIONS,
    pairs: all.map((c) => ({
      seed: c.seed,
      delta: c.delta,
      assertions: c.assertions,
      note: c.note,
      runs: {
        static: stripRuns(c.static),
        rules: stripRuns(c.rules),
      },
    })),
  }
}

/** JSON 里保留「快照 → 候选 → 确认 → 结果」的链路 */
function stripRuns(r: RunResult): unknown {
  return {
    strategy: r.strategy,
    seed: r.seed,
    ranToEnd: r.ranToEnd,
    finalClock: r.finalClock,
    closures: r.closures,
    metrics: r.metrics,
    tasks: r.tasks,
    chain: r.planSets.map((ps) => ({
      planSetId: ps.id,
      at: ps.at,
      eventId: ps.eventId,
      stateSnapshot: ps.snapshot,
      rankingMode: ps.rankingMode,
      candidates: ps.candidates,
      confirmed: ps.confirmed,
      outcome: ps.confirmed
        ? r.tasks
            .filter((t) => t.taskId === ps.confirmed!.taskId)
            .map((t) => ({ code: t.code, delivered: t.delivered, deliveredAt: t.deliveredAt, onTime: t.onTime, planOrigin: t.planOrigin, planVersion: t.planVersion }))
        : [],
    })),
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/compare.ts')
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.json) {
    console.log('═'.repeat(72))
    console.log('GeoRelay 无头调度对照：静态基线 vs 规则调度')
    console.log(`种子 ${args.seeds.join(', ')} · 步长 ${args.step}s · 时长 ${args.max}s（${(args.max / 60).toFixed(0)} 分钟）· 复现自检 ${args.repro ? '开' : '关'}`)
    console.log('同一社区、同一种子、同一步长、同一外生灾情；只有“是否改派”不同。')
    printDefinitions()
  }

  const comparisons: SeedComparison[] = []
  for (const seed of args.seeds) {
    comparisons.push(await compareSeed(seed, args.step, args.max, args.repro))
  }

  if (args.json || args.out) {
    const payload = JSON.stringify(toJsonPayload(comparisons, args), null, 2) + '\n'
    if (args.out) {
      // 直接由 Node 写文件：避免 PowerShell 重定向写成 UTF-16/带 BOM 导致下游 JSON 解析失败
      const { writeFileSync, mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')
      mkdirSync(dirname(args.out), { recursive: true })
      writeFileSync(args.out, payload, 'utf8')
      if (!args.json) console.log(`\nJSON 已写入 ${args.out}`)
    }
    if (args.json) process.stdout.write(payload)
  } else {
    for (const cmp of comparisons) {
      printRunTable(cmp)
      printTaskDetail(cmp)
    }
    const ok = printAssertions(comparisons)
    console.log('\n汇总（规则调度 − 静态基线）')
    console.log(`  ${pad('种子', 8)}${pad('按时完成', 14)}${pad('未完成', 12)}${pad('改派', 10)}送达耗时均值`)
    for (const c of comparisons) {
      console.log(
        `  ${pad(String(c.seed), 8)}${pad(signed(c.delta.onTime), 14)}${pad(signed(c.delta.unfinished), 12)}${pad(signed(c.delta.reroutes), 10)}${
          c.delta.deliveryMeanS === null ? '—' : `${(c.delta.deliveryMeanS / 60).toFixed(1)} 分`
        }`,
      )
    }
    console.log(`\n结论：${ok ? '全部校验通过' : '存在校验失败项，见上方 ✗'}`)
    console.log('限制：单社区、单灾种（内涝）、规则规划器与规则排序；改派由脚本模拟确认，不代表人工决策质量；样本量小，结论只用于建立评估基线。')
  }
  process.exitCode = comparisons.every((c) => Object.values(c.assertions).every((a) => a.ok)) ? 0 : 1
}
