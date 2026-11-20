import type { AiAnalysis, AiQuestion } from '../../services/lbsClient.ts'
import type { DrillState, PlanSet } from './types.ts'
import { affectedTasks, currentBlocked, type Engine } from './engine.ts'
import type { ImpactEvent } from '../disaster/types.ts'
import type { ModelEvidence } from '../modelrun/types.ts'

/**
 * AI 分析的上下文与校验（Web 与命令行题库共用）。
 *
 * 两件事必须只写一份，否则界面和验收会各说一套：
 *  1. `buildAiPayload`：把当前演练状态压成 AI 能读的结构化上下文（事件、受影响任务、候选、队伍、库存、模型证据）。
 *  2. `validateAiRefs`：把 AI 返回的引用对回当前演练，未知/不可行/已过期/不存在的模型证据一律拦下。
 *
 * 模型证据的搬运原则：AI 侧只读 `plan.modelEvents[].evidence` 的原始值，
 * 不重算、不平滑、不插值；数值（模型层）与阈值（演练规则层）分开写，避免把判据说成模型结论。
 */

export type { Engine }

/** 单条模型证据：模型算出了什么（metric/value/unit）+ 哪条演练规则把它判成受阻（rule/threshold） */
export interface AiModelEvidence {
  /** 稳定 ID：`ev:${runId}:${sampleId||assetId}:${ruleId}`，AI 必须用它引用证据 */
  evidenceId: string
  runId: string
  model: 'fds' | 'openquake'
  engineVersion: string
  caseId: string
  /** 模型层说明（求解器输出：采样点、时刻、数值） */
  layerModel: string
  /** 演练规则层说明（阈值、判据、规则 ID） */
  layerRule: string
  metric: string
  value: number | null
  unit: string
  comparator: 'lt' | 'lte' | 'gt' | 'gte'
  threshold: number
  ruleId: string
  ruleLabel: string
  targetType: string
  targetId: string
  targetName: string
  /** 事件发生的演练时刻（秒） */
  at: number
  /** 规则判定结果：blocked（不可通行）/ restricted（受限） */
  consequence: string
  /** 来源分层文案（模型计算结果回放 / 官方算例导入 / 简化演示） */
  provenanceLabel: string
  /** 算例适用范围声明 */
  scope: string
}

/** 模型算例概要（没有模型算例时为 null） */
export interface AiModelRunSummary {
  runId: string
  model: 'fds' | 'openquake'
  engineVersion: string
  caseId: string
  label: string
  scope: string
  ranAt: string | null
}

/** 单次分析最多搬多少条模型证据（防止 payload 过大；按事件时间升序取前 N 条） */
export const MODEL_EVIDENCE_LIMIT = 12

/** 证据稳定 ID：同一算例 + 同一采样点/资产 + 同一条规则 → 同一个 ID（可复跑、可核对） */
export function modelEvidenceIdOf(ev: Pick<ModelEvidence, 'runId' | 'sampleId' | 'assetId' | 'ruleId'>): string {
  return `ev:${ev.runId}:${ev.sampleId || ev.assetId || 'unknown'}:${ev.ruleId}`
}

export interface AiPayload {
  question: AiQuestion
  disaster: string
  clock: number
  events: unknown[]
  tasks: unknown[]
  candidates: unknown[]
  agents: unknown[]
  inventory: unknown[]
  planSetCount: number
  expiredCandidateIds: string[]
  /** 当前演练已发生的模型证据（最多 MODEL_EVIDENCE_LIMIT 条；无算例时为空数组） */
  modelEvidence: AiModelEvidence[]
  /** 当前模型算例概要；简化演示时为 null */
  modelRun: AiModelRunSummary | null
  mockScenario?: string
}

/** 仍可操作的候选集：只有“尚未确认”的集可以拿来建议改派 */
export function relevantPlanSets(state: DrillState): PlanSet[] {
  return Object.values(state.planSets).filter((ps) => !ps.confirmedCandidateId)
}

/** 已过期（不能再确认）的候选 ID：来自已确认的候选集 */
export function expiredCandidateIds(state: DrillState): string[] {
  return Object.values(state.planSets)
    .filter((ps) => ps.confirmedCandidateId)
    .flatMap((ps) => ps.candidates.map((c) => c.id))
}

/**
 * 搬运模型证据：只读 `plan.modelEvents[]` 上已经由 ingest 写好的 evidence，
 * 不做任何换算；并且只暴露“当前演练时刻已经触发”的事件，避免把未来当现状。
 */
export function buildModelEvidence(engine: Engine): AiModelEvidence[] {
  const plan = engine.disaster?.plan
  const state = engine.state
  const provenance = plan?.provenance ?? null
  const out: AiModelEvidence[] = []
  const seen = new Set<string>()
  const events = [...(plan?.modelEvents ?? [])]
    .filter((ev): ev is ImpactEvent & { evidence: ModelEvidence } => Boolean(ev.evidence))
    .filter((ev) => ev.at <= state.clock.t)
    .sort((a, b) => a.at - b.at)
  for (const ev of events) {
    const evid = ev.evidence
    const evidenceId = modelEvidenceIdOf(evid)
    if (seen.has(evidenceId)) continue
    // 事件已进入当前演练状态（emitDisasterEvents 之后）才作为“当前证据”给出
    if (!state.impacts[ev.id]) continue
    seen.add(evidenceId)
    out.push({
      evidenceId,
      runId: evid.runId,
      model: evid.model,
      engineVersion: evid.engineVersion,
      caseId: evid.caseId,
      layerModel: evid.layers?.model ?? '',
      layerRule: evid.layers?.rule ?? '',
      metric: evid.metric,
      value: evid.value,
      unit: evid.unit,
      comparator: evid.comparator,
      threshold: evid.threshold,
      ruleId: evid.ruleId,
      ruleLabel: evid.ruleLabel,
      targetType: ev.targetType,
      targetId: ev.targetId,
      targetName: ev.targetName,
      at: Math.round(ev.at),
      consequence: ev.traffic,
      provenanceLabel: provenance?.label ?? '',
      scope: provenance?.scope ?? '',
    })
    if (out.length >= MODEL_EVIDENCE_LIMIT) break
  }
  return out
}

/** 模型算例概要（AI 用来在回答里标注来源；没有算例时为 null） */
export function modelRunSummaryOf(engine: Engine): AiModelRunSummary | null {
  const p = engine.disaster?.plan?.provenance
  if (!p) return null
  return {
    runId: p.runId,
    model: p.model,
    engineVersion: p.engineVersion,
    caseId: p.caseId,
    label: p.label,
    scope: p.scope,
    ranAt: p.ranAt,
  }
}

export function buildAiPayload(
  engine: Engine,
  question: AiQuestion,
  opts: { mockScenario?: string } = {},
): AiPayload {
  const eng = engine as unknown as Engine
  const state = eng.state
  const relevant = relevantPlanSets(state)
  const candidates = relevant.flatMap((ps) => ps.candidates)
  const affected = affectedTasks(eng, currentBlocked(eng))
  return {
    question,
    disaster: state.disaster,
    clock: state.clock.t,
    events: Object.values(state.impacts).map((e) => ({
      id: e.id,
      at: e.at,
      targetType: e.targetType,
      targetId: e.targetId,
      targetName: e.targetName,
      level: e.level,
      traffic: e.traffic,
      basis: e.basis,
      reason: e.reason,
    })),
    tasks: state.tasks.map((t) => {
      const plan = state.plans[state.assignments[t.id]]
      const feasibleCount = candidates.filter((c) => c.taskId === t.id && c.feasible).length
      const missing = [...new Set(candidates.filter((c) => c.taskId === t.id && !c.feasible).flatMap((c) => c.reason))].slice(0, 3)
      return {
        id: t.id,
        code: t.code,
        name: t.targetName,
        deadline: t.deadlineLabel,
        need: t.need,
        status: plan?.phase ?? 'unassigned',
        version: plan?.version ?? 0,
        affected: affected.some((x) => x.id === t.id),
        affectedReason: plan?.blockedBy ? `${plan.blockedBy.label} 不可通行` : plan?.blockedRoadId ? '路线经过封闭路段' : undefined,
        feasibleCount,
        missing: feasibleCount ? undefined : missing,
      }
    }),
    candidates: candidates.map((c) => ({
      id: c.id,
      taskId: c.taskId,
      kind: c.kind,
      title: c.title,
      feasible: c.feasible,
      eta: c.eta,
      slackS: c.slackS,
      isRelay: c.isRelay,
      checks: c.checks,
      reason: c.reason,
    })),
    agents: state.agents.map((ag) => ({ id: ag.id, name: ag.name, role: ag.role, capacityKg: ag.capacityKg })),
    inventory: Object.values(state.inventory).map((p) => ({ id: p.id, name: p.name, availability: p.availability, stock: p.stock })),
    planSetCount: Object.values(state.planSets).length,
    expiredCandidateIds: expiredCandidateIds(state).slice(0, 8),
    modelEvidence: buildModelEvidence(eng),
    modelRun: modelRunSummaryOf(eng),
    mockScenario: opts.mockScenario,
  }
}

export interface AiRejectedRef {
  kind: 'candidate' | 'task' | 'event' | 'evidence'
  id: string
  reason: string
}

/** 从当前演练状态反推“已发生的模型证据 ID”，与 buildAiPayload 用同一套稳定 ID */
function knownEvidenceIds(state: DrillState): Set<string> {
  const out = new Set<string>()
  for (const ev of Object.values(state.impacts)) {
    const evidence = (ev as ImpactEvent).evidence
    if (evidence) out.add(modelEvidenceIdOf(evidence))
  }
  return out
}

/** 校验 AI 返回的引用：未知 / 不可行 / 已过期 / 不存在的模型证据一律拦下，并说明原因 */
export function validateAiRefs(
  res: AiAnalysis,
  state: DrillState,
  sets: PlanSet[],
): {
  rejected: AiRejectedRef[]
  accepted: { taskIds: string[]; candidateIds: string[]; eventIds: string[]; evidenceIds: string[] }
} {
  const rejected: AiRejectedRef[] = []
  const accepted = { taskIds: [] as string[], candidateIds: [] as string[], eventIds: [] as string[], evidenceIds: [] as string[] }
  const taskIds = new Set(state.tasks.map((t) => t.id))
  const eventIds = new Set(Object.keys(state.impacts))
  const evidenceIds = knownEvidenceIds(state)
  const candById = new Map<string, { ps: PlanSet; feasible: boolean }>()
  for (const ps of sets) for (const c of ps.candidates) candById.set(c.id, { ps, feasible: c.feasible })
  const allCandIds = new Set<string>()
  for (const ps of Object.values(state.planSets)) for (const c of ps.candidates) allCandIds.add(c.id)

  // AI 返回的 evidenceIds 是新增字段：类型在 lbsClient 里可能是旧版，这里按结构化读取
  const items = (Array.isArray(res.items) ? res.items : []) as Array<
    AiAnalysis['items'][number] & { evidenceIds?: string[] }
  >
  for (const item of items) {
    for (const id of item.taskIds ?? []) {
      if (!taskIds.has(id)) rejected.push({ kind: 'task', id, reason: '当前演练里没有这个任务' })
      else accepted.taskIds.push(id)
    }
    for (const id of item.eventIds ?? []) {
      if (!eventIds.has(id)) rejected.push({ kind: 'event', id, reason: '当前演练里没有这个事件（可能还没发生）' })
      else accepted.eventIds.push(id)
    }
    for (const id of item.evidenceIds ?? []) {
      // 模型证据必须来自当前演练已经触发的模型事件；AI 不能引用别处的算例或自造 ID
      if (!evidenceIds.has(id)) rejected.push({ kind: 'evidence', id, reason: '当前演练没有这条模型证据' })
      else accepted.evidenceIds.push(id)
    }
    for (const id of item.candidateIds ?? []) {
      const hit = candById.get(id)
      if (!hit) {
        rejected.push({
          kind: 'candidate',
          id,
          reason: allCandIds.has(id) ? '候选已过期：所属候选集已确认生效，不能再次确认' : '未知候选：当前演练没有这个候选',
        })
        continue
      }
      if (!hit.feasible) rejected.push({ kind: 'candidate', id, reason: '该候选未通过规则校验，不能作为可确认建议' })
      else accepted.candidateIds.push(id)
    }
  }
  const seen = new Set<string>()
  const uniq = rejected.filter((r) => {
    const k = r.kind + r.id + r.reason
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { rejected: uniq, accepted }
}
