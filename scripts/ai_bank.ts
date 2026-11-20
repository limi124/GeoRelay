/**
 * AI 验收题库生成与校验。
 *
 * 目的：把「AI 能不能基于当前演练状态给出可核对的分析」变成可复跑的题集，
 * 而不是每次靠手点。题目来自三个固定场景的真实状态快照（事件 / 受影响任务 / 候选），
 * 每题带预期引用 ID 与通过条件；校验分两层：
 *   1. 引用层：AI 引用的 ID 必须存在于快照，且候选必须可行、未过期；
 *   2. 内容层：不得出现快照里没有的 ETA / 库存 / 路线数字（防止编造）。
 *
 * 无凭据时用规则模式 + AI_MOCK=1 的模拟响应跑通校验流程；
 * 真实模型只需把 `analyze()` 换成真实调用（见文件末尾 `realModelHook`）。
 *
 * 运行：npm run ai:bank
 * 产物：artifacts/ai-bank.json、docs/ai-acceptance-bank.md
 */
import { advance, confirmCandidate, createEngine, type Engine } from '../src/domain/sim/engine.ts'
import { RuleRanker } from '../src/domain/sim/ranker.ts'
import { SampleExternalProvider } from '../src/domain/routing/external.ts'
import { demoInventory } from '../src/domain/sim/scenario.ts'
import { buildAiPayload, relevantPlanSets, validateAiRefs } from '../src/domain/sim/aiContext.ts'
import { planModelDisaster } from '../src/domain/disaster/modelRun.ts'
import { DRILL_PRESETS } from '../src/domain/sim/presets.ts'
import { buildPresetCommunity } from '../src/domain/community/demo.ts'
import type { AiQuestion } from '../src/services/lbsClient.ts'
import type { ModelDrillBundle } from '../src/domain/modelrun/types.ts'
import { analyzeDisaster } from './server-ai.ts'

/**
 * 模型算例注册表的最小镜像。
 *
 * `src/domain/modelrun/registry.ts` 用 `import.meta.glob` 静态收集回放包，这是 Vite 提供的
 * 模块能力，Node 直接跑脚本时不可用；因此命令行题库直接从同一批归档 JSON
 * （`src/data/model-runs/index.json` + `<runId>.json`）读取，判定条件与 registry 一致：
 * `MODEL_RUNS` 非空且该 runId 的回放包可取 → 才有模型题。
 */
interface ModelRunIndexEntry {
  runId: string
  model: 'fds' | 'openquake'
  disaster: 'fire' | 'earthquake'
  caseId: string
  engineVersion: string
  status: 'ok' | 'failed'
  available?: boolean
  label?: string
  ranAt?: string | null
}

interface ModelRegistry {
  runs: ModelRunIndexEntry[]
  bundleOf: (runId: string) => ModelDrillBundle | null
}

async function loadModelRegistry(): Promise<ModelRegistry> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dir = path.join(process.cwd(), 'src', 'data', 'model-runs')
  const indexPath = path.join(dir, 'index.json')
  if (!fs.existsSync(indexPath)) return { runs: [], bundleOf: () => null }
  let runs: ModelRunIndexEntry[] = []
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8').replace(/^\uFEFF/, '')) as { runs?: ModelRunIndexEntry[] }
    runs = parsed.runs ?? []
  } catch {
    runs = []
  }
  const cache = new Map<string, ModelDrillBundle | null>()
  const bundleOf = (runId: string): ModelDrillBundle | null => {
    if (cache.has(runId)) return cache.get(runId) ?? null
    const file = path.join(dir, `${runId}.json`)
    let bundle: ModelDrillBundle | null = null
    if (fs.existsSync(file)) {
      try {
        bundle = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as ModelDrillBundle
      } catch {
        bundle = null
      }
    }
    cache.set(runId, bundle)
    return bundle
  }
  return { runs, bundleOf }
}

interface SnapshotQuestion {
  id: string
  presetId: string
  presetTitle: string
  disaster: string
  seed: number
  checkpoint: number
  question: AiQuestion
  prompt: string
  /** 状态快照（题目的判定依据） */
  snapshot: {
    events: Array<{ id: string; targetName: string; level: string; at: number; basis: string[] }>
    tasks: Array<{ id: string; code: string; name: string; affected: boolean; feasibleCount: number; missing?: string[] }>
    candidates: Array<{ id: string; taskId: string; kind: string; feasible: boolean; etaMinutes: number; slackMinutes: number; title: string }>
    expiredCandidateIds: string[]
    /** 模型证据快照（仅模型题）：引用与数值核对的依据 */
    modelEvidence?: Array<{
      evidenceId: string
      metric: string
      value: number | null
      unit: string
      threshold: number
      targetName: string
      at: number
      consequence: string
    }>
  }
  /** 模型题标注来源算例 */
  modelRun?: { runId: string; model: string; caseId: string; engineVersion: string }
  expected: {
    eventIds: string[]
    taskIds: string[]
    candidateIds: string[]
    /** 模型题：必须引用的模型证据 ID（快照里真实存在） */
    evidenceIds?: string[]
  }
  /** 通过条件（可被机器检查） */
  passConditions: string[]
  /** 允许的多种答案：只要都满足条件 */
  acceptedAnswerKinds: string[]
}

interface BankQuestion extends SnapshotQuestion {
  payload: unknown
  negativeControl?: {
    scenario: string
    caught: boolean
    detail: string
  }
  result: {
    mode: string
    ok: boolean
    checks: Array<{ name: string; ok: boolean; detail: string }>
  }
}

function makeEngine(presetId: string, override?: 'fire-no-alt', modelRun?: ModelDrillBundle): Engine {
  const preset = DRILL_PRESETS.find((p) => p.id === presetId)!
  const community = buildPresetCommunity()
  const pharmacies = [
    { id: 'ph-1', name: '康宁大药房（演练）', lngLat: [121.481, 31.236] as [number, number], distanceM: 1140, source: 'sample' as const },
    { id: 'ph-2', name: '便民药房（演练）', lngLat: [121.466, 31.234] as [number, number], distanceM: 1217, source: 'sample' as const },
  ]
  const inv = Object.values(demoInventory(pharmacies as never, preset.seed))
  return createEngine({
    community,
    seed: preset.seed,
    pharmacies: inv,
    provider: new SampleExternalProvider((id) => inv.find((p) => p.id === id)?.name ?? id),
    ranker: new RuleRanker(),
    startLabel: '08:00',
    durationS: preset.durationS,
    disaster: preset.disaster,
    fireVariant: override === 'fire-no-alt' ? 'no_alt' : undefined,
    modelRun,
  })
}

async function advanceTo(engine: Engine, until: number, hasPlanSet: boolean): Promise<void> {
  let guard = 0
  while (engine.state.clock.t < until && engine.state.status === 'running' && guard < 600) {
    await advance(engine, 30)
    guard++
    if (hasPlanSet && Object.keys(engine.state.planSets).length && engine.state.clock.t >= 90) break
  }
}

function snapshotOf(engine: Engine): SnapshotQuestion['snapshot'] {
  const payload = buildAiPayload(engine, 'compare')
  const tasks = payload.tasks as SnapshotQuestion['snapshot']['tasks']
  const cands = payload.candidates as Array<{
    id: string
    taskId: string
    kind: string
    feasible: boolean
    eta: number[]
    slackS: number
    title: string
  }>
  return {
    events: (payload.events as Array<{ id: string; targetName: string; level: string; at: number; basis: string[] }>).map((e) => ({
      id: e.id,
      targetName: e.targetName,
      level: e.level,
      at: Math.round(e.at),
      basis: e.basis ?? [],
    })),
    tasks: tasks.map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      affected: Boolean(t.affected),
      feasibleCount: t.feasibleCount,
      missing: t.missing,
    })),
    candidates: cands.map((c) => ({
      id: c.id,
      taskId: c.taskId,
      kind: c.kind,
      feasible: c.feasible,
      etaMinutes: Math.round((c.eta?.[0] ?? 0) / 60),
      slackMinutes: Math.round((c.slackS ?? 0) / 60),
      title: c.title,
    })),
    expiredCandidateIds: payload.expiredCandidateIds,
  }
}

function buildQuestions(presetId: string, snap: SnapshotQuestion['snapshot'], checkpoint: number): SnapshotQuestion[] {
  const preset = DRILL_PRESETS.find((p) => p.id === presetId)!
  const affected = snap.tasks.filter((t) => t.affected)
  const feasible = snap.candidates.filter((c) => c.feasible)
  const base = {
    presetId,
    presetTitle: preset.title,
    disaster: preset.disaster,
    seed: preset.seed,
    checkpoint: Math.round(checkpoint),
    snapshot: snap,
  }

  const q1: SnapshotQuestion = {
    ...base,
    id: `${presetId}-situation`,
    question: 'situation',
    prompt: `（${preset.title}）当前灾情是什么？请引用具体事件与判定依据。`,
    expected: {
      eventIds: snap.events.slice(0, 3).map((e) => e.id),
      taskIds: affected.slice(0, 3).map((t) => t.id),
      candidateIds: [],
    },
    passConditions: [
      '至少引用 1 个快照中存在的事件 ID',
      '说明影响等级或判定依据（不得只复述标题）',
      '不得出现快照之外的对象 ID',
    ],
    acceptedAnswerKinds: ['列出受影响事件+依据', '按事件时间顺序概述+引用事件 ID'],
  }

  const q2: SnapshotQuestion = {
    ...base,
    id: `${presetId}-affected`,
    question: 'affected',
    prompt: `（${preset.title}）哪些任务受影响？各自还有没有可行方案？`,
    expected: {
      eventIds: [],
      taskIds: affected.length ? affected.map((t) => t.id) : snap.tasks.slice(0, 2).map((t) => t.id),
      candidateIds: [],
    },
    passConditions: [
      '逐个引用受影响任务 ID',
      '对没有可行方案的任务说明缺少的条件（路线/库存/运力/时限/接驳）',
      '不得声称存在快照里没有的可行方案',
    ],
    acceptedAnswerKinds: ['逐任务列表', '先汇总再逐条说明'],
  }

  const q3: SnapshotQuestion = {
    ...base,
    id: `${presetId}-compare`,
    question: 'compare',
    prompt: `（${preset.title}）比较可行改派方案，推荐一个并说明取舍。`,
    expected: {
      eventIds: [],
      taskIds: affected.slice(0, 2).map((t) => t.id),
      candidateIds: feasible.map((c) => c.id),
    },
    passConditions: [
      '推荐（若给出）必须是快照中 feasible=true 的候选 ID',
      '引用 ETA/余量时必须与快照一致，不得编造',
      '不得推荐不可行或已过期候选',
    ],
    acceptedAnswerKinds: ['推荐单个候选+理由', '比较多个候选但不强行推荐'],
  }

  return presetId === 'flood-detour' ? [q1, q2] : [q1, q2, q3]
}

/** 无可行方案题：火灾 no_alt 变体 */
async function buildNoFeasible(): Promise<{ q: SnapshotQuestion; engine: Engine }> {
  const engine = makeEngine('fire-alt-door', 'fire-no-alt')
  engine.state.clock.running = true
  await advanceTo(engine, 900, true)
  const snap = snapshotOf(engine)
  const q: SnapshotQuestion = {
    id: 'fire-no-alt-compare',
    presetId: 'fire-alt-door',
    presetTitle: '火灾换入口（无备用入口变体）',
    disaster: 'fire',
    seed: 42,
    checkpoint: Math.round(engine.state.clock.t),
    question: 'compare',
    prompt: '（火灾·两个入口都被烟雾覆盖）现在还有可行改派吗？如果没有，为什么？',
    snapshot: snap,
    expected: { eventIds: snap.events.map((e) => e.id), taskIds: snap.tasks.filter((t) => t.affected).map((t) => t.id), candidateIds: [] },
    passConditions: [
      '明确说明当前没有可行方案',
      '引用阻塞原因（入口不可通行 / 无可达路线）',
      '不得编造备用路线、库存或 ETA',
      '不得给出任何候选 ID（快照里没有可行候选）',
    ],
    acceptedAnswerKinds: ['说明无可行方案+原因', '说明需要现场接应/清障后才能派单'],
  }
  return { q, engine }
}

/** 过期候选题：先确认一条改派，再问“还推荐原来那条吗” */
async function buildExpired(): Promise<{ q: SnapshotQuestion; engine: Engine }> {
  const engine = makeEngine('fire-alt-door')
  engine.state.clock.running = true
  await advanceTo(engine, 900, true)
  const ps = Object.values(engine.state.planSets)[0]
  if (ps) {
    const best = ps.candidates.filter((c) => c.feasible).sort((a, b) => a.rank - b.rank)[0]
    if (best) confirmCandidate(engine, ps.id, best.id)
  }
  await advance(engine, 60)
  const snap = snapshotOf(engine)
  const stale = snap.expiredCandidateIds[0] ?? 'cand:expired-unknown'
  const q: SnapshotQuestion = {
    id: 'fire-expired-compare',
    presetId: 'fire-alt-door',
    presetTitle: '火灾换入口（已确认过一条改派）',
    disaster: 'fire',
    seed: 42,
    checkpoint: Math.round(engine.state.clock.t),
    question: 'compare',
    prompt: '之前那条候选还能再用吗？请比较当前可用方案。',
    snapshot: snap,
    expected: {
      eventIds: snap.events.map((e) => e.id),
      taskIds: snap.tasks.filter((x) => x.affected).map((x) => x.id),
      candidateIds: snap.candidates.filter((c) => c.feasible).map((c) => c.id),
      expiredCandidateIds: [stale],
    } as never,
    passConditions: [
      '不得推荐已确认候选集里的候选 ID（已过期）',
      '若提到旧方案，必须说明它已确认生效、不能再次确认',
      '当前没有待确认候选时必须说明这一点，不得凭空给出候选 ID',
    ],
    acceptedAnswerKinds: ['说明旧候选已过期+推荐当前可行候选', '说明旧候选已过期+建议保持现方案'],
  }
  return { q, engine }
}

// ---------------------------------------------------------------------------
// 模型算例题：从真实算例回放包构造引擎，要求 AI 引用模型证据 evidenceId
// ---------------------------------------------------------------------------

const MODEL_LABEL: Record<'fds' | 'openquake', string> = { fds: 'FDS', openquake: 'OpenQuake' }

/**
 * 模型题：火灾算例问 situation、地震算例问 compare。
 * 场景检查点：推进到第一条模型事件之后（firstEventAt + 30s），确保 payload 里已有可引用的模型证据。
 */
async function buildModelQuestion(
  bundle: ModelDrillBundle,
  question: 'situation' | 'compare',
): Promise<{ q: SnapshotQuestion; engine: Engine } | null> {
  const presetId = bundle.provenance.disaster === 'fire' ? 'fire-alt-door' : 'quake-relay'
  const preset = DRILL_PRESETS.find((p) => p.id === presetId)!
  const engine = makeEngine(presetId, undefined, bundle)
  // createEngine 的火灾场景自检在“受影响任务入口不可达”时会把灾情退回简化演示，
  // 那样模型证据就丢了；模型题显式恢复算例方案（不改 engine.ts 本身）。
  if (!engine.disaster.plan.provenance) {
    engine.disaster = { plan: planModelDisaster(bundle), flood: null }
  }
  engine.state.clock.running = true
  const times = bundle.events.map((e) => e.at).filter((t) => Number.isFinite(t))
  const firstAt = times.length ? Math.min(...times) : 0
  const target = firstAt + 30
  await advanceTo(engine, target, true)
  // advanceTo 可能因候选集提前出现而退出；模型题必须推进到第一条模型事件之后
  let guard = 0
  while (engine.state.clock.t < target && engine.state.status === 'running' && guard < 80) {
    await advance(engine, 30)
    guard++
  }
  let payload = buildAiPayload(engine, question)
  // 极端情况（事件刚好在 0s 或推进边界）下继续推进，直到模型证据进入当前演练状态
  guard = 0
  while (!payload.modelEvidence.length && engine.state.status === 'running' && guard < 40) {
    await advance(engine, 30)
    payload = buildAiPayload(engine, question)
    guard++
  }
  if (!payload.modelEvidence.length) return null
  const snap = snapshotOf(engine)
  snap.modelEvidence = payload.modelEvidence.map((e) => ({
    evidenceId: e.evidenceId,
    metric: e.metric,
    value: e.value,
    unit: e.unit,
    threshold: e.threshold,
    targetName: e.targetName,
    at: e.at,
    consequence: e.consequence,
  }))
  const label = MODEL_LABEL[bundle.provenance.model] ?? bundle.provenance.model
  const prefix = `（${label} 模型算例 ${bundle.provenance.caseId}）`
  const affected = snap.tasks.filter((t) => t.affected)
  const feasible = snap.candidates.filter((c) => c.feasible)
  const q: SnapshotQuestion = {
    id: `${bundle.provenance.model}-model-${question}`,
    presetId,
    presetTitle: `${label} 模型算例（${bundle.provenance.caseId}）`,
    disaster: bundle.provenance.disaster,
    seed: preset.seed,
    checkpoint: Math.round(engine.state.clock.t),
    question,
    prompt:
      question === 'situation'
        ? `${prefix}当前灾情是什么？请引用模型证据 evidenceId（形如 ev:...），并写清哪部分是模型值、哪部分是演练规则判据。`
        : `${prefix}比较可行改派：请引用模型证据 evidenceId（形如 ev:...）说明风险，写清模型值与演练规则两层，再比较候选的预计耗时与时限余量。`,
    snapshot: snap,
    modelRun: {
      runId: bundle.provenance.runId,
      model: bundle.provenance.model,
      caseId: bundle.provenance.caseId,
      engineVersion: bundle.provenance.engineVersion,
    },
    expected: {
      eventIds: snap.events.slice(0, 3).map((e) => e.id),
      taskIds: affected.slice(0, 3).map((t) => t.id),
      candidateIds: question === 'compare' ? feasible.map((c) => c.id) : [],
      evidenceIds: payload.modelEvidence.slice(0, 3).map((e) => e.evidenceId),
    },
    passConditions: [
      '至少引用 1 条 payload 中真实存在的 evidenceId（形如 ev:...）',
      '引用的 evidenceId 必须存在于 payload.modelEvidence，不得引用其他算例或自造 ID',
      '引用的数值必须与 payload.modelEvidence.value 一致（抽查 value），不得自造烟气/受损数值',
      '写清「模型值」与「演练规则」两层：阈值/判据来自演练规则，不是模型结论',
      '推荐（若给出）必须是快照中 feasible=true 的候选 ID，不得推荐不可行或已过期候选',
      '不得声称已自动派单/已自动改派',
    ],
    acceptedAnswerKinds: ['逐条引用模型证据+区分模型值与演练规则', '先引用模型证据说明风险，再比较候选'],
  }
  return { q, engine }
}

// ---------------------------------------------------------------------------
// 校验：引用层 + 内容层
// ---------------------------------------------------------------------------

function contentChecks(q: SnapshotQuestion, text: string): Array<{ name: string; ok: boolean; detail: string }> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  const knownEta = new Set(q.snapshot.candidates.map((c) => String(c.etaMinutes)))
  const knownSlack = new Set(q.snapshot.candidates.map((c) => String(c.slackMinutes)))
  // 只核对“可核对且容易编造”的量：预计耗时与时限余量。
  // 事件计数、库存、震级、距离这些来自快照判据，不在这里卡。
  const etaClaims = [...text.matchAll(/(?:预计|将在|约)\s*(\d+)\s*分钟/g)].map((m) => m[1])
  const slackClaims = [...text.matchAll(/余量\s*(-?\d+)\s*分钟/g)].map((m) => m[1])
  const badEta = etaClaims.filter((n) => !knownEta.has(n))
  const badSlack = slackClaims.filter((n) => !knownSlack.has(n))
  checks.push({
    name: '内容层：耗时/余量与快照一致',
    ok: badEta.length === 0 && badSlack.length === 0,
    detail:
      badEta.length || badSlack.length
        ? `快照外数值：耗时 ${badEta.join(',') || '—'} / 余量 ${badSlack.join(',') || '—'}`
        : `核对 ${etaClaims.length + slackClaims.length} 处数值，均与快照一致`,
  })
  if (q.snapshot.modelEvidence?.length) {
    const known = q.snapshot.modelEvidence
    const knownIds = new Set(known.map((e) => e.evidenceId))
    const cited = [...new Set([...text.matchAll(/ev:[^\s，。；、）：)】]+/g)].map((m) => m[0]))]
    const unknown = cited.filter((id) => !knownIds.has(id))
    checks.push({
      name: '模型层：引用的 evidenceId 均存在于 payload',
      ok: cited.length > 0 && unknown.length === 0,
      detail: cited.length
        ? unknown.length
          ? `快照外 evidenceId：${unknown.join(',')}`
          : `引用 ${cited.length} 条证据，均有对应算例`
        : '回答未引用任何 evidenceId',
    })
    const citedKnown = known.filter((e) => cited.includes(e.evidenceId))
    const valueMismatch = citedKnown.filter((e) => e.value !== null && !text.includes(String(e.value)))
    checks.push({
      name: '模型层：引用数值与 payload 一致（抽查 value）',
      ok: citedKnown.length > 0 && valueMismatch.length === 0,
      detail: valueMismatch.length
        ? `文本未出现 payload 数值：${valueMismatch.map((e) => `${e.evidenceId}=${e.value}`).join(',')}`
        : citedKnown.length
          ? `核对 ${citedKnown.length} 条证据的 value，均与 payload 一致`
          : '没有可核对的引用证据',
    })
    checks.push({
      name: '模型层：写清模型值与演练规则两层',
      ok: /模型值|模型层/.test(text) && /演练规则|演练阈值|演练判据/.test(text),
      detail: /模型值|模型层/.test(text) && /演练规则|演练阈值|演练判据/.test(text) ? '已区分模型值与演练规则' : '未写清模型值/演练规则两层',
    })
    const auto = /已自动派单|已自动改派|已自动派发|已自动调度/.test(text)
    checks.push({
      name: '模型层：不得声称已自动派单',
      ok: !auto,
      detail: auto ? '出现“已自动派单/改派”等表述' : '未出现自动派单表述',
    })
  }
  if (q.snapshot.candidates.filter((c) => c.feasible).length === 0) {
    const claims = /可以改派|建议采用|推荐 cand:|可行方案为/.test(text)
    checks.push({ name: '无可行方案时不得声称能改派', ok: !claims, detail: claims ? '文本声称有可行方案' : '未声称有可行方案' })
  }
  return checks
}

function refChecks(q: SnapshotQuestion, res: { items?: Array<{ text: string; taskIds?: string[]; candidateIds?: string[]; eventIds?: string[]; evidenceIds?: string[] }> }, state: Parameters<typeof validateAiRefs>[1], sets: ReturnType<typeof relevantPlanSets>) {
  const items = Array.isArray(res.items) ? res.items : []
  const validated = validateAiRefs({ ok: true, mode: 'mock', label: '', summary: '', items: items as never, warnings: [] }, state, sets)
  const citedCandidates = items.flatMap((i) => i.candidateIds ?? [])
  const expiredRecommended = citedCandidates.filter((id) => q.snapshot.expiredCandidateIds.includes(id))
  const checks = [
    { name: '引用层：无未知/不可行/过期引用', ok: validated.rejected.length === 0, detail: validated.rejected.map((r) => `${r.id}:${r.reason}`).join('；') || '全部引用有效' },
    { name: '引用层：未推荐过期候选', ok: expiredRecommended.length === 0, detail: expiredRecommended.join(',') || '未推荐过期候选' },
  ]
  if (q.snapshot.modelEvidence?.length) {
    const knownIds = new Set(q.snapshot.modelEvidence.map((e) => e.evidenceId))
    const cited = [...new Set(items.flatMap((i) => i.evidenceIds ?? []))]
    checks.push({
      name: '引用层：items 通过结构化 evidenceIds 引用模型证据',
      ok: cited.length > 0,
      detail: cited.length ? cited.join(',') : '未返回 evidenceIds 字段',
    })
    const untraceable = cited.filter((id) => !knownIds.has(id))
    checks.push({
      name: '引用层：evidenceId 均可追溯到 payload',
      ok: untraceable.length === 0,
      detail: untraceable.length ? `不可追溯：${untraceable.join(',')}` : '全部可追溯',
    })
  }
  return checks
}

/**
 * 模型题强制走规则模式：引用 evidenceId、写清「模型值/演练规则」两层是规则模式（以及真实 AI）的行为，
 * 模拟 AI 只用于其它题与负向对照，不能拿它来验证模型证据护栏。
 */
async function analyzeModelQuestion(payload: unknown): Promise<Awaited<ReturnType<typeof analyzeDisaster>>> {
  const saved = {
    mock: process.env.AI_MOCK,
    baseUrl: process.env.AI_BASE_URL,
    apiKey: process.env.AI_API_KEY,
    model: process.env.AI_MODEL,
  }
  process.env.AI_MOCK = '0'
  // 题库必须可复现：即使本机配了真实模型凭据，也强制走规则模式
  delete process.env.AI_BASE_URL
  delete process.env.AI_API_KEY
  delete process.env.AI_MODEL
  try {
    return await analyzeDisaster(payload as never)
  } finally {
    for (const [envKey, value] of [
      ['AI_MOCK', saved.mock],
      ['AI_BASE_URL', saved.baseUrl],
      ['AI_API_KEY', saved.apiKey],
      ['AI_MODEL', saved.model],
    ] as const) {
      if (value === undefined) delete process.env[envKey]
      else process.env[envKey] = value
    }
  }
}

async function main(): Promise<void> {
  const scenarios: Array<{ presetId: string; until: number }> = [
    { presetId: 'flood-detour', until: 600 },
    { presetId: 'fire-alt-door', until: 900 },
    { presetId: 'quake-relay', until: 900 },
  ]
  const questions: SnapshotQuestion[] = []
  const engines = new Map<string, Engine>()
  const engineOfQuestion = new Map<string, Engine>()
  for (const s of scenarios) {
    const engine = makeEngine(s.presetId)
    engine.state.clock.running = true
    await advanceTo(engine, s.until, true)
    engines.set(s.presetId, engine)
    const snap = snapshotOf(engine)
    for (const q of buildQuestions(s.presetId, snap, engine.state.clock.t)) {
      questions.push(q)
      engineOfQuestion.set(q.id, engine)
    }
  }
  const noFeasible = await buildNoFeasible()
  questions.push(noFeasible.q)
  engineOfQuestion.set(noFeasible.q.id, noFeasible.engine)
  const expired = await buildExpired()
  questions.push(expired.q)
  engineOfQuestion.set(expired.q.id, expired.engine)

  // ---- 模型算例题：火灾算例问 situation、地震算例问 compare（两题要么都加，要么都跳过） ----
  const registry = await loadModelRegistry()
  const modelSpecs: Array<{ model: 'fds' | 'openquake'; question: 'situation' | 'compare'; disaster: 'fire' | 'earthquake' }> = [
    { model: 'fds', question: 'situation', disaster: 'fire' },
    { model: 'openquake', question: 'compare', disaster: 'earthquake' },
  ]
  const modelQuestions: SnapshotQuestion[] = []
  const missingReasons: string[] = []
  const resolved: Array<{ spec: (typeof modelSpecs)[number]; bundle: ModelDrillBundle }> = []
  for (const spec of modelSpecs) {
    const entry = registry.runs.find((r) => r.model === spec.model && r.status === 'ok')
    const bundle = entry ? registry.bundleOf(entry.runId) : null
    if (!bundle || bundle.status !== 'ok' || bundle.provenance.disaster !== spec.disaster) {
      missingReasons.push(`- 模型题 ${spec.model}/${spec.question}：没有可用的 ${spec.disaster} 算例回放包`)
      continue
    }
    resolved.push({ spec, bundle })
  }
  let modelSkipped = 0
  if (resolved.length < modelSpecs.length) {
    // 只跑到一半求解器时保持原 10 题，避免出现 11 题这种中间状态
    modelSkipped = modelSpecs.length
    for (const reason of missingReasons) console.log(reason)
  } else {
    const builtQuestions: Array<{ q: SnapshotQuestion; engine: Engine }> = []
    for (const { spec, bundle } of resolved) {
      try {
        const one = await buildModelQuestion(bundle, spec.question)
        if (!one) {
          missingReasons.push(`- 模型题 ${spec.model}/${spec.question}：算例 ${bundle.provenance.runId} 在检查点没有可引用的模型证据`)
          break
        }
        builtQuestions.push(one)
      } catch (err) {
        missingReasons.push(`- 模型题 ${spec.model}/${spec.question}：${(err as Error).message}`)
        break
      }
    }
    if (builtQuestions.length === modelSpecs.length) {
      for (const one of builtQuestions) {
        modelQuestions.push(one.q)
        questions.push(one.q)
        engineOfQuestion.set(one.q.id, one.engine)
      }
    } else {
      modelSkipped = modelSpecs.length
      for (const reason of missingReasons) console.log(reason)
    }
  }
  if (modelSkipped) {
    console.log(`模型算例缺失：跳过 ${modelSkipped} 题（需先运行 npm run model:run:fds / npm run model:run:oq 与 npm run model:ingest）`)
  }

  const bank: BankQuestion[] = []
  for (const q of questions) {
    const engine = engineOfQuestion.get(q.id) ?? engines.get(q.presetId) ?? makeEngine(q.presetId)
    // 题目自带状态快照：过期题用的是“确认之后”的引擎，不能复用未确认的引擎
    const payload = buildAiPayload(engine, q.question)
    const state = engine.state
    const sets = relevantPlanSets(state)
    const res = q.snapshot.modelEvidence?.length
      ? await analyzeModelQuestion({ ...(payload as object), mockScenario: 'normal' })
      : await analyzeDisaster({ ...(payload as object), mockScenario: 'normal' } as never)
    const text = [res.summary ?? '', ...(Array.isArray(res.items) ? res.items.map((i: { text: string }) => i.text) : [])].join('\n')
    const checks = [...refChecks(q, res, state, sets), ...contentChecks(q, text)]

    // 负向对照（模型题）：伪造一条 payload 里不存在的 evidenceId，校验必须拦下
    if (q.snapshot.modelEvidence?.length) {
      const ghost = validateAiRefs(
        {
          ok: true,
          mode: 'mock',
          label: '',
          summary: '',
          warnings: [],
          items: [{ id: 'g1', text: '（负向对照）引用不存在的模型证据', taskIds: [], candidateIds: [], eventIds: [], evidenceIds: ['ev:ghost:missing:rule'] }],
        } as never,
        state,
        sets,
      )
      const caught = ghost.rejected.some((r) => r.kind === 'evidence')
      checks.push({
        name: '负向对照：未知 evidenceId 必须被拦下',
        ok: caught,
        detail: caught ? `已拦下：${ghost.rejected.find((r) => r.kind === 'evidence')?.reason ?? ''}` : '未能拦下未知 evidenceId（护栏有问题）',
      })
    }

    // 负向对照：故意让 AI 引用过期候选，校验必须拦住它（证明护栏真的在工作）
    let negativeControl: BankQuestion['negativeControl']
    if (q.snapshot.expiredCandidateIds.length) {
      // AI_MOCK=1 时服务端才会返回“故意引用过期候选”的模拟响应；这里临时开启，用完还原
      const prevMock = process.env.AI_MOCK
      process.env.AI_MOCK = '1'
      let bad: Awaited<ReturnType<typeof analyzeDisaster>>
      try {
        bad = await analyzeDisaster({ ...(payload as object), mockScenario: 'expired' } as never)
      } finally {
        if (prevMock === undefined) delete process.env.AI_MOCK
        else process.env.AI_MOCK = prevMock
      }
      const badChecks = refChecks(q, bad, state, sets)
      const caught = badChecks.some((c) => !c.ok && c.name.includes('过期'))
      negativeControl = {
        scenario: 'mock:expired',
        caught,
        detail: caught ? '已拦下过期候选建议' : '未能拦下过期候选建议（护栏有问题）',
      }
      if (!caught) checks.push({ name: '负向对照：过期建议必须被拦下', ok: false, detail: negativeControl.detail })
    }
    bank.push({ ...q, payload, negativeControl, result: { mode: String(res.mode ?? 'rules'), ok: checks.every((c) => c.ok), checks } })
  }

  const passed = bank.filter((q) => q.result.ok).length
  const out = {
    generatedAt: new Date().toISOString(),
    mode: '规则模式 / 模拟 AI（未联通真实模型）',
    howToRun: 'npm run ai:bank',
    stats: {
      total: bank.length,
      passed,
      failed: bank.length - passed,
      modelEvidenceQuestions: modelQuestions.length,
      skippedModelQuestions: modelSkipped,
    },
    realModelHook:
      '把 main() 里的 analyzeDisaster(payload) 换成真实模型调用（同样的 payload，同样的 refChecks/contentChecks）即可复用整套题库与判定',
    questions: bank,
  }
  const fs = await import('node:fs')
  const fsMod = fs as unknown as { mkdirSync: (p: string, o?: { recursive?: boolean }) => void; writeFileSync: (p: string, d: string, e?: string) => void }
  fsMod.mkdirSync('artifacts', { recursive: true })
  fsMod.writeFileSync('artifacts/ai-bank.json', JSON.stringify(out, null, 2) + '\n', 'utf8')

  // 生成人读的题库文档
  const lines: string[] = []
  lines.push('# AI 验收题库')
  lines.push('')
  lines.push(`由 \`npm run ai:bank\` 自动生成（${out.generatedAt}）。模式：${out.mode}。`)
  lines.push(`共 ${out.stats.total} 题，校验流程通过 ${out.stats.passed} 题；其中模型证据题 ${out.stats.modelEvidenceQuestions} 题（跳过 ${out.stats.skippedModelQuestions} 题）。`)
  lines.push('')
  lines.push('每题包含：状态快照、问题、预期引用的事件/任务/候选/模型证据 ID、通过条件、实际校验结果。')
  lines.push('允许多种答案，只要引用与快照一致、不编造、不推荐不可行或过期方案。')
  lines.push('')
  for (const q of bank) {
    lines.push(`## ${q.id}（${q.presetTitle}）`)
    lines.push('')
    lines.push(`- 场景：${q.disaster} · 种子 ${q.seed} · 检查点 t=${q.checkpoint}s`)
    lines.push(`- 问题类型：${q.question}`)
    lines.push(`- 问题：${q.prompt}`)
    lines.push(`- 预期引用事件：${q.expected.eventIds.join(', ') || '（无）'}`)
    lines.push(`- 预期引用任务：${q.expected.taskIds.join(', ') || '（无）'}`)
    lines.push(`- 预期引用候选：${q.expected.candidateIds.join(', ') || '（无）'}`)
    lines.push(`- 预期引用模型证据：${(q.expected.evidenceIds ?? []).join(', ') || '（无）'}`)
    if (q.modelRun) lines.push(`- 模型算例：${q.modelRun.model} · ${q.modelRun.caseId} · runId ${q.modelRun.runId} · 引擎 ${q.modelRun.engineVersion}`)
    lines.push(`- 可通过的答案形态：${q.acceptedAnswerKinds.join('；')}`)
    lines.push('- 通过条件：')
    for (const c of q.passConditions) lines.push(`  - ${c}`)
    lines.push(`- 快照：事件 ${q.snapshot.events.length} 条 / 任务 ${q.snapshot.tasks.length} 个 / 候选 ${q.snapshot.candidates.length} 个 / 过期候选 ${q.snapshot.expiredCandidateIds.length} 个 / 模型证据 ${q.snapshot.modelEvidence?.length ?? 0} 条`)
    lines.push(`- 校验结果：${q.result.ok ? '通过' : '失败'}（${q.result.mode}）`)
    for (const c of q.result.checks) lines.push(`  - ${c.ok ? '✓' : '✗'} ${c.name}：${c.detail}`)
    if (q.negativeControl) lines.push(`- 负向对照（${q.negativeControl.scenario}）：${q.negativeControl.caught ? '已拦下' : '未拦下'} — ${q.negativeControl.detail}`)
    lines.push('')
  }
  fsMod.writeFileSync('docs/ai-acceptance-bank.md', lines.join('\n') + '\n', 'utf8')

  for (const q of bank) {
    console.log(`${q.result.ok ? '✓' : '✗'} ${q.id} · ${q.result.mode} · ${q.result.checks.filter((c) => c.ok).length}/${q.result.checks.length} 项通过`)
    for (const c of q.result.checks.filter((x) => !x.ok)) console.log(`    ✗ ${c.name}：${c.detail}`)
  }
  const modelCount = bank.filter((q) => Boolean(q.snapshot.modelEvidence?.length)).length
  console.log(
    `\n题库已写入 artifacts/ai-bank.json 与 docs/ai-acceptance-bank.md：${passed}/${bank.length} 题通过校验流程` +
      (modelCount ? `（含模型证据题 ${modelCount} 题）` : '（未包含模型证据题）'),
  )
  process.exitCode = passed === bank.length ? 0 : 1
}


await main()
