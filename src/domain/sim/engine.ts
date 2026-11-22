import type { LngLat } from '../geo/types.ts'
import type { CommunityModel } from '../community/model.ts'
import type { ExternalLegProvider } from '../routing/external.ts'
import { CommunityRouter } from '../routing/internal.ts'
import { coordNodeId } from '../routing/build.ts'
import { localFrameFromFence } from '../community/frame.ts'
import { externalTravelSeconds, PICKUP_WAIT_S, HANDOVER_WAIT_S } from './deliveryTiming.ts'
import { haversine, toLocal } from '../geo/wgs84.ts'
import { distToPolygonBoundary, pointInPolygon } from '../geo/geometry.ts'
import { pointAtFraction, pathLengthM } from '../geo/path.ts'
import type {
  Agent,
  Candidate,
  DisasterKind,
  DrillState,
  EventKind,
  ExternalLeg,
  InventoryPoint,
  Plan,
  Responder,
  RoadClosureEvidence,
  SimEvent,
  SimTime,
  Task,
} from './types.ts'
import { floodedSegments, historyFor, roadDepthAt, type FloodPlan } from '../disaster/flood.ts'
import { planDisaster, type DisasterBundle } from '../disaster/index.ts'
import type { ImpactEvent } from '../disaster/types.ts'
import { planModelDisaster } from '../disaster/modelRun.ts'
import type { ModelDrillBundle } from '../modelrun/types.ts'
import { configFromSeed, deriveAgents, deriveTasks, externalOrigin } from './scenario.ts'
import { blockedSets, buildCandidates, relayOptionsFor, type BlockedSets, type BuildResult } from './planner.ts'
import type { CandidateRanker } from './ranker.ts'
import { uid } from '../util/id.ts'
import { addEvacuationGroups, RESCUE_PRIORITY_LABELS, stepEvacuation, stepProfessionalRescue } from './evacuation.ts'

/**
 * 演练模拟器（无界面）。
 *
 * 所有推进都通过 `advance(engine, seconds)` / `tick(engine, dt)` 完成：
 *  - 演练时钟、随机种子、封路事件序列由输入固定 → 结果可复现；
 *  - 浏览器内按真实时间驱动，批处理脚本按固定步长驱动，走同一份代码；
 *  - Agent 状态（接单、移动、交接、送达、受阻）每步回写到 DrillState。
 */

export interface CommunityView {
  model: CommunityModel
  router: CommunityRouter
}

export interface EngineOptions {
  community: CommunityModel
  seed: number
  startLabel?: string
  startMs?: number
  pharmacies: InventoryPoint[]
  provider: ExternalLegProvider
  ranker: CandidateRanker
  durationS?: number
  untilAllEvacuated?: boolean
  continueAfterEvacuation?: boolean
  /** 灾种：内涝 / 火灾 / 地震（默认内涝） */
  disaster?: DisasterKind
  /** 火灾变体：no_alt 用于验证“没有备用入口”时的表现 */
  fireVariant?: 'with_alt' | 'no_alt'
  /**
   * 专业模型算例（FDS / OpenQuake 的缓存回放包）。
   * 提供时灾情事件来自求解器输出 + 独立演练规则，不再走简化演示的公式。
   */
  modelRun?: ModelDrillBundle
}

export interface Engine {
  state: DrillState
  view: CommunityView
  flood: FloodPlan
  seed: number
  /** 当前灾情方案（结构化影响事件 + 场景说明 + 地图几何） */
  disaster: DisasterBundle
  /** 火灾变体（重置时保留） */
  fireVariant?: 'with_alt' | 'no_alt'
  /** 专业模型算例（重置时保留） */
  modelRun?: ModelDrillBundle
  cache: Map<string, ExternalLeg>
  ranker: CandidateRanker
  provider: ExternalLegProvider
  /** 待生成候选的封路事件（由 tick 收集、由 advance 等待完成） */
  pendingProposals: Array<{ refId: string; kind: 'road' | 'door' | 'staging'; at: SimTime }>
  planning?: { stage: 'impact' | 'routes' | 'rank' | 'ready' | 'error'; detail: string; at: number }
  onPlanning?: (active: boolean) => Promise<void>
}

// ---------------------------------------------------------------------------
// 时间推进
// ---------------------------------------------------------------------------

/** 显式推进演练秒（水位、事件、Agent/消防位置）。UI 暂停由 clock.advance 返回 dt=0；批处理仍可手动推进。 */
export function tick(engine: Engine, dt: number): void {
  if (dt <= 0 || engine.state.status !== 'running') return
  const step = Math.min(5, dt, engine.state.config.untilAllEvacuated ? Infinity : Math.max(0, engine.state.config.durationS - engine.state.clock.t))
  const s = engine.state
  const from = s.clock.t
  const to = from + step
  s.clock.t = to
  s.tick += 1
  updateDepths(engine, to)
  emitDisasterEvents(engine, from, to)
  markInterrupted(engine)
  stepAgents(engine, step)
  stepResponders(engine)
  if (s.evacuation.length) advanceEvacuation(engine, step)
  const allEvacuated = s.evacuation.length > 0 && s.evacuation.every((g) => g.status === 'arrived')
    && new Set(s.evacuation.map((group) => group.buildingId)).size === engine.view.model.buildings.length
  if (allEvacuated && s.evacuationCompletedAt === undefined) {
    s.evacuationCompletedAt = to
    if (s.config.continueAfterEvacuation) pushEvent(engine, 'note', '全员已在围栏外集结，进入灾情监测与物资保障阶段', { message: '全员集结' })
  }
  if (s.config.untilAllEvacuated ? allEvacuated && !s.config.continueAfterEvacuation : to >= s.config.durationS) {
    s.status = 'finished'
    s.clock.running = false
    pushEvent(engine, 'note', s.config.untilAllEvacuated ? '演练完成：全员到达围栏外集结点' : '演练结束：演练时钟到达设定时长', { message: '演练结束' })
  }
}

/**
 * 按秒推进，并**等待**本次推进中产生的候选生成完成。
 *
 * 候选生成是异步的（外部段要走路线接口），所以推进必须是异步的：
 * 否则无头批处理和界面都会出现“封路已发生但候选还没出现”的竞态，
 * 演练就无法复现。浏览器与批处理都调用这个函数。
 */
export async function advance(engine: Engine, seconds: number, onTick?: () => void): Promise<void> {
  let remain = seconds
  const state = engine.state
  while (remain > 1e-6 && engine.state === state && state.status === 'running') {
    const dt = remain > 5 ? 5 : remain
    tick(engine, dt)
    onTick?.()
    await flushProposals(engine)
    remain -= dt
  }
  if (engine.state === state) await flushProposals(engine)
}

/** 把 tick 期间收集到的封路事件逐个生成候选（按发生顺序，保证可复现） */
export async function flushProposals(engine: Engine): Promise<void> {
  while (engine.pendingProposals.length) {
    const ev = engine.pendingProposals.shift()!
    const key = `ps:${ev.refId}#${Math.round(ev.at)}`
    if (engine.state.planSets[key]) continue
    await internalPropose(engine, ev)
  }
}

function updateDepths(engine: Engine, t: SimTime): void {
  const s = engine.state
  if (s.disaster !== 'flood') {
    for (const g of engine.view.model.net.gates) g.depthM = 0
    for (const st of engine.view.model.net.staging) st.depthM = 0
    return
  }
  for (const road of engine.view.model.net.roads) s.depths[road.id] = roadDepthAt(engine.flood, road.id, t)
  for (const g of engine.view.model.net.gates) g.depthM = depthNear(engine, g.local, t)
  for (const st of engine.view.model.net.staging) st.depthM = depthNear(engine, st.local, t)
}

function depthNear(engine: Engine, p: { x: number; y: number }, t: SimTime): number {
  let best = Infinity
  let depth = 0
  for (const seg of engine.flood.segments) {
    const mid = { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 }
    const d = Math.hypot(mid.x - p.x, mid.y - p.y)
    if (d < best) {
      best = d
      depth = roadDepthAt(engine.flood, seg.roadId, t)
    }
  }
  return best < 40 ? depth : 0
}

/**
 * 把当前灾种的统一影响事件按演练时钟发出来。
 *
 * 三种灾情共用这一段：路段封闭写入 closures，入口不可通行写入 blockedDoors，
 * 接驳点不可用写入 blockedStaging —— 后面所有可达性、规划、改派都只读这三份状态，
 * 所以火灾/地震不需要另写一套调度器。
 */
function emitDisasterEvents(engine: Engine, from: SimTime, to: SimTime): void {
  const s = engine.state
  for (const ev of engine.disaster.plan.events) {
    // 包含初始 t=0 的模型影响；impacts 去重保证边界事件只发一次。
    if (ev.at < from || ev.at > to) continue
    if (s.impacts[ev.id]) continue
    s.impacts[ev.id] = ev
    if (ev.targetType === 'road' && ev.traffic === 'blocked') {
      if (s.closures[ev.targetId]) continue
      const isFlood = ev.disaster === 'flood'
      const evidence: RoadClosureEvidence = {
        roadId: ev.targetId,
        roadName: ev.targetName,
        depthM: isFlood ? roadDepthAt(engine.flood, ev.targetId, to) : (ev.metrics?.depthM ?? 0),
        thresholdM: ev.metrics?.thresholdM ?? 0,
        at: ev.at,
        // 内涝保留涨水历史；火灾/地震没有水深概念，历史留空
        history: isFlood ? historyFor(engine.flood, ev.targetId, to) : [],
        reason: ev.reason,
        disaster: ev.disaster,
        impactId: ev.id,
      }
      s.closures[ev.targetId] = evidence
      pushEvent(engine, 'road_closed', closedMessage(ev), evidence, { roadIds: [ev.targetId] })
      engine.pendingProposals.push({ refId: ev.targetId, kind: 'road', at: ev.at })
    } else if (ev.targetType === 'entrance' && ev.traffic === 'blocked') {
      s.blockedDoors[ev.targetId] = ev
      pushEvent(engine, 'entrance_blocked', `入口不可通行：${ev.targetName}（${ev.level}）—— ${ev.reason}`, { message: ev.reason }, {})
      engine.pendingProposals.push({ refId: ev.targetId, kind: 'door', at: ev.at })
    } else if (ev.targetType === 'staging' && ev.traffic === 'blocked') {
      s.blockedStaging[ev.targetId] = ev
      pushEvent(engine, 'staging_blocked', `接驳点不可用：${ev.targetName}（${ev.level}）—— ${ev.reason}`, { message: ev.reason }, {})
      engine.pendingProposals.push({ refId: ev.targetId, kind: 'staging', at: ev.at })
    } else if (ev.targetType === 'building') {
      pushEvent(engine, 'building_damaged', ev.reason, { message: ev.reason }, {})
    } else {
      pushEvent(engine, 'note', ev.reason, { message: ev.reason }, {})
    }
    // 任一灾种出现实际受阻/楼栋受损才自动出动；预警、开放通行不触发。
    const damaged = ev.targetType === 'building' && (
      ev.metrics?.damageRatio !== undefined ? ev.metrics.damageRatio > 0 : ev.traffic === 'restricted'
    )
    if (ev.traffic === 'blocked' || damaged) dispatchResponder(engine, ev.at)
  }
}

function closedMessage(ev: ImpactEvent): string {
  if (ev.disaster === 'flood') return `封路事件：${ev.targetName} 演练水深 ${(ev.metrics?.depthM ?? 0).toFixed(2)}m ≥ 阈值 ${(ev.metrics?.thresholdM ?? 0).toFixed(2)}m`
  if (ev.disaster === 'fire') return `路段封闭：${ev.targetName} 被烟雾覆盖（${ev.level}）`
  return `路段中断：${ev.targetName} 因地震断裂封闭`
}

/** 把影响事件转换成候选生成需要的“驱动事件”结构 */
function evidenceFor(engine: Engine, ref: { refId: string; kind: 'road' | 'door' | 'staging'; at: SimTime }): RoadClosureEvidence {
  const s = engine.state
  if (ref.kind === 'road' && s.closures[ref.refId]) return s.closures[ref.refId]
  const ev = ref.kind === 'road' ? s.impacts[Object.keys(s.impacts).find((k) => s.impacts[k].targetId === ref.refId) ?? ''] : s.impacts[Object.keys(s.impacts).find((k) => s.impacts[k].targetId === ref.refId) ?? '']
  const impact: ImpactEvent | undefined = ev ?? Object.values(s.impacts).find((x) => x.targetId === ref.refId)
  return {
    roadId: ref.refId,
    roadName: impact?.targetName ?? ref.refId,
    depthM: impact?.metrics?.depthM ?? 0,
    thresholdM: impact?.metrics?.thresholdM ?? 0,
    at: ref.at,
    history: [],
    reason: impact?.reason ?? '灾情影响',
    disaster: s.disaster,
    impactId: impact?.id,
  }
}

/** 当前不可通行集合（路段 + 入口 + 接驳点） */
export function currentBlocked(engine: Engine): BlockedSets {
  const s = engine.state
  return blockedSets(engine.view.router, Object.keys(s.closures), s.config.depthThresholdM, {
    doors: Object.keys(s.blockedDoors),
    staging: Object.keys(s.blockedStaging),
  })
}

export function orderEvacuation(engine: Engine, buildingIds: string[]): void {
  if (engine.state.status !== 'running') return
  const groups = engine.state.evacuation
  addEvacuationGroups(engine.view.router, groups, buildingIds, engine.state.clock.t, engine.seed)
  advanceEvacuation(engine, 0)
}

function advanceEvacuation(engine: Engine, seconds: number): void {
  const blocked = currentBlocked(engine)
  const router = engine.view.router
  for (const event of Object.values(engine.state.impacts)) {
    if (event.targetType !== 'building' || (event.traffic !== 'blocked' && event.level !== '倒塌')) continue
    const entrance = router.verts.byNode.get(`entrance:${event.targetId}`)
    if (entrance) blocked.verts.add(entrance.id)
  }
  stepEvacuation(router, engine.state.evacuation, blocked, seconds, engine.state.clock.t)
  if (!engine.state.config.untilAllEvacuated) return
  if (engine.state.evacuation.some((g) => g.status === 'blocked') && !engine.state.responders.length) dispatchResponder(engine, engine.state.clock.t)
  const arrived = engine.state.responders.filter((responder) => responder.status === 'arrived')
  if (arrived.length) {
    const model = engine.view.model
    const radius = Math.max(0, ...model.fence.polygon.map((p) => haversine(model.center, p)))
    const priority = engine.state.rescuePriority ?? 'efficiency'
    for (const responder of arrived) {
      const availableSeconds = Math.min(seconds, Math.max(0, engine.state.clock.t - (responder.arrivedAt ?? engine.state.clock.t)))
      const assigned = stepProfessionalRescue(router, engine.state.evacuation, externalOrigin(model.center, engine.seed, 2, (radius + 30) / 0.92), availableSeconds, priority, responder.id)
      if (!assigned) continue
      const building = model.buildings.find((item) => item.id === assigned.buildingId)
      pushEvent(engine, 'rescue_assigned', `${responder.name} 转运 · ${building?.name ?? '楼栋'} ${assigned.residents} 人 · ${RESCUE_PRIORITY_LABELS[priority]}`, { message: '消防转运' }, { buildingId: assigned.buildingId, responderIds: [responder.id] })
    }
  }
}

function markInterrupted(engine: Engine): void {
  const s = engine.state
  // 中断来源有三类：路段封闭、入口不可用、接驳点不可用。
  // 早期实现只看路段，导致“原接驳点失效但路段都通”的场景（例如地震）不会打断已生效方案，
  // 指挥台就不会出现替代路线 —— 这正是需要改派的情形。
  if (!Object.keys(s.closures).length && !Object.keys(s.blockedDoors).length && !Object.keys(s.blockedStaging).length) return
  for (const [taskId, planId] of Object.entries(s.assignments)) {
    const plan = s.plans[planId]
    if (!plan || plan.phase === 'delivered' || plan.phase === 'blocked') continue
    if (plan.blockedRoadId) continue
    const hit = planRoads(engine, plan).find((r) => Boolean(s.closures[r]))
    const doorKey = plan.legs.internal?.targetDoor
    const doorHit = doorKey ? s.blockedDoors[doorKey] : undefined
    // 接力方案在接驳点交接：该接驳点不可用 → 原方案无法完成交接
    const stagingStop = plan.legs.internal?.stops?.find((st) => st.kind === 'staging')
    const stagingId = stagingStop?.nodeKey?.startsWith('staging:') ? stagingStop.nodeKey.slice('staging:'.length) : null
    const stagingHit = stagingId ? s.blockedStaging[stagingId] : undefined
    if (!hit && !doorHit && !stagingHit) continue
    plan.blockedRoadId = hit ?? null
    plan.blockedBy = hit
      ? { kind: 'road', id: hit, label: roadName(engine, hit) }
      : doorHit
        ? { kind: 'door', id: doorHit.targetId, label: doorHit.targetName }
        : stagingHit
          ? { kind: 'staging', id: stagingHit.targetId, label: stagingHit.targetName }
          : null
    plan.interruptedAt = s.clock.t
    plan.phase = 'blocked'
    const task = s.tasks.find((t) => t.id === taskId)
    const agent = s.agents.find((a) => a.id === plan.carryAgentId)
    const resting = restingPoint(engine, plan)
    if (agent) agent.restingAt = resting
    const reason = hit
      ? `${agent?.name ?? plan.agentName} 前往 ${task?.targetName ?? '目标'} 的路线经过封闭路段「${roadName(engine, hit)}」，已原地等待新派单（确认前不改变原安排）`
      : doorHit
        ? `${agent?.name ?? plan.agentName} 前往 ${task?.targetName ?? '目标'} 时，目标入口「${doorHit.targetName}」已${s.disaster === 'fire' ? '被烟雾覆盖' : '不可用'}，已原地等待新派单（确认前不改变原安排）`
        : `${agent?.name ?? plan.agentName} 原计划在接驳点「${stagingHit?.targetName ?? ''}」接力，该接驳点已不可用，已原地等待新派单（确认前不改变原安排）`
    pushEvent(engine, 'agent_blocked', reason, { message: '受阻' }, hit ? { roadIds: [hit], taskIds: [taskId], agentIds: agent ? [agent.id] : [] } : { taskIds: [taskId], agentIds: agent ? [agent.id] : [] })
  }
}

export function roadName(engine: Engine, roadId: string): string {
  return engine.view.model.net.roads.find((r) => r.id === roadId)?.name ?? roadId
}

export function planRoads(engine: Engine, plan: Plan): string[] {
  void engine
  return plan.legs.internal?.roadIds ?? []
}

function restingPoint(engine: Engine, plan: Plan): LngLat {
  const agent = engine.state.agents.find((a) => a.id === plan.carryAgentId)
  const gateId = plan.legs.external?.atGate
  if (gateId && !gateId.startsWith('edgegate:')) {
    const gate = engine.view.model.net.gates.find((g) => g.id === gateId)
    if (gate) return gate.lngLat
  }
  if (agent?.origin) return agent.origin
  return engine.view.model.center
}

// ---------------------------------------------------------------------------
// 消防响应（不参与志愿者派单、库存或救援结果判定）
// ---------------------------------------------------------------------------

/** 显式出动一支演练消防单元；每场演练幂等。暂停时可下令，但移动仍需推进演练时钟。 */
export function dispatchFirefighters(engine: Engine): Responder | null {
  return dispatchResponder(engine, engine.state.clock.t)
}

function dispatchResponder(engine: Engine, at: SimTime): Responder | null {
  if (engine.state.status === 'running') {
    const count = engine.state.rescueTeams ?? 1
    while (engine.state.responders.length < count) addResponder(engine, at, engine.state.responders.length + 1)
  }
  return engine.state.responders[0] ?? null
}

function addResponder(engine: Engine, at: SimTime, number: number): void {
  const s = engine.state

  const model = engine.view.model
  const frame = engine.view.router.verts.frame
  const boundaryRadiusM = Math.max(0, ...model.fence.polygon.map((p) => haversine(model.center, p)))
  // origin:2 与两组志愿者使用不同的固定子种子；大社区也保证起点在围栏外。
  const origin = externalOrigin(model.center, engine.seed, number + 1, Math.max(s.config.externalOriginRadiusM, (boundaryRadiusM + 200) / 0.92))
  const usable = (p: LngLat): boolean => {
    const local = toLocal(frame, p)
    if (model.buildings.some((b) => pointInPolygon(local, b.footprint) || distToPolygonBoundary(local, b.footprint) < 1)) return false
    return s.disaster !== 'flood' || depthNear(engine, local, at) < s.config.depthThresholdM
  }
  const nearest = <T extends { lngLat: LngLat }>(points: T[]): T | undefined =>
    points.filter((p) => usable(p.lngLat)).sort((a, b) => haversine(origin, a.lngLat) - haversine(origin, b.lngLat))[0]
  const gate = nearest(model.net.gates)
  const staging = gate ? undefined : nearest(model.net.staging.filter((st) => !s.blockedStaging[st.id] && !engine.disaster.plan.events.some(
    (ev) => ev.at <= at && ev.targetType === 'staging' && ev.targetId === st.id && ev.traffic === 'blocked',
  )))
  // 不退回灾点/楼栋中心：没有可用节点时，在包围社区的圆外设置明确标注的模拟集结点。
  const target: LngLat = [...(gate?.lngLat ?? staging?.lngLat ?? externalOrigin(model.center, engine.seed, 2, (boundaryRadiusM + 30) / 0.92))]
  const targetName = gate ? `${gate.name}（消防集结点）` : staging ? `${staging.name}（消防集结点）` : '社区外围模拟集结点（无可用大门/接驳点）'
  const path: LngLat[] = [origin, target]
  const distanceM = pathLengthM(path)
  const speedMps = 80 / 3.6
  const responder: Responder = {
    id: `responder-firefighter-${number}`,
    name: `消防响应单元 ${number}（演练）`,
    role: 'firefighter',
    origin,
    originName: '界外模拟出动点（非真实消防站）',
    originSource: 'sample',
    target,
    targetName,
    path,
    routeSource: 'sample',
    routeNote: '模拟外部直线路线，非真实道路导航；未验证通行条件。假设恒速 80 km/h，仅估算到集结点的行程，不代表进入灾点或完成救援。',
    pathLengthM: distanceM,
    speedMps,
    status: 'dispatched',
    progress: 0,
    position: [...origin],
    remainingS: distanceM / speedMps,
    dispatchedAt: at,
    arrivedAt: null,
  }
  s.responders.push(responder)
  pushEvent(engine, 'responder_dispatched', `${responder.name} 从${responder.originName}出动，沿模拟外部直线以假设 80 km/h 前往${targetName}（非真实导航，不改变志愿者物资派单）`, { message: '消防演练出动' }, { responderIds: [responder.id] }, at)
}

function stepResponders(engine: Engine): void {
  for (const responder of engine.state.responders) {
    if (responder.status === 'arrived') continue
    const durationS = responder.pathLengthM / responder.speedMps
    const elapsedS = Math.max(0, engine.state.clock.t - responder.dispatchedAt)
    responder.remainingS = Math.max(0, durationS - elapsedS)
    // 从出动时刻计算，不能给本时间片中途出动的单元多算一个完整 dt，也不再乘 UI 倍速。
    responder.progress = durationS > 0 ? Math.min(1, elapsedS / durationS) : 1
    if (responder.remainingS <= 1e-9) {
      responder.remainingS = 0
      responder.progress = 1
      responder.position = [...responder.target]
      responder.status = 'arrived'
      responder.arrivedAt = responder.dispatchedAt + durationS
      pushEvent(engine, 'responder_arrived', `${responder.name} 已到达${responder.targetName}，等待现场处置；仅代表到达集结点，灾情未解除，不代表救援成功`, { message: '消防到达集结点，灾情未解除' }, { responderIds: [responder.id] }, responder.arrivedAt)
    } else {
      responder.position = pointAtFraction(responder.path, responder.progress)
    }
  }
}

// ---------------------------------------------------------------------------
// Agent 推进
// ---------------------------------------------------------------------------

function stepAgents(engine: Engine, dt: number): void {
  const s = engine.state
  for (const planId of Object.values(s.assignments)) {
    const plan = s.plans[planId]
    if (!plan || plan.phase === 'delivered') continue
    const task = s.tasks.find((t) => t.id === plan.taskId)
    if (!task) continue
    const agent = s.agents.find((a) => a.id === plan.agentId)
    if (!agent) continue
    if (plan.phase === 'blocked') continue // 确认前原地等待

    switch (plan.phase) {
      case 'external_enroute': {
        const ext = plan.legs.external
        if (!ext) {
          plan.phase = 'handover_wait'
          plan.progress = 0
          break
        }
        plan.progress = Math.min(1, plan.progress + dt / externalTravelSeconds(ext.durationS))
        if (plan.progress >= 1) {
          plan.pickupAt = s.clock.t
          plan.phase = 'pickup_wait'
          plan.progress = 0
          plan.legs.external = { ...ext, status: 'pickup_pending' }
          pushEvent(engine, 'agent_pickup', `${agent.name} 到达 ${ext.pharmacy.name} 取货（演练库存），随后前往社区接驳点`, { message: '取货' }, {
            agentIds: [agent.id],
            taskIds: [task.id],
          })
        }
        break
      }
      case 'pickup_wait': {
        plan.progress = Math.min(1, plan.progress + dt / PICKUP_WAIT_S)
        if (plan.progress >= 1) {
          plan.phase = 'handover_wait'
          plan.progress = 0
          if (plan.legs.external) {
            pushEvent(engine, 'supply_arrived', `${task.code} 物资抵达社区接入点`, { message: '物资抵达' }, { taskIds: [task.id], planId: plan.id })
          }
        }
        break
      }
      case 'handover_wait': {
        plan.progress = Math.min(1, plan.progress + dt / HANDOVER_WAIT_S)
        if (plan.progress >= 1) {
          plan.relayAt = s.clock.t
          if (!plan.legs.internal) {
            finishPlan(engine, plan, task, agent)
            break
          }
          plan.phase = 'delivering'
          plan.progress = 0
          plan.legs.internal = { ...plan.legs.internal, status: 'delivering' }
          if (plan.legs.external) plan.legs.external = { ...plan.legs.external, status: 'handover_pending' }
          const carrier = s.agents.find((a) => a.id === plan.carryAgentId) ?? agent
          pushEvent(
            engine,
            'agent_relay',
            plan.relay
              ? `接力：${agent.name} 在 ${plan.legs.internal.enterGate} 交接，内部 ${carrier.name} 沿内部路网前往 ${task.targetName}`
              : `${agent.name} 在 ${plan.legs.internal.enterGate} 完成交接，沿内部路网前往 ${task.targetName}`,
            { message: '从接驳点出发' },
            { agentIds: [agent.id, carrier.id], taskIds: [task.id] },
          )
        }
        break
      }
      case 'delivering': {
        const int = plan.legs.internal
        if (!int) {
          finishPlan(engine, plan, task, agent)
          break
        }
        plan.progress = Math.min(1, plan.progress + dt / Math.max(1, int.durationS))
        if (plan.progress >= 1) finishPlan(engine, plan, task, agent)
        break
      }
      default:
        break
    }
  }
}

function finishPlan(engine: Engine, plan: Plan, task: Task, agent: Agent): void {
  const s = engine.state
  plan.phase = 'delivered'
  plan.progress = 1
  plan.deliveredAt = s.clock.t
  if (plan.legs.internal) plan.legs.internal = { ...plan.legs.internal, status: 'delivered' }
  if (plan.legs.external) plan.legs.external = { ...plan.legs.external, status: 'delivered' }
  if (plan.pharmacyId) consumeStock(s, plan.pharmacyId, task)
  const slaMet = s.clock.t <= task.slaAt
  s.record.results.push({ at: s.clock.t, taskId: task.id, planId: plan.id, status: 'delivered', slaMet })
  const carrier = s.agents.find((a) => a.id === plan.carryAgentId) ?? agent
  carrier.restingAt = undefined
  pushEvent(
    engine,
    'agent_delivered',
    `${carrier.name} 送达 ${task.targetName}（${task.need.qty} 份 ${task.need.item}）${slaMet ? '，满足时限' : '，超出时限'}`,
    { message: '送达' },
    { agentIds: [agent.id], taskIds: [task.id] },
  )
}

function consumeStock(s: DrillState, pharmacyId: string, task: Task): void {
  const inv = s.inventory[pharmacyId]
  if (!inv) return
  const key = inv.stock[task.need.item] !== undefined ? task.need.item : task.need.item.split(' + ')[0]
  const before = inv.stock[key] ?? 0
  inv.stock = { ...inv.stock, [key]: Math.max(0, before - task.need.qty) }
  s.record.inventory.push({ at: s.clock.t, pharmacyId, item: key, delta: -(before - inv.stock[key]), left: inv.stock[key] })
}

export function agentPosition(engine: Engine, plan: Plan): { lngLat: LngLat; leg: 'external' | 'internal' | 'waiting' | 'done' } {
  const ext = plan.legs.external
  const int = plan.legs.internal
  if (plan.phase === 'external_enroute' && ext?.path.length) return { lngLat: pointAtFraction(ext.path, plan.progress), leg: 'external' }
  if (plan.phase === 'pickup_wait' && ext?.path.length) return { lngLat: ext.path[ext.path.length - 1], leg: 'external' }
  if ((plan.phase === 'delivering' || plan.phase === 'handover_wait') && int)
    return { lngLat: pointAtFraction(int.path, plan.phase === 'handover_wait' ? 0 : plan.progress), leg: 'internal' }
  if (plan.phase === 'blocked') {
    const carrier = engine.state.agents.find((a) => a.id === plan.carryAgentId)
    return { lngLat: carrier?.restingAt ?? restingPoint(engine, plan), leg: 'waiting' }
  }
  if (plan.phase === 'delivered' && int?.path.length) return { lngLat: int.path[int.path.length - 1], leg: 'done' }
  if (ext?.path.length) return { lngLat: ext.path[0], leg: 'external' }
  return { lngLat: engine.view.model.center, leg: 'waiting' }
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

export function pushEvent(engine: Engine, kind: EventKind, message: string, payload: SimEvent['payload'], refs?: SimEvent['refs'], at: SimTime = engine.state.clock.t): SimEvent {
  const ev: SimEvent = { id: uid('ev'), at, kind, payload, message, refs }
  engine.state.events.push(ev)
  engine.state.record.events.push(ev)
  return ev
}

// ---------------------------------------------------------------------------
// 候选与确认
// ---------------------------------------------------------------------------

function latestClosure(s: DrillState): { roadId: string; at: SimTime } | null {
  const list = Object.values(s.closures).sort((a, b) => a.at - b.at)
  const ev = list[list.length - 1]
  return ev ? { roadId: ev.roadId, at: ev.at } : null
}

export interface KeepOriginalSummary {
  feasible: boolean
  detail: string
}

export interface CompareSummary {
  eventId: string
  snapshot: string
  policy: Candidate
  keepOriginal: KeepOriginalSummary
  affected: number
  feasible: number
  taskChecks: BuildResult['taskChecks']
}

export interface ProposeResult {
  ok: boolean
  planSetId: string | null
  message: string
  affected: number
  feasible: number
  comparison: CompareSummary | null
}

export interface ProposeOptions {
  ranker?: CandidateRanker
  eventAt?: SimTime
  rerank?: boolean
}

async function internalPropose(engine: Engine, ev: { refId: string; kind: 'road' | 'door' | 'staging'; at: SimTime }): Promise<ProposeResult> {
  const state = engine.state
  try {
    return await planIncident(engine, ev)
  } catch (error) {
    if (engine.state === state) {
      engine.planning = { stage: 'error', at: state.clock.t, detail: '候选生成失败，可在判据面板重试' }
      await engine.onPlanning?.(false)
    }
    throw error
  }
}

async function planIncident(engine: Engine, ev: { refId: string; kind: 'road' | 'door' | 'staging'; at: SimTime }): Promise<ProposeResult> {
  const s = engine.state
  const event = evidenceFor(engine, ev)
  const now = s.clock.t
  const blocked = currentBlocked(engine)
  const relays = relayOptionsFor(engine.view.router, blocked)
  const affected = affectedTasks(engine, blocked)
  const publish = async (stage: NonNullable<Engine['planning']>['stage'], detail: string): Promise<void> => {
    if (engine.state !== s) return
    engine.planning = { stage, detail, at: now }
    await engine.onPlanning?.(stage !== 'ready' && stage !== 'error')
  }
  await publish('impact', `核对 ${blocked.roads.size} 段封路与 ${blocked.verts.size} 个受阻节点，发现 ${affected.length} 项受影响任务`)
  if (!affected.length) {
    await publish('ready', '未发现受阻的物资任务，保留原派单')
    pushEvent(engine, 'note', '灾情发生后没有受影响的派单：相关任务的路线不受影响，保持原安排', { message: '无需改派' }, ev.kind === 'road' ? { roadIds: [ev.refId] } : {})
    return { ok: true, planSetId: null, message: '封路后没有受影响的派单', affected: 0, feasible: 0, comparison: null }
  }
  await publish('routes', `为 ${affected.length} 项任务搜索替代路径和交接点，校验通行、运力、库存与时限`)
  const result = await buildCandidates({
    state: s,
    model: engine.view.model,
    router: engine.view.router,
    provider: engine.provider,
    now,
    event,
    tasks: affected,
    blocked,
    relays,
    cache: engine.cache,
  })
  await publish('rank', `核对 ${result.candidates.length} 个候选，对可行方案排序`)
  const ranked = await engine.ranker.rank({ task: affected[0] ?? null, candidates: result.candidates, now, disaster: s.disaster })
  if (engine.state !== s) return { ok: false, planSetId: null, message: '演练已更换', affected: 0, feasible: 0, comparison: null }
  const candidates = orderCandidates(result.candidates, ranked.order, ranked.scores)
  const policy = policyCandidate(engine, event, affected, blocked)
  const keepOriginal = describeKeepOriginal(engine, affected, blocked, policy)
  const planSetId = `ps:${ev.refId}#${Math.round(ev.at)}`
  s.planSets[planSetId] = {
    id: planSetId,
    eventId: `${ev.refId}@${ev.at}`,
    taskId: affected[0]?.id ?? '',
    at: now,
    snapshot: result.snapshotText,
    candidates,
    rankingMode: ranked.mode,
    rankingNote: ranked.explanation,
    confirmedCandidateId: null,
    confirmedAt: null,
    confirmedBy: null,
    aiStatus: 'disabled',
  }
  s.record.snapshots.push({
    at: now,
    label: result.snapshotText,
    planId: null,
    changedRoads: ev.kind === 'road' ? [ev.refId] : [],
    changedBuildings: [],
    eventIds: s.events.filter((e) => e.kind === 'road_closed').map((e) => e.id),
  })
  const feasible = candidates.filter((c) => c.feasible).length
  pushEvent(
    engine,
    'candidates_proposed',
    `候选生成：受影响任务 ${affected.length} 项，可行候选 ${feasible} 个（共 ${candidates.length} 个），等待指挥员确认`,
    { message: `候选 ${candidates.length} 个` },
    ev.kind === 'road' ? { roadIds: [ev.refId], taskIds: affected.map((t) => t.id) } : { taskIds: affected.map((t) => t.id) },
  )
  await publish('ready', `${feasible}/${candidates.length} 个候选可行${feasible ? '，等待指挥员确认' : '，暂无可行改派'}`)
  return {
    ok: true,
    planSetId,
    message: `已生成 ${candidates.length} 个候选（可行 ${feasible} 个）`,
    affected: affected.length,
    feasible,
    comparison: { eventId: `${ev.refId}@${ev.at}`, snapshot: result.snapshotText, policy, keepOriginal, affected: affected.length, feasible, taskChecks: result.taskChecks },
  }
}

function orderCandidates(list: Candidate[], order: string[], scores: Record<string, number>): Candidate[] {
  const seq = order.length ? order : list.map((c) => c.id)
  const out: Candidate[] = []
  for (const id of seq) {
    const c = list.find((x) => x.id === id)
    if (c && !out.find((x) => x.id === c.id)) out.push({ ...c, score: scores[id] ?? c.score, rank: out.length + 1 })
  }
  for (const c of list) if (!out.find((x) => x.id === c.id)) out.push({ ...c, rank: out.length + 1 })
  return out
}

/** 指挥员手动生成 / 重排候选（例如录入库存、调整接驳点之后） */
export async function proposeCandidates(engine: Engine, opts: ProposeOptions = {}): Promise<ProposeResult> {
  const s = engine.state
  const ev = opts.eventAt !== undefined ? Object.values(s.closures).find((c) => c.at === opts.eventAt) : latestClosure(s)
  if (!ev && !Object.keys(s.blockedDoors).length && !Object.keys(s.blockedStaging).length) {
    return { ok: false, planSetId: null, message: '还没有灾情影响事件，暂无需改派', affected: 0, feasible: 0, comparison: null }
  }
  if (!ev) {
    const doorEv = Object.values(s.blockedDoors)[0] ?? Object.values(s.blockedStaging)[0]
    const refKind: 'door' | 'staging' = Object.values(s.blockedDoors).length ? 'door' : 'staging'
    return await internalPropose(engine, { refId: doorEv.targetId, kind: refKind, at: doorEv.at })
  }
  const key = `ps:${ev.roadId}#${Math.round(ev.at)}`
  const existing = s.planSets[key]
  if (existing && opts.rerank && opts.ranker) await rankPlanSet(engine, key, opts.ranker)
  if (existing) {
    const blocked = currentBlocked(engine)
    const affected = affectedTasks(engine, blocked)
    const policy = policyCandidate(engine, s.closures[ev.roadId], affected, blocked)
    return {
      ok: true,
      planSetId: key,
      message: opts.rerank ? '已按新的排序策略重排' : '候选已就绪',
      affected: affected.length,
      feasible: existing.candidates.filter((c) => c.feasible).length,
      comparison: {
        eventId: existing.eventId,
        snapshot: existing.snapshot,
        policy,
        keepOriginal: describeKeepOriginal(engine, affected, blocked, policy),
        affected: affected.length,
        feasible: existing.candidates.filter((c) => c.feasible).length,
        taskChecks: [],
      },
    }
  }
  return internalPropose(engine, { refId: ev.roadId, kind: 'road', at: ev.at })
}

export async function rankPlanSet(engine: Engine, planSetId: string, ranker: CandidateRanker): Promise<void> {
  const s = engine.state
  const ps = s.planSets[planSetId]
  if (!ps) return
  const task = s.tasks.find((t) => t.id === ps.taskId) ?? null
  const ranked = await ranker.rank({ task, candidates: ps.candidates, now: ps.at, disaster: s.disaster })
  ps.candidates = orderCandidates(ps.candidates, ranked.order, ranked.scores)
  ps.rankingMode = ranked.mode
  ps.rankingNote = ranked.explanation
}

function describeKeepOriginal(engine: Engine, affected: Task[], blocked: BlockedSets, policy: Candidate): KeepOriginalSummary {
  const s = engine.state
  const names = affected.map((t) => t.title).join('、')
  const crossed = affected.filter((t) => {
    const plan = s.plans[s.assignments[t.id]]
    return plan ? planRoads(engine, plan).some((r) => blocked.roads.has(r) || Boolean(s.closures[r])) : false
  })
  if (crossed.length) {
    return {
      feasible: false,
      detail: `保持原方案：${names} 的派单路线经过封闭路段，受阻 Agent 原地等待时演练模型不会退水；可达性校验不通过，无法按时送达`,
    }
  }
  return {
    feasible: false,
    detail: `保持原方案：${names} 需等待封闭路段恢复通行，预计 ${Math.round(policy.eta[0] / 60)} 分钟后才有机会送达，超过 ${affected[0]?.deadlineLabel ?? '时限'}`,
  }
}

/** 默认规则策略（不依赖指挥员）：全部按原安排等待，作为对照基线 */
function policyCandidate(engine: Engine, event: import('./types.ts').RoadClosureEvidence, tasks: Task[], blocked: BlockedSets): Candidate {
  const s = engine.state
  const internalAgent = s.agents.find((a) => a.role === 'internal')
  const task = tasks[0]
  const relays = relayOptionsFor(engine.view.router, blocked)
  const relay = relays[0]
  const route =
    task && relay
      ? engine.view.router.route(relay.lngLat, engine.view.model.buildings.find((b) => b.id === task.targetBuildingId)?.center ?? engine.view.model.center, {
          targetNodeKey: `entrance:${task.targetBuildingId}`,
          blocked: blocked.verts,
        })
      : null
  const waitS = 25 * 60
  const eta = s.clock.t + waitS + (route?.ok ? route.durationS : 0)
  return {
    id: 'policy:rules',
    eventId: `${event.roadId}@${event.at}`,
    kind: 'manual',
    title: '规则默认策略（不调整）',
    summary: `不改变外部安排，${internalAgent?.name ?? '内部 Agent'} 在 ${relay?.label ?? '接驳点'} 等待外部送达；需等水位回落`,
    taskId: task?.id ?? '',
    affects: tasks.map((t) => t.id),
    legs: { external: null, internal: null },
    eta: [eta],
    latestEta: eta,
    slackS: task ? task.slaAt - eta : 0,
    route: { polyline: route?.ok ? route.polyline : [], source: 'internal_astar' },
    external: null,
    internal: null,
    checks: [
      { id: 'wait', label: '等待水位回落', ok: false, detail: '演练模型在演练时长内不会退水，等待会超过时限' },
      { id: 'relay', label: '内部接力点', ok: Boolean(relay), detail: relay ? relay.label : '没有可用接驳点' },
    ],
    feasible: false,
    score: 0,
    reason: ['规则默认策略：不冒险改派，等待水位回落'],
    dispatchReason: '规则默认：等待水位回落',
    rank: 0,
    agentId: internalAgent?.id ?? '',
    isRelay: true,
    keepsAssignment: true,
  }
}

export interface ConfirmResult {
  ok: boolean
  message: string
  planId?: string
}

/** 指挥员确认：候选 → 正式派单。确认前不改派。 */
export function confirmCandidate(engine: Engine, planSetId: string, candidateId: string, by = '指挥员'): ConfirmResult {
  const s = engine.state
  const ps = s.planSets[planSetId]
  if (!ps) return { ok: false, message: '候选集不存在' }
  const cand = ps.candidates.find((c) => c.id === candidateId)
  if (!cand) return { ok: false, message: '候选不存在' }
  if (!cand.feasible) return { ok: false, message: '不可行的候选不能确认，请查看缺项条件' }
  const task = s.tasks.find((t) => t.id === cand.taskId)
  if (!task) return { ok: false, message: '任务不存在' }
  const prevId = s.assignments[task.id]
  const prev = prevId ? s.plans[prevId] : undefined
  // 最终规则校验：确认时刻新路线不得经过任何已封闭路段
  const blocked = currentBlocked(engine)
  const crossing = (cand.internal?.roadIds ?? []).filter((r) => blocked.roads.has(r))
  if (crossing.length) return { ok: false, message: `候选路线经过已封闭路段（${crossing.map((r) => roadName(engine, r)).join('、')}），请重新生成候选` }
  const agent = s.agents.find((a) => a.id === cand.agentId)
  const carryAgentId = cand.isRelay ? s.agents.find((a) => a.role === 'internal')?.id ?? cand.agentId : cand.agentId
  const plan: Plan = {
    id: `${cand.id}@v${(prev?.version ?? 0) + 1}`,
    version: (prev?.version ?? 0) + 1,
    taskId: cand.taskId,
    agentId: cand.agentId,
    agentName: agent?.name ?? cand.agentId,
    carryAgentId,
    relay: cand.isRelay,
    carry: cand.isRelay ? 'internal' : 'external',
    pharmacyId: cand.external?.pharmacy.id ?? null,
    origin: 'reconfirmed',
    createdBy: 'commander',
    rationale: cand.dispatchReason,
    legs: {
      external: cand.legs.external ? { ...cand.legs.external, status: 'planned' } : null,
      internal: cand.legs.internal ? { ...cand.legs.internal, status: 'planned' } : null,
    },
    networkVersion: engine.view.model.updatedAt,
    confirmedAt: s.clock.t,
    phase: cand.legs.external ? 'external_enroute' : 'handover_wait',
    progress: 0,
    blockedRoadId: null,
    deliveredAt: null,
    pickupAt: null,
    relayAt: null,
    eta: cand.eta,
    risk: cand.slackS >= 0 ? 'on_time' : 'late',
    riskNote: `${cand.slackS >= 0 ? '满足时限' : '超出时限'}，余量 ${(cand.slackS / 60).toFixed(1)} 分钟`,
  }
  s.plans[plan.id] = plan
  s.assignments[task.id] = plan.id
  if (prev) {
    prev.supersededBy = plan.id
    s.superseded.push(prev.id)
  }
  for (const a of s.agents) if (plan.agentId === a.id || plan.carryAgentId === a.id) a.restingAt = undefined
  ps.confirmedCandidateId = candidateId
  ps.confirmedAt = s.clock.t
  ps.confirmedBy = by
  s.record.confirmations.push({ at: s.clock.t, planSetId, candidateId, by, note: cand.dispatchReason })
  s.record.plans.push(plan)
  s.record.snapshots.push({ at: s.clock.t, label: `确认：${cand.title}`, planId: plan.id, changedRoads: [], changedBuildings: [], eventIds: [] })
  pushEvent(engine, 'plan_confirmed', `指挥员确认改派：${cand.title}（任务 ${task.code} ${task.targetName}）`, { planId: plan.id }, {
    taskIds: [task.id],
    agentIds: [plan.agentId, plan.carryAgentId],
  })
  pushEvent(engine, 'agent_assigned', `${plan.agentName} 接受新派单，按候选路线执行`, { message: '接单' }, { agentIds: [plan.agentId], taskIds: [task.id] })
  return { ok: true, message: '已确认并下发', planId: plan.id }
}

export function affectedTasks(engine: Engine, blocked: BlockedSets): Task[] {
  const s = engine.state
  const out: Task[] = []
  for (const [taskId, planId] of Object.entries(s.assignments)) {
    const plan = s.plans[planId]
    if (!plan || plan.phase === 'delivered') continue
    const task = s.tasks.find((t) => t.id === taskId)
    if (!task) continue
    const hit = plan.blockedRoadId ?? planRoads(engine, plan).find((r) => blocked.roads.has(r))
    const doorKey = plan.legs.internal?.targetDoor
    const doorBlocked = doorKey ? Boolean(s.blockedDoors[doorKey]) : false
    const stagingBlocked = plan.legs.internal ? Boolean(s.blockedStaging[plan.legs.internal.enterGate]) : false
    if (hit || doorBlocked || stagingBlocked) out.push(task)
  }
  return out
}

// ---------------------------------------------------------------------------
// 初始化 / 重置
// ---------------------------------------------------------------------------

export function createEngine(opts: EngineOptions): Engine {
  const config = configFromSeed(opts.seed, opts.startLabel ?? '08:00', opts.startMs ?? Date.now())
  if (opts.durationS) config.durationS = opts.durationS
  config.untilAllEvacuated = opts.untilAllEvacuated
  config.continueAfterEvacuation = opts.continueAfterEvacuation
  const model = cloneCommunity(opts.community)
  const router = new CommunityRouter(model)
  const tasks = deriveTasks(model, opts.seed)
  const agents = deriveAgents(model, opts.seed, config)
  const inventory: Record<string, InventoryPoint> = {}
  for (const p of opts.pharmacies) inventory[p.id] = { ...p, stock: { ...p.stock } }

  const state: DrillState = {
    id: uid('drill'),
    tick: 0,
    clock: { t: 0, running: false, speed: 4, startMs: config.startMs, startLabel: config.startLabel },
    config,
    status: 'running',
    disaster: opts.disaster ?? 'flood',
    communityVersion: model.updatedAt,
    communityName: model.name,
    closures: {},
    impacts: {},
    blockedDoors: {},
    blockedStaging: {},
    depths: {},
    inventory,
    tasks,
    agents,
    responders: [],
    evacuation: [],
    assignments: {},
    plans: {},
    planSets: {},
    superseded: [],
    events: [],
    record: { seed: opts.seed, startedAt: new Date().toISOString(), events: [], plans: [], confirmations: [], snapshots: [], results: [], inventory: [] },
    snapshotAt: 0,
    dataMode: { map: 'fallback', lbs: opts.provider.kind, ai: 'off' },
  }
  const emptyBundle: DisasterBundle = {
    plan: { kind: state.disaster, events: [], scenario: { id: 'pending', title: '', summary: '', fixedInputs: [] }, hazardsAt: () => [] },
    flood: null,
  }
  const engine: Engine = { state, view: { model, router }, flood: { segments: [], thresholdM: config.depthThresholdM, closures: [] }, disaster: emptyBundle, fireVariant: opts.fireVariant, seed: opts.seed, cache: new Map(), ranker: opts.ranker, provider: opts.provider, pendingProposals: [] }
  seedBaselinePlans(engine)

  // 先有派单，再定积水：让内涝封在“主任务正在走的那条主动脉”上，
  // 这样封路事件一定影响真实派单，改派才有意义；其余道路保持可用。
  // ---- 灾情：三种灾种共用 planDisaster，只是影响事件来源不同 ----
  const roadPoints = model.net.roads.map((r) => ({ id: r.id, points: roadPointsLocal(router, r.points) }))
  const disasterKind: DisasterKind = opts.disaster ?? 'flood'
  let affectedTask = pickAffectedTask(engine)
  let quakeAffected: Task | null = null
  let floodTarget: string | null = null
  let fireIgnition: string | undefined
  let quakeRoads: string[] = []
  let quakeStaging: string | null = null

  if (disasterKind === 'flood') {
    floodTarget = pickFloodTarget(engine)
  } else if (disasterKind === 'fire') {
    fireIgnition = affectedTask?.targetBuildingId ?? model.buildings[0].id
  } else {
    // 地震：联合挑选“受灾任务 + 断裂路段 + 要作废的接驳点”
    const scenario = chooseQuakeScenario(engine)
    quakeRoads = scenario.roads
    quakeStaging = nearestStagingId(model, scenario.affected?.targetBuildingId)
    quakeAffected = scenario.affected
  }

  if (disasterKind === 'earthquake' && quakeAffected) affectedTask = quakeAffected

  const buildBundle = (): DisasterBundle => {
    if (opts.modelRun) {
      // 模型算例：事件来自求解器输出 + 独立演练规则，灾种由算例决定
      engine.modelRun = opts.modelRun
      return { plan: planModelDisaster(opts.modelRun), flood: null }
    }
    return planDisaster({
      kind: disasterKind,
      model,
      config,
      floodTargetRoadId: floodTarget,
      fireIgnitionBuildingId: fireIgnition,
      fireVariant: opts.fireVariant,
      quakeRupturedRoadIds: quakeRoads,
      quakeBlockedStagingId: quakeStaging,
      roadPoints,
    })
  }

  engine.disaster = buildBundle()
  engine.flood = engine.disaster.flood ?? { segments: [], thresholdM: config.depthThresholdM, closures: [] }

  // 校验：到演练结束时，受影响任务的目标入口仍然可达 —— 否则这个场景只能演示“无可行路线”，
  // 需要主动收缩灾情范围（火灾先去掉路段封闭，地震逐个减少断路点），保证默认场景有可行改派。
  //
  // 专业模型算例例外：灾情是求解器输出 + 独立演练规则的固定结果，不能为了“凑出可行方案”
  // 去改它（那就不是模型回放了）。若确实没有可行候选，就如实呈现“无可行方案”。
  if (!opts.modelRun && affectedTask && disasterKind === 'earthquake') {
    // 优先换一个不挡路的接驳点：这样“多点中断”不会被裁成一处
    const stagingOptions = [quakeStaging, ...model.net.staging.map((s) => s.id).filter((id) => id !== quakeStaging)]
    let fixed = scenarioKeepsDoorReachable(engine, affectedTask)
    for (const st of stagingOptions) {
      if (fixed) break
      quakeStaging = st
      engine.disaster = buildBundle()
      fixed = scenarioKeepsDoorReachable(engine, affectedTask)
    }
  }
  if (!opts.modelRun && affectedTask && disasterKind !== 'flood') {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (scenarioKeepsDoorReachable(engine, affectedTask)) break
      if (disasterKind === 'fire') {
        // 去掉“路段封闭”这一条，只保留入口被烟雾覆盖
        engine.disaster = planDisaster({
          kind: disasterKind, model, config, fireIgnitionBuildingId: fireIgnition, fireVariant: opts.fireVariant,
          floodTargetRoadId: null, quakeRupturedRoadIds: [], quakeBlockedStagingId: null, roadPoints,
        })
        break
      }
      quakeRoads = quakeRoads.slice(0, Math.max(0, quakeRoads.length - 1))
      engine.disaster = buildBundle()
    }
  }
  pushEvent(engine, 'sim_started', `演练开始：${model.name}，${tasks.length} 项任务按原方案派出（全部为演练数据）`, { message: '开始' })
  return engine
}

/**
 * 选一条“值得封”的路段。
 *
 * 好的封路目标要同时满足两件事：
 *  1. 它确实被某条在途派单经过 —— 否则不会产生受影响任务，改派无从谈起；
 *  2. 封掉它之后，每栋楼的入口仍然能从某个未封的大门走到 —— 否则候选全部不可行，
 *     指挥员只能看着任务停在原地。
 *
 * 因此这里不是随便挑一条，而是逐条试算连通性；优先选择让受影响任务数适中的那条，
 * 这样既能演示改派，又能演示“无关任务不变”。
 */
function pickFloodTarget(engine: Engine): string | null {
  const s = engine.state
  const view = engine.view
  const roads = view.model.net.roads
  const gates = view.model.net.gates
    .map((g) => view.router.gateVertex(g.id))
    .filter((v): v is string => Boolean(v))
  if (!gates.length || !roads.length) return null

  /** 当前在途派单经过的路段 */
  const usedByPlans = new Map<string, number>()
  for (const planId of Object.values(s.assignments)) {
    const plan = s.plans[planId]
    if (!plan) continue
    for (const roadId of planRoads(engine, plan)) usedByPlans.set(roadId, (usedByPlans.get(roadId) ?? 0) + 1)
  }
  if (!usedByPlans.size) return null

  /** 封掉某条路后，所有楼栋入口是否仍可达 */
  const stillConnected = (roadId: string): boolean => {
    const blockedRoads = new Set([roadId])
    for (const b of view.model.buildings) {
      const goal = view.router.verts.byNode.get(`entrance:${b.id}`)?.id
      if (!goal) return false
      const res = view.router.router.shortest(gates, [goal], new Set(), blockedRoads)
      if (!res.pathVertices.length) return false
    }
    return true
  }

  const roadLength = (roadId: string): number => {
    const road = roads.find((r) => r.id === roadId)
    if (!road || road.points.length < 2) return 0
    let len = 0
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]
      const b = road.points[i]
      const la = Array.isArray(a) ? a : [a.lng, a.lat]
      const lb = Array.isArray(b) ? b : [b.lng, b.lat]
      len += haversine([la[0], la[1]], [lb[0], lb[1]])
    }
    return len
  }

  const candidates = [...usedByPlans.entries()]
    .map(([roadId, hits]) => ({ roadId, hits, len: roadLength(roadId), name: roads.find((r) => r.id === roadId)?.name ?? '' }))
    // 优先那些“只有部分派单经过”的路段：受影响任务少，其余任务保持原安排
    .sort((a, b) => a.hits - b.hits || b.len - a.len)

  for (const c of candidates) {
    if (stillConnected(c.roadId)) return c.roadId
  }
  // 全都会割断路网时，退回最长的主动脉（至少保证事件可解释）
  const fallback = candidates.sort((a, b) => b.len - a.len)[0]
  return fallback?.roadId ?? null
}

/**
 * 为地震挑选「受灾任务 + 断裂路段」。
 *
 * 约束（按优先级）：
 *  1. 断裂要切断该楼栋的正门通路、但**备用入口仍可达** —— 这样改派是“换入口/换接驳点”，
 *     而不是把楼栋彻底孤立；
 *  2. 每发生一次断裂（按固定延迟先后），都必须至少还有一个入口可达，
 *     否则中途会出现“瞬间不可达”，候选就全是不可行的；
 *  3. 优先切断只被这一个任务使用的支线路段，避免把无关任务一起打断
 *     （验收要求：无关任务的派单与版本必须保持不变）；
 *  4. 至少两处断裂，才叫“多点中断”。
 */
function chooseQuakeScenario(engine: Engine): { affected: Task | null; roads: string[] } {
  const s = engine.state
  const router = engine.view.router
  const model = engine.view.model
  const tasks = s.tasks.filter((t) => s.assignments[t.id])
  const routes = tasks.map((t) => ({ taskId: t.id, roads: planRoads(engine, s.plans[s.assignments[t.id]]) }))
  const usage = new Map<string, number>()
  for (const r of routes) for (const road of r.roads) usage.set(road, (usage.get(road) ?? 0) + 1)

  // 规划器生成候选时从“第一个可用大门”进入，场景校验必须用同一个入口，否则会挑出
  // 规划器实际走不通的断裂组合（表面可行、实际全不可行）。
  const gateStarts = model.net.gates.map((g) => router.gateVertex(g.id)).filter((v): v is string => Boolean(v))
  const starts = gateStarts.length ? [gateStarts[0]] : []
  const doorReach = (buildingId: string, closed: Set<string>): { primary: boolean; alt: boolean } => {
    const primary = router.verts.byNode.get(`entrance:${buildingId}`)?.id
    const alt = router.verts.byNode.get(`entranceAlt:${buildingId}`)?.id
    const ok = (goal: string | undefined): boolean =>
      Boolean(goal) && router.router.shortest(starts, [goal as string], new Set(), closed).pathVertices.length > 0
    return { primary: ok(primary), alt: ok(alt) }
  }

  // 第一项任务留作“无关任务”，从第二项开始找受灾任务
  const order = [...tasks.slice(1), ...tasks.slice(0, 1)]
  for (const task of order) {
    const roads = routes.find((r) => r.taskId === task.id)?.roads ?? []
    const ordered = [...new Set(roads)]
      .filter((r) => r.startsWith('road-') || r.startsWith('access:'))
      .sort((a, b) => (usage.get(a) ?? 1) - (usage.get(b) ?? 1) || roadLengthM(model, b) - roadLengthM(model, a))
    if (!ordered.length) continue

    const combos: string[][] = []
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        combos.push([ordered[i], ordered[j]])
        for (let k = j + 1; k < ordered.length; k++) combos.push([ordered[i], ordered[j], ordered[k]])
      }
    }
    combos.sort((a, b) => {
      const ua = a.reduce((acc, r) => acc + (usage.get(r) ?? 1), 0)
      const ub = b.reduce((acc, r) => acc + (usage.get(r) ?? 1), 0)
      return ua - ub || b.reduce((acc, r) => acc + roadLengthM(model, r), 0) - a.reduce((acc, r) => acc + roadLengthM(model, r), 0)
    })

    for (const combo of combos) {
      let ok = true
      for (let i = 1; i <= combo.length; i++) {
        const closed = new Set(combo.slice(0, i))
        const r = doorReach(task.targetBuildingId, closed)
        if (!r.primary && !r.alt) {
          ok = false
          break
        }
      }
      if (!ok) continue
      const fin = doorReach(task.targetBuildingId, new Set(combo))
      // 最后必须留着备用入口，且正门已被封（否则改派讲不通）
      if (!fin.alt || fin.primary) continue
      return { affected: task, roads: combo }
    }
  }
  return { affected: tasks[1] ?? tasks[0] ?? null, roads: [] }
}

/** 固定规则挑选“受影响任务”：优先选有派单、且不是第一项的任务，保证还有一条无关任务 */
function pickAffectedTask(engine: Engine): Task | null {
  const s = engine.state
  const withPlan = s.tasks.filter((t) => s.assignments[t.id])
  if (withPlan.length < 2) return withPlan[0] ?? null
  // 取第二项：第一项留作“无关任务”，验证增量改派时它必须保持不变
  return withPlan[1]
}

function roadLengthM(model: CommunityModel, roadId: string): number {
  const road = model.net.roads.find((r) => r.id === roadId)
  if (!road || road.points.length < 2) return 0
  let len = 0
  for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1]
    const b = road.points[i]
    const la = Array.isArray(a) ? a : [a.lng, a.lat]
    const lb = Array.isArray(b) ? b : [b.lng, b.lat]
    len += haversine([la[0], la[1]], [lb[0], lb[1]])
  }
  return len
}

function nearestStagingId(model: CommunityModel, buildingId: string | undefined): string | null {
  if (!model.net.staging.length) return null
  const b = model.buildings.find((x) => x.id === buildingId)
  if (!b) return model.net.staging[0].id
  let best = model.net.staging[0]
  let bestD = Infinity
  for (const st of model.net.staging) {
    const d = Math.hypot(st.lngLat[0] - b.center[0], st.lngLat[1] - b.center[1])
    if (d < bestD) {
      bestD = d
      best = st
    }
  }
  return best.id
}

/**
 * 场景校验：把全部影响事件叠加成“最坏情况”的不可通行集合，
 * 检查受影响任务的目标入口是否仍然可达（正门不行就用备用入口）。
 */
function scenarioKeepsDoorReachable(engine: Engine, task: Task): boolean {
  const s = engine.state
  const router = engine.view.router
  const closedRoads = new Set<string>()
  const doors = new Set<string>()
  const staging = new Set<string>()
  for (const ev of engine.disaster.plan.events) {
    if (!s.config.untilAllEvacuated && ev.at > s.config.durationS) continue
    if (ev.targetType === 'road' && ev.traffic === 'blocked') closedRoads.add(ev.targetId)
    if (ev.targetType === 'entrance' && ev.traffic === 'blocked') doors.add(ev.targetId)
    if (ev.targetType === 'staging' && ev.traffic === 'blocked') staging.add(ev.targetId)
  }
  const blocked = blockedSets(router, closedRoads, s.config.depthThresholdM, { doors: [...doors], staging: [...staging] })
  // 只要正门或备用入口里有一个还可达，这个场景就有可行改派；
  // 两个都不可达时才允许出现「当前无可行配送路线」（那是火灾 no_alt 变体要演示的情况）。
  const doorKeys = [`entrance:${task.targetBuildingId}`, `entranceAlt:${task.targetBuildingId}`]
  const goals = doorKeys.map((k) => router.verts.byNode.get(k)?.id).filter((v): v is string => Boolean(v))
  if (!goals.length) return false
  const gateVerts = engine.view.model.net.gates.map((g) => router.gateVertex(g.id)).filter((v): v is string => Boolean(v))
  const edgeGates = router.edgeGatePositions().map((g) => g.id)
  const starts = [...gateVerts, ...edgeGates].filter((v) => !blocked.verts.has(v))
  if (!starts.length) return false
  return goals.some((goal) => router.router.shortest(starts, [goal], blocked.verts, blocked.roads).pathVertices.length > 0)
}

function roadPointsLocal(router: CommunityRouter, points: import('../community/model.ts').RoadPoint[]): Array<{ x: number; y: number }> {
  const f = router.verts.frame
  return points.map((p) => {
    const lng = Array.isArray(p) ? p[0] : p.lng
    const lat = Array.isArray(p) ? p[1] : p.lat
    const v = router.verts.byNode.get(coordNodeId([lng, lat]))
    return v ? v.pos : { x: (lng - f.origin[0]) * f.mxPerDegLng, y: (lat - f.origin[1]) * f.myPerDegLat }
  })
}

/** 演练开始时锁定的社区快照（演练中编辑模型不会影响进行中的演练） */
export function cloneCommunity(model: CommunityModel): CommunityModel {
  const { localPoly } = localFrameFromFence(model.fence.polygon)
  return {
    ...model,
    fence: { ...model.fence, polygon: model.fence.polygon.map((p) => [p[0], p[1]] as LngLat), localVertices: localPoly.map((p) => ({ ...p })), areaM2: model.fence.areaM2 },
    buildings: model.buildings.map((b) => ({
      ...b,
      footprint: b.footprint.map((p) => ({ ...p })),
      local: { ...b.local, c: { ...b.local.c }, u: { ...b.local.u } },
      entrance: { ...b.entrance, doorPoint: { ...b.entrance.doorPoint }, doorLngLat: [b.entrance.doorLngLat[0], b.entrance.doorLngLat[1]] },
      center: [b.center[0], b.center[1]],
    })),
    net: {
      gates: model.net.gates.map((g) => ({ ...g, local: { ...g.local }, lngLat: [g.lngLat[0], g.lngLat[1]] as LngLat })),
      staging: model.net.staging.map((s) => ({ ...s, local: { ...s.local }, lngLat: [s.lngLat[0], s.lngLat[1]] as LngLat })),
      roads: model.net.roads.map((r) => ({
        ...r,
        points: r.points.map((p) => (Array.isArray(p) ? ([p[0], p[1]] as LngLat) : { lng: p.lng, lat: p.lat })),
      })),
    },
  }
}

function seedBaselinePlans(engine: Engine): void {
  const s = engine.state
  const model = engine.view.model
  const router = engine.view.router
  const externals = s.agents.filter((a) => a.role === 'external')
  const pharmacyList = Object.values(s.inventory).sort((a, b) => haversine(model.center, a.lngLat) - haversine(model.center, b.lngLat))
  const gate = model.net.gates[0]
  s.tasks.forEach((task, i) => {
    const agent = task.priority === 'high' ? externals[0] : externals[(i + 1) % Math.max(1, externals.length)]
    const pharmacy = pharmacyList[i % Math.max(1, pharmacyList.length)]
    if (!agent || !gate) return
    const target = model.buildings.find((b) => b.id === task.targetBuildingId)
    const intRoute = router.route(pharmacy?.lngLat ?? model.center, target?.center ?? model.center, {
      startGateId: gate.id,
      targetNodeKey: `entrance:${task.targetBuildingId}`,
    })
    const extPath: LngLat[] = agent.origin ? [agent.origin, pharmacy?.lngLat ?? model.center, gate.lngLat] : []
    const dist = pathLengthM(extPath)
    const plan: Plan = {
      id: `plan:baseline:${task.id}`,
      version: 1,
      taskId: task.id,
      agentId: agent.id,
      agentName: agent.name,
      carryAgentId: agent.id,
      relay: Boolean(intRoute.ok),
      carry: intRoute.ok ? 'internal' : 'external',
      pharmacyId: pharmacy?.id ?? null,
      origin: 'baseline',
      createdBy: 'system',
      rationale: '演练开始时的原派单（未考虑灾情）',
      legs: {
        external: pharmacy
          ? {
              pharmacy: { id: pharmacy.id, name: pharmacy.name, lngLat: pharmacy.lngLat, source: pharmacy.source },
              atGate: gate.id,
              path: extPath,
              durationS: dist / 7.2,
              distanceM: dist,
              routeSource: 'sample',
              routeNote: '基线外部段（演练估算，仅作基线对照）',
              status: 'planned',
            }
          : null,
        internal: intRoute.ok
          ? {
              path: intRoute.polyline,
              roadIds: intRoute.roadIds,
              durationS: intRoute.durationS,
              distanceM: intRoute.lengthM,
              enterGate: gate.name,
              targetBuildingId: task.targetBuildingId,
              stops: [],
              status: 'planned',
            }
          : null,
      },
      networkVersion: model.updatedAt,
      confirmedAt: 0,
      phase: 'external_enroute',
      progress: 0,
      blockedRoadId: null,
      deliveredAt: null,
      pickupAt: null,
      relayAt: null,
      eta: [dist / 7.2 + intRoute.durationS],
      risk: 'unknown',
      riskNote: '基线方案（封路前）',
    }
    s.plans[plan.id] = plan
    s.assignments[task.id] = plan.id
    s.record.plans.push(plan)
  })
}

/** 重置演练：保留同一个社区模型，回到 t=0 的初始状态（种子与封路序列固定） */
export function resetEngine(engine: Engine): void {
  const s = engine.state
  const speed = s.clock.speed
  const fresh = createEngine({
    community: engine.view.model,
    seed: engine.seed,
    startLabel: s.config.startLabel,
    startMs: s.config.startMs,
    pharmacies: Object.values(s.inventory).map((p) => ({ ...p, stock: { ...p.stock } })),
    provider: engine.provider,
    ranker: engine.ranker,
    durationS: s.config.durationS,
    untilAllEvacuated: s.config.untilAllEvacuated,
    continueAfterEvacuation: s.config.continueAfterEvacuation,
    disaster: s.disaster,
    fireVariant: engine.fireVariant,
    modelRun: engine.modelRun,
  })
  engine.state = fresh.state
  engine.flood = fresh.flood
  engine.disaster = fresh.disaster
  engine.cache = fresh.cache
  engine.pendingProposals = []
  engine.planning = undefined
  engine.state.clock.speed = speed
  engine.state.rescuePriority = s.rescuePriority
  engine.state.rescueTeams = s.rescueTeams
  pushEvent(engine, 'drill_reset', `演练已重置：回到 t=0 的初始状态（种子 ${engine.seed}，封路序列固定、可复现）`, { message: '重置' })
}

export function activePlanOf(state: DrillState, taskId: string): Plan | undefined {
  return state.plans[state.assignments[taskId]]
}

export function pendingPlanSets(state: DrillState): string[] {
  return Object.values(state.planSets)
    .filter((ps) => !ps.confirmedCandidateId)
    .map((ps) => ps.id)
}

export function floodedAt(engine: Engine): ReturnType<typeof floodedSegments> {
  return floodedSegments(engine.flood, engine.state.clock.t)
}

export { latestClosure }
