// AI 调度接口代理（可选）。
// 默认：未配置凭据 → 规则模式，前端使用规则生成的候选与说明，并标注“规则模式”。
// 配置 AI_BASE_URL / AI_API_KEY / AI_MODEL 后：把候选摘要发给服务端 AI，
// 让它比较、解释并给出排序建议；规则校验与人工确认始终保留（AI 只影响排序与说明）。
import { env } from './env.mjs'

const PROTOCOL_VERSION = 1

export function aiStatus() {
  const baseUrl = env('AI_BASE_URL')
  const apiKey = env('AI_API_KEY')
  const model = env('AI_MODEL')
  const enabled = Boolean(baseUrl && apiKey && model)
  return {
    enabled,
    mode: enabled ? 'ai' : 'rules',
    model: enabled ? model : null,
    label: enabled ? `AI（${model}）` : env('AI_MOCK', '') === '1' ? '模拟 AI' : '规则模式',
    protocolVersion: PROTOCOL_VERSION,
    note: enabled
      ? 'AI 只比较与解释候选并给出排序建议；规则校验与指挥员确认仍然保留'
      : '未配置 AI 接口：候选排序与说明由规则生成（规则模式）',
  }
}

const SYSTEM_PROMPT = `你是 GeoRelay 社区应急演练的调度分析员。你只能比较与解释“规则规划器已经生成并通过校验的候选方案”，
不能发明新的路线、不能改变任务、不能建议跳过人工确认。输出必须是严格 JSON：
{"order":["candidateId",...],"explanations":{"candidateId":"一句话解释"},"summary":"总体建议（不超过 80 字）"}
要求：不可行（feasible=false）的候选排在最后；解释要引用预计送达时间、时限余量、交接次数和封闭路段。`

function buildUserPrompt(body) {
  const tasks = body.task
  const cands = (body.candidates ?? []).map((c) => ({
    id: c.id,
    title: c.title,
    feasible: c.feasible,
    checks: c.checks,
    etaMinutes: c.eta.map((t) => Math.round(t / 6) / 10),
    slackMinutes: Math.round(c.slackS / 6) / 10,
    isRelay: c.isRelay,
    external: c.external ? { pharmacy: c.external.pharmacy?.name, durationS: c.external.durationS, source: c.external.routeSource } : null,
    internal: c.internal ? { distanceM: Math.round(c.internal.distanceM), durationS: Math.round(c.internal.durationS) } : null,
    reason: c.reason,
  }))
  return JSON.stringify({
    event: body.event,
    clockMinutes: Math.round((body.now ?? 0) / 60 * 10) / 10,
    task: tasks ? { code: tasks.code, title: tasks.title, deadline: tasks.deadlineLabel, need: tasks.need } : null,
    candidates: cands,
  })
}

const ANALYZE_QUESTIONS = {
  situation: '分析当前灾情：现在发生了什么、影响哪些对象、下一步该关注什么',
  affected: '哪些任务受影响：逐个说明任务 ID、受影响原因、是否还有可行方案',
  compare: '比较可行改派：比较候选方案的路线、预计耗时、时限余量与风险，给出推荐',
  resilience: '仅归纳 resilience 中的社区救援筛查。用不超过 80 字的 summary 给出有先后顺序的现场核实与处置建议。沿用输入的动作与范围，不推断实际可达性、建筑安全或救援结果。没有模型证据时 items 可为空。',
}

const ANALYZE_SYSTEM = `你是 GeoRelay 社区应急演练的调度分析员。你只能基于给定的结构化演练状态作答，
不能发明不存在的任务、候选、库存、路线或 ETA。输出必须是严格 JSON：
{"summary":"不超过 80 字的总体判断","items":[{"id":"i1","text":"结论（引用 ID）","taskIds":[],"candidateIds":[],"eventIds":[],"evidenceIds":[]}],"warnings":["仍不确定的信息"]}
规则：
1. 引用任务/候选/事件时只能使用输入里出现过的 ID；
2. 没有可行候选时解释阻塞原因（缺路线/库存/运力/时限/接驳条件），不要编造；
3. 你只给建议，不能修改派单、路网或库存；改派必须由指挥员确认；
4. 如果输入里有 modelEvidence，回答必须引用其中的 evidenceId（形如 ev:...），并写清「模型值」与「演练规则」两层；
   不得自行生成烟气/受损/概率等数值 —— 任何数值只能来自 modelEvidence.value（含阈值 threshold）或候选的 etaMinutes/slackMinutes；
5. 不得声称「已自动派单」「已自动改派」「已修改派单」；你只能建议，等待指挥员确认。`

const COMPARATOR_TEXT = { lt: '低于', lte: '不高于', gt: '高于', gte: '不低于' }
const MODEL_TEXT = { fds: 'FDS', openquake: 'OpenQuake' }
const METRIC_TEXT = {
  visibility: '能见度',
  damage_complete: '完全损坏概率',
  damage_extensive_plus: '严重及以上概率',
  damage_moderate_plus: '中等及以上概率',
  damage_slight_plus: '轻微及以上概率',
}

/** 只读 payload 里的模型证据；不做任何重算/平滑/插值 */
function modelEvidenceOf(body) {
  return Array.isArray(body.modelEvidence) ? body.modelEvidence.filter((e) => e && typeof e.evidenceId === 'string') : []
}

function formatEvidence(e) {
  const model = MODEL_TEXT[e.model] ?? e.model ?? '模型'
  const point = e.sampleId ? `采样点 ${e.sampleId}` : e.assetId ? `资产 ${e.assetId}` : e.targetName ?? '目标'
  const value = e.value === null || e.value === undefined ? '缺测' : `${e.value} ${e.unit ?? ''}`.trim()
  const verdict = COMPARATOR_TEXT[e.comparator] ?? ''
  const metric = METRIC_TEXT[e.metric] ?? e.metric ?? '指标'
  const threshold = `演练阈值 ${e.threshold} ${e.unit ?? ''}`.trim()
  return `依据 ${e.evidenceId}：${model} ${point} 在 t=${Math.round(e.at ?? 0)}s ${metric} ${value} ${verdict}${threshold}`
}

/** 把「模型层」与「演练规则层」分开写，避免把演练判据说成模型结论 */
function evidenceLayers(e) {
  const modelLayer = e.layerModel || `${e.metric ?? '指标'} ${e.value ?? '缺测'} ${e.unit ?? ''}`.trim()
  const ruleLayer = e.layerRule || `${e.ruleId ?? ''} ${e.ruleLabel ?? ''}`.trim()
  return `（模型值：${modelLayer}；演练规则：${ruleLayer}）`
}

function citeEvidence(e) {
  return `${formatEvidence(e)}${evidenceLayers(e)}`
}

/** 规则模式下由结构化状态直接生成分析（不调用模型，标注“规则模式”） */
function rulesAnalyze(body) {
  const events = body.events ?? []
  const tasks = body.tasks ?? []
  const cands = body.candidates ?? []
  const modelEvidence = modelEvidenceOf(body)
  const modelRun = body.modelRun ?? null
  const items = []
  const affected = tasks.filter((t) => t.affected)
  const evidenceForEvent = (ev) =>
    modelEvidence.filter(
      (e) => e.targetType === ev.targetType && (e.targetId === ev.targetId || (ev.targetName && e.targetName === ev.targetName)),
    )
  const evidenceForTask = (t) =>
    modelEvidence.filter(
      (e) =>
        (t.targetId && e.targetId === t.targetId) ||
        (t.name && e.targetName && (e.targetName === t.name || e.targetName.includes(t.name))),
    )
  if (body.question === 'situation' || body.question === 'affected') {
    for (const ev of events.slice(0, 4)) {
      const related = evidenceForEvent(ev).slice(0, 2)
      const text = [
        `${ev.targetName}：${ev.level}（演练时刻 ${Math.round(ev.at)}s）。依据：${(ev.basis ?? []).slice(0, 2).join('；')}`,
        ...related.map(citeEvidence),
      ].join(' ')
      items.push({
        id: `ev:${ev.id}`,
        text,
        taskIds: [],
        candidateIds: [],
        eventIds: [ev.id],
        evidenceIds: related.map((e) => e.evidenceId),
      })
    }
    for (const t of affected.slice(0, 6)) {
      const related = evidenceForTask(t).slice(0, 2)
      items.push({
        id: `t:${t.id}`,
        text: `${t.code} ${t.name} 受影响：${t.affectedReason ?? '原路线不可通行'}；${t.feasibleCount > 0 ? `有 ${t.feasibleCount} 个可行改派` : '当前没有可行改派（缺：' + (t.missing ?? ['可行路线']) + '）'}${related.length ? ` ${related.map(citeEvidence).join(' ')}` : ''}`,
        taskIds: [t.id],
        candidateIds: [],
        eventIds: [],
        evidenceIds: related.map((e) => e.evidenceId),
      })
    }
  }
  if (body.question === 'compare') {
    const feasible = cands.filter((c) => c.feasible)
    // 比较风险时先摆出模型证据（每条都带 evidenceId），再逐候选说明预计耗时/余量
    for (const e of modelEvidence.slice(0, 3)) {
      items.push({
        id: `evid:${e.evidenceId}`,
        text: `比较改派前先核对模型证据：${citeEvidence(e)}`,
        taskIds: [],
        candidateIds: [],
        eventIds: [],
        evidenceIds: [e.evidenceId],
      })
    }
    for (const c of feasible.slice(0, 5)) {
      const task = tasks.find((t) => t.id === c.taskId)
      const related = task ? evidenceForTask(task).slice(0, 2) : []
      items.push({
        id: `c:${c.id}`,
        text: `${c.title}：预计送达 ${Math.round((c.eta?.[0] ?? 0) / 60)} 分钟，时限余量 ${Math.round((c.slackS ?? 0) / 60)} 分钟${c.isRelay ? '，含接力交接' : ''}${related.length ? `；相关模型证据：${related.map(citeEvidence).join('；')}` : ''}`,
        taskIds: [c.taskId],
        candidateIds: [c.id],
        eventIds: [],
        evidenceIds: related.map((e) => e.evidenceId),
      })
    }
    if (!feasible.length) {
      const related = affected.flatMap((t) => evidenceForTask(t)).slice(0, 2)
      items.push({
        id: 'no-feasible',
        text: `当前没有可行改派：${(cands.flatMap((c) => c.reason ?? []).slice(0, 3).join('；') || '需要指挥员补充条件（清障/新增接驳点/调库存）')}${related.length ? `；相关模型证据：${related.map(citeEvidence).join('；')}` : ''}`,
        taskIds: affected.slice(0, 3).map((t) => t.id),
        candidateIds: [],
        eventIds: events.slice(0, 2).map((e) => e.id),
        evidenceIds: related.map((e) => e.evidenceId),
      })
    }
  }
  // 兜底：只要 payload 带模型证据，回答里就必须有结构化 items[].evidenceIds，
  // 不能只在正文里出现 ev:...（前端与校验都以结构字段为准）。
  if (modelEvidence.length && !items.some((i) => (i.evidenceIds ?? []).length)) {
    const e = modelEvidence[0]
    items.push({
      id: `evid:${e.evidenceId}`,
      text: `模型证据：${citeEvidence(e)}`,
      taskIds: [],
      candidateIds: [],
      eventIds: [],
      evidenceIds: [e.evidenceId],
    })
  }
  const feasibleCount = cands.filter((c) => c.feasible).length
  const summary = modelRun
    ? `模型算例 ${modelRun.caseId}（${modelRun.model}）：事件 ${events.length} 条、模型证据 ${modelEvidence.length} 条、可行候选 ${feasibleCount} 个。AI 仅建议，派单需指挥员确认。`
    : `灾情事件 ${events.length} 条，受影响任务 ${affected.length} 项，可行候选 ${feasibleCount} 个。建议按“先保时限、再少改动”的顺序人工确认。`
  const warnings = ['规则模式：以上内容由规则从结构化状态生成，未调用大模型']
  if (modelEvidence.length) {
    warnings.push('模型证据只搬运求解器输出与演练规则两层；AI 不生成烟气/受损数值，也不会自动派单')
  }
  return {
    ok: true,
    mode: 'rules',
    label: '规则模式（未联通真实模型）',
    summary,
    items,
    warnings,
  }
}

/** 模拟模式：用于在没有凭据时验证前端的三条入口与异常分支 */
function mockAnalyze(body) {
  const scenario = body.mockScenario ?? 'normal'
  const cands = (body.candidates ?? []).filter((c) => c.feasible)
  const first = cands[0]
  if (scenario === 'timeout') {
    throw Object.assign(new Error('AI 接口请求失败：超时（模拟）'), { code: 'AI_TIMEOUT' })
  }
  if (scenario === 'bad-format') {
    return { ok: true, mode: 'mock', label: '模拟 AI（返回格式异常）', summary: '（模拟：内容无法解析）', items: 'not-an-array', warnings: [] }
  }
  if (scenario === 'bad-id') {
    return {
      ok: true,
      mode: 'mock',
      label: '模拟 AI（含未知候选 ID）',
      summary: '（模拟）建议改派到 cand:ghost（不存在的候选）',
      items: [
        { id: 'm1', text: '建议采用 cand:ghost 这条路线', taskIds: [(body.tasks ?? [])[0]?.id ?? ''], candidateIds: ['cand:ghost'], eventIds: [] },
      ],
      warnings: ['（模拟）这条建议引用了不存在的候选，应被校验拦下'],
    }
  }
  if (scenario === 'expired') {
    // 优先引用“已确认过的候选”（真正过期）；没有这样的历史时退回一个明显不存在的 ID
    const staleId = (body.expiredCandidateIds ?? [])[0] ?? 'cand:stale-mock'
    const stale = { id: staleId, taskId: (body.tasks ?? [])[0]?.id ?? null }
    return {
      ok: true,
      mode: 'mock',
      label: '模拟 AI（引用过期候选）',
      summary: '（模拟）沿用上一轮已过期的候选方案',
      items: [
        { id: 'm1', text: `沿用 ${stale.id}（上一轮生成，已过期）`, taskIds: stale.taskId ? [stale.taskId] : [], candidateIds: [stale.id], eventIds: [] },
      ],
      warnings: ['（模拟）引用的是过期候选'],
    }
  }
  return {
    ok: true,
    mode: 'mock',
    label: '模拟 AI（未联通真实模型）',
    summary: first ? `（模拟）建议优先确认 ${first.title}，时限余量更充裕` : '（模拟）当前没有可行候选，建议先恢复通路',
    items: first
      ? [
          { id: 'm1', text: `${first.title}：预计 ${Math.round((first.eta?.[0] ?? 0) / 60)} 分钟送达，余量 ${Math.round((first.slackS ?? 0) / 60)} 分钟`, taskIds: [first.taskId], candidateIds: [first.id], eventIds: [] },
        ]
      : [],
    warnings: ['模拟 AI：用于验证流程，不代表真实模型输出'],
  }
}

function buildAnalyzePrompt(body) {
  return JSON.stringify({
    question: body.question,
    questionHint: ANALYZE_QUESTIONS[body.question] ?? '',
    resilience: body.question === 'resilience' ? body.resilience : undefined,
    disaster: body.disaster,
    clockSeconds: Math.round(body.clock ?? 0),
    // 模型来源 + 证据：AI 只能引用这里的 evidenceId 与数值，不得自行生成烟气/受损数值
    modelRun: body.modelRun ?? null,
    modelEvidence: modelEvidenceOf(body).slice(0, 12),
    events: (body.events ?? []).slice(0, 12),
    tasks: (body.tasks ?? []).slice(0, 12),
    candidates: (body.candidates ?? []).slice(0, 16).map((c) => ({
      id: c.id, taskId: c.taskId, kind: c.kind, title: c.title, feasible: c.feasible,
      etaMinutes: Math.round((c.eta?.[0] ?? 0) / 60), slackMinutes: Math.round((c.slackS ?? 0) / 60),
      isRelay: c.isRelay, checks: c.checks, reason: c.reason,
    })),
    agents: (body.agents ?? []).slice(0, 10),
    inventory: (body.inventory ?? []).slice(0, 8),
  })
}

export async function analyzeDisaster(body) {
  const status = aiStatus()
  if (env('AI_MOCK', '') === '1') return { ...mockAnalyze(body), protocolVersion: PROTOCOL_VERSION }
  if (!status.enabled) return { ...rulesAnalyze(body), protocolVersion: PROTOCOL_VERSION }
  const baseUrl = env('AI_BASE_URL').replace(/\/+$/, '')
  const url = `${baseUrl}${env('AI_CHAT_PATH', '/chat/completions')}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number.parseInt(env('AI_TIMEOUT_MS', '20000'), 10))
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env('AI_API_KEY')}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: env('AI_MODEL'),
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: ANALYZE_SYSTEM },
          { role: 'user', content: buildAnalyzePrompt(body) },
        ],
      }),
    })
  } catch (err) {
    throw Object.assign(new Error(`AI 接口请求失败：${err?.name === 'AbortError' ? '超时' : err.message}`), { code: 'AI_NETWORK' })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw Object.assign(new Error(`AI 接口 HTTP ${res.status}`), { code: 'AI_HTTP' })
  const json = await res.json()
  const text = json?.choices?.[0]?.message?.content ?? ''
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/)
    parsed = m ? JSON.parse(m[0]) : null
  }
  if (!parsed || !Array.isArray(parsed.items)) {
    throw Object.assign(new Error('AI 返回内容无法解析为分析结果'), { code: 'AI_BAD_OUTPUT' })
  }
  return {
    ok: true,
    mode: 'ai',
    model: env('AI_MODEL'),
    label: `AI（${env('AI_MODEL')}）`,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    items: parsed.items
      .filter((i) => i && typeof i.text === 'string')
      .map((i, idx) => ({
        id: typeof i.id === 'string' ? i.id : `i${idx + 1}`,
        text: i.text,
        taskIds: Array.isArray(i.taskIds) ? i.taskIds.filter((x) => typeof x === 'string') : [],
        candidateIds: Array.isArray(i.candidateIds) ? i.candidateIds.filter((x) => typeof x === 'string') : [],
        eventIds: Array.isArray(i.eventIds) ? i.eventIds.filter((x) => typeof x === 'string') : [],
        // 模型证据引用：校验层会把这些 ID 对回当前演练，未知的一律拦下
        evidenceIds: Array.isArray(i.evidenceIds) ? i.evidenceIds.filter((x) => typeof x === 'string') : [],
      })),
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((w) => typeof w === 'string') : [],
    protocolVersion: PROTOCOL_VERSION,
  }
}

export async function explainCandidates(body) {
  const status = aiStatus()
  if (!status.enabled) {
    return { ok: true, mode: 'rules', ...status, text: null, protocolVersion: PROTOCOL_VERSION }
  }
  const baseUrl = env('AI_BASE_URL').replace(/\/+$/, '')
  const url = `${baseUrl}${env('AI_CHAT_PATH', '/chat/completions')}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number.parseInt(env('AI_TIMEOUT_MS', '20000'), 10))
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env('AI_API_KEY')}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: env('AI_MODEL'),
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(body) },
        ],
      }),
    })
  } catch (err) {
    throw Object.assign(new Error(`AI 接口请求失败：${err?.name === 'AbortError' ? '超时' : err.message}`), { code: 'AI_NETWORK' })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw Object.assign(new Error(`AI 接口 HTTP ${res.status}`), { code: 'AI_HTTP' })
  const json = await res.json()
  const text = json?.choices?.[0]?.message?.content ?? ''
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/)
    parsed = m ? JSON.parse(m[0]) : null
  }
  if (!parsed || !Array.isArray(parsed.order)) {
    throw Object.assign(new Error('AI 返回内容无法解析为候选排序'), { code: 'AI_BAD_OUTPUT' })
  }
  return {
    ok: true,
    mode: 'ai',
    model: env('AI_MODEL'),
    order: parsed.order.filter((x) => typeof x === 'string'),
    explanations: parsed.explanations && typeof parsed.explanations === 'object' ? parsed.explanations : {},
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    protocolVersion: PROTOCOL_VERSION,
  }
}
