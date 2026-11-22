import type { LngLat } from '../geo/types.ts'
import type { CommunityModel } from '../community/model.ts'
import type {
  Agent,
  Candidate,
  CandidateKind,
  DrillState,
  ExternalLeg,
  InternalLeg,
  InventoryPoint,
  Plan,
  PlanLegs,
  RoadClosureEvidence,
  SimTime,
  Task,
} from '../sim/types.ts'
import type { ExternalLegProvider } from '../routing/external.ts'
import { CommunityRouter, type InternalRoute, type RouteOptions } from '../routing/internal.ts'
import { externalTravelSeconds, PICKUP_WAIT_S, HANDOVER_WAIT_S } from './deliveryTiming.ts'
import { externalLegOk } from '../routing/external.ts'
import { fromLocal } from '../community/frame.ts'
import { haversine } from '../geo/wgs84.ts'
import { stockOf } from '../sim/scenario.ts'

/**
 * 规则规划器。
 *
 * 职责：针对“某个封路事件 + 受影响任务”生成可比较的候选，逐个做规则校验
 * （可达性 / 库存 / 运力 / 时限 / 出入口），给出改派理由；不可行时说明缺哪项条件。
 * 它不会自动改派：确认由指挥员完成，排序交给可替换的 CandidateRanker。
 */

export interface RelayOption {
  key: string
  label: string
  lngLat: LngLat
  /** 该接驳点自身的水深（米） */
  depthM: number
}

export interface BlockedSets {
  /** 不可通行的图中顶点 */
  verts: Set<string>
  /** 不可通行的节点键（gate:/staging:/entrance:/x:lng,lat） */
  keys: Set<string>
  /** 被淹没的路段 ID */
  roads: Set<string>
}

/**
 * 封闭集合。
 *
 * 重要：被封路段的**端点不进入 verts**。
 * 端点往往同时是其它路段的交叉点，按顶点封闭会把整条主动脉一起切断，
 * 改派就永远不可行。真正的封路语义是“这条边不能走”。
 */
export function blockedSets(
  router: CommunityRouter,
  floodedRoadIds: Iterable<string>,
  thresholdM: number,
  extra?: { doors?: Iterable<string>; staging?: Iterable<string> },
): BlockedSets {
  const roads = new Set(floodedRoadIds)
  const blocked: BlockedSets = { verts: new Set<string>(), keys: new Set<string>(), roads }
  // 火灾/地震：入口或接驳点自身不可用时，把对应节点加入不可通行集合
  for (const key of extra?.doors ?? []) {
    const v = router.verts.byNode.get(key)
    if (v) blocked.verts.add(v.id)
  }
  for (const id of extra?.staging ?? []) {
    const v = router.verts.byNode.get(`staging:${id}`)
    if (v) blocked.verts.add(v.id)
  }
  // 只有接驳点 / 大门自身被淹时，才把该节点视为不可通行
  for (const s of router.model.net.staging) if ((s.depthM ?? 0) >= thresholdM) blocked.verts.add(`staging:${s.id}`)
  for (const g of router.model.net.gates) {
    if ((g.depthM ?? 0) >= thresholdM) {
      const v = router.gateVertex(g.id)
      if (v) blocked.verts.add(v)
    }
  }
  for (const key of blocked.verts) blocked.keys.add(key)
  return blocked
}

export function relayOptionsFor(router: CommunityRouter, blocked: BlockedSets): RelayOption[] {
  const out: RelayOption[] = []
  for (const s of router.model.net.staging) {
    const v = router.verts.byNode.get(`staging:${s.id}`)
    if (!v || blocked.verts.has(v.id)) continue
    if ((s.depthM ?? 0) >= 0.3) continue
    out.push({ key: v.id, label: s.name, lngLat: s.lngLat, depthM: s.depthM ?? 0 })
  }
  for (const g of router.edgeGatePositions()) {
    if (blocked.verts.has(g.id)) continue
    const reach = router.router.reachable([g.id], blocked.verts, blocked.roads)
    if (reach.size <= 1) continue
    out.push({ key: g.id, label: `围栏临时接驳点 ${g.id.replace('edgegate:', '#')}`, lngLat: fromLocal(router.verts.frame, g.pos), depthM: 0 })
  }
  return out
}

export function entranceVertexId(task: Task): string {
  return `entrance:${task.targetBuildingId}`
}

export function alternateEntranceId(task: Task): string {
  return `entranceAlt:${task.targetBuildingId}`
}

/**
 * 解析本任务实际可用的目标入口：
 * 正门可用就用正门；正门被封（火灾烟雾/地震）时退回备用入口；两个都不行返回 null。
 * 返回 null 时规划器会给出「当前无可行配送路线」及原因，而不是假装能送到。
 */
export function targetDoorKey(router: CommunityRouter, task: Task, blocked: Set<string>): string | null {
  const primaryKey = entranceVertexId(task)
  const primary = router.verts.byNode.get(primaryKey)
  if (primary && !blocked.has(primary.id)) return primaryKey
  const altKey = alternateEntranceId(task)
  const alt = router.verts.byNode.get(altKey)
  if (alt && !blocked.has(alt.id)) return altKey
  return null
}

/**
 * 通往目标楼栋的实际寻路：先试正门，正门在当前路网下走不通就改走备用入口。
 * 火灾是“入口被封”，地震是“入口没被封但唯一通路断了”——两种情况都必须在寻路层兜住，
 * 否则候选会全部不可行，界面只能说“无路线”。
 */
export function routeToTarget(
  router: CommunityRouter,
  from: LngLat,
  to: LngLat,
  opts: RouteOptions,
  task: Task,
): { route: InternalRoute; doorKey: string | null } {
  for (const key of [entranceVertexId(task), alternateEntranceId(task)]) {
    if (!router.verts.byNode.get(key)) continue
    const route = router.route(from, to, { ...opts, targetNodeKey: key })
    if (route.ok) return { route, doorKey: key }
  }
  const primary = router.route(from, to, { ...opts, targetNodeKey: entranceVertexId(task) })
  return { route: primary, doorKey: null }
}

/** 目标楼栋入口在当前路网下是否可达；返回每个接驳点的测试结果 */
export function reachability(
  router: CommunityRouter,
  task: Task,
  relays: RelayOption[],
  blocked: Set<string>,
): Array<{ relay: RelayOption; ok: boolean; path: string[] }> {
  const goals = [entranceVertexId(task), alternateEntranceId(task)]
    .map((k) => router.verts.byNode.get(k)?.id)
    .filter((v): v is string => Boolean(v) && !blocked.has(v as string))
  if (!goals.length) return []
  return relays.map((relay) => {
    const res = router.router.shortest([relay.key], goals, blocked)
    return { relay, ok: res.pathVertices.length > 0, path: res.pathVertices }
  })
}

export interface BuildOptions {
  state: DrillState
  model: CommunityModel
  router: CommunityRouter
  provider: ExternalLegProvider
  now: SimTime
  event: RoadClosureEvidence
  tasks: Task[]
  blocked: BlockedSets
  relays: RelayOption[]
  /** 记录“状态快照 → 可行候选 → 选中方案 → 执行结果”的过程文案 */
  cache?: Map<string, ExternalLeg>
}

export interface BuildResult {
  candidates: Candidate[]
  taskChecks: Array<{ taskId: string; taskTitle: string; feasible: boolean; reasons: string[] }>
  activePlans: Plan[]
  blockedGateName: string | null
  /** 状态快照：候选生成时使用的状态摘要（写入记录） */
  snapshotText: string
}

function snapshotTextOf(state: DrillState, event: RoadClosureEvidence, tasks: Task[], now: SimTime): string {
  // 只有内涝有“水深/阈值”这组概念；火灾是能见度、地震是受损等级，文案不能混用水深
  const basis =
    event.disaster === 'flood'
      ? `水深 ${event.depthM}m/${event.thresholdM}m`
      : event.disaster === 'fire'
        ? `火灾影响（${event.reason.split('；')[0]}）`
        : `地震影响（${event.reason.split('；')[0]}）`
  const active = Object.values(state.assignments)
    .map((id) => state.plans[id])
    .filter(Boolean)
    .map((p) => `${p.agentName}→T${state.tasks.find((t) => t.id === p.taskId)?.code ?? '?'}(${p.phase})`)
  return `t=${now}s | 封路 ${event.roadName || event.roadId} ${basis} | 受影响 ${tasks.length} 项 | 在途派单：${active.join('，') || '无'}`
}

function externalPlanLeg(ext: ExternalLeg): PlanLegs['external'] {
  return { ...ext, status: 'planned' }
}

function internalPlanLeg(int: InternalLeg): PlanLegs['internal'] {
  return { ...int, status: 'planned' }
}

async function leg(
  opts: BuildOptions,
  agent: Agent,
  pharmacy: InventoryPoint,
  gateId: string,
): Promise<ExternalLeg> {
  const gate = opts.model.net.gates.find((g) => g.id === gateId)
  const staging = opts.model.net.staging.find((s) => s.id === gateId)
  const gateVertex = gateId.startsWith('edgegate:') ? null : opts.router.gateVertex(gateId)
  const gateLngLat = gateVertex
    ? fromLocal(opts.router.verts.frame, opts.router.verts.byId.get(gateVertex)!.pos)
    : staging
      ? staging.lngLat
      : gateId.startsWith('edgegate:')
        ? (opts.router.edgeGatePositions().find((g) => g.id === gateId)?.pos
            ? fromLocal(opts.router.verts.frame, opts.router.edgeGatePositions().find((g) => g.id === gateId)!.pos)
            : opts.model.center)
        : gate?.lngLat ?? opts.model.center
  const req = {
    origin: agent.origin ?? opts.model.center,
    pharmacyId: pharmacy.id,
    pharmacyLngLat: pharmacy.lngLat,
    gateId,
    gateLngLat,
    agentSeed: agent.id,
    gateIsPerimeter: !gateVertex,
  }
  const key = opts.provider.cacheKey(req)
  const hit = opts.cache?.get(key)
  if (hit) return hit
  const out = await opts.provider.leg(req)
  opts.cache?.set(key, out)
  return out
}

function internalFromRoute(route: InternalRoute, target: Task, door?: string | null): InternalLeg {
  return {
    path: route.polyline,
    roadIds: route.roadIds,
    durationS: route.durationS,
    distanceM: route.lengthM,
    enterGate: route.usedEdgeGate ? '围栏临时门' : '大门',
    targetBuildingId: target.targetBuildingId,
    targetDoor: door ?? entranceVertexId(target),
    stops: [],
  }
}

function mkCheck(id: string, label: string, ok: boolean, detail: string) {
  return { id, label, ok, detail }
}

function newPlanShell(task: Task, agent: Agent, pharmacyId: string | null, external: ExternalLeg | null, internal: InternalLeg | null): Plan {
  return {
    id: '',
    version: 1,
    taskId: task.id,
    agentId: agent.id,
    agentName: agent.name,
    carryAgentId: agent.id,
    carry: 'external' as const,
    relay: Boolean(external) && Boolean(internal),
    pharmacyId,
    origin: 'reconfirmed',
    createdBy: 'system',
    rationale: '',
    legs: { external: external ? externalPlanLeg(external) : null, internal: internal ? internalPlanLeg(internal) : null },
    networkVersion: '',
    confirmedAt: null,
    phase: 'planned',
    progress: 0,
    blockedRoadId: null,
    deliveredAt: null,
    pickupAt: null,
    relayAt: null,
    eta: [],
    risk: 'unknown',
  }
}

function etaOf(external: ExternalLeg | null, internal: InternalLeg | null, now: SimTime): SimTime[] {
  const e = external ? externalTravelSeconds(external.durationS) + PICKUP_WAIT_S : 0
  const i = internal ? Math.max(1, internal.durationS) : 0
  return [now + e + HANDOVER_WAIT_S + i]
}

export async function buildCandidates(opts: BuildOptions): Promise<BuildResult> {
  const { state, model, router, provider, now, event, tasks, blocked, relays } = opts
  void provider
  const candidates: Candidate[] = []
  const taskChecks: BuildResult['taskChecks'] = []
  const activePlans: Plan[] = []
  const eventKey = `${event.roadId}@${event.at}`

  const activeGate = model.net.gates.find((g) => {
    const v = router.gateVertex(g.id)
    return v ? !blocked.verts.has(v) : false
  })
  const blockedGate = model.net.gates.find((g) => g.id !== activeGate?.id)
  const pharmacyList = Object.values(state.inventory)
  const stockOk = (p: InventoryPoint, need: Task['need']) => stockOf(state.inventory, p.id, need.item) >= need.qty
  const pharmacies = pharmacyList.filter((p) => p.availability !== 'out').sort((a, b) => haversine(model.center, a.lngLat) - haversine(model.center, b.lngLat))

  for (const task of tasks) {
    const reasons: string[] = []
    const assignedPlan = state.plans[state.assignments[task.id]]
    if (assignedPlan) activePlans.push(assignedPlan)
    const doorKey = targetDoorKey(router, task, blocked.verts)
    const reach = reachability(router, task, relays, blocked.verts)
    const reachable = reach.filter((r) => r.ok)
    const extAgents = state.agents.filter((a) => a.role === 'external')
    const intAgents = state.agents.filter((a) => a.role === 'internal')
    const currentExt = extAgents.find((a) => a.id === assignedPlan?.agentId) ?? extAgents[0]
    const stockPharmacy = pharmacies.find((p) => stockOk(p, task.need)) ?? null

    // ---- 可用性前提（缺哪项就写哪项） ----
    if (!reachable.length) {
      if (!doorKey) {
        const prim = blocked.verts.has(router.verts.byNode.get(entranceVertexId(task))?.id ?? '')
        const alt = router.verts.byNode.get(alternateEntranceId(task))
        reasons.push(
          `当前无可行配送路线：${task.targetName} 的正门${prim ? '已不可通行' : '不可用'}，备用入口${alt ? '同样不可通行' : '不存在'}，该楼栋已无可用入口，需要现场接应或清障后再派单`,
        )
      } else {
        reasons.push(`目标楼栋 ${task.targetName} 的入口在当前路网下不可达：所有可用接驳点到该入口的路线都经过封闭路段，需要清障、新增临时通道或人员接应`)
      }
    }
    const unableGate = !activeGate
    if (unableGate) {
      reasons.push(
        `社区大门（${model.net.gates.map((g) => g.name).join('、') || '未标记'}）当前不可用：请检查路网中已标记的接驳点是否可用于接力`,
      )
    }
    if (!pharmacies.length) reasons.push('没有可用药店：外部物资点均被标记为不可用')
    else if (!stockPharmacy) {
      reasons.push(
        `物资库存不足：任务需要 ${task.need.qty} 份「${task.need.item}」，可用药店演练库存分别为 ${pharmacies.map((p) => `${p.name} ${stockOf(state.inventory, p.id, task.need.item)}`).join('、')}`,
      )
    }
    const capOk = (a: Agent | undefined) => Boolean(a && a.capacityKg >= task.weightKg)
    if (!capOk(currentExt)) reasons.push(`运力不足：外部 Agent 载重 ${currentExt?.capacityKg ?? 0}kg < 任务 ${task.weightKg}kg`)

    // ---- 候选 A：外部 Agent 改走新路（同一 Agent，含内外两段） ----
    if (activeGate && currentExt && stockPharmacy) {
      const gateVerts = new Set<string>([router.gateVertex(activeGate.id) ?? ''])
      const blockedForInternal = union(blocked.verts, blocked.keys.has(`gate:${activeGate.id}`) ? gateVerts : new Set())
      const { route: toTask, doorKey: usedDoor } = routeToTarget(
        router,
        stockPharmacy.lngLat,
        buildingCenter(model, task.targetBuildingId),
        { startGateId: activeGate.id, blocked: blockedForInternal, blockedRoads: blocked.roads },
        task,
      )
      const ext = await leg(opts, currentExt, stockPharmacy, activeGate.id)
      const internal = toTask.ok ? internalFromRoute(toTask, task, usedDoor) : null
      const checks = [
        mkCheck('reach', '目标可达（内部路网）', toTask.ok, toTask.ok ? `经内部路网 ${Math.round(toTask.lengthM)} 米可达 ${task.targetName}` : toTask.error ?? '不可达'),
        mkCheck('stock', '物资库存', true, `${stockPharmacy.name} 演练库存 ${stockOf(state.inventory, stockPharmacy.id, task.need.item)} / 需 ${task.need.qty}`),
        mkCheck('capacity', '运力', true, `${currentExt.name} 载重 ${currentExt.capacityKg}kg ≥ ${task.weightKg}kg`),
        mkCheck('gate', '出入口可用', true, `经 ${activeGate.name} 进入`),
        mkCheck('route', '避让封闭路段', toTask.ok, toTask.ok ? `新路线不经过封闭路段 ${event.roadId}` : '新路线无法避开封闭路段'),
      ]
      const eta = etaOf(externalLegOk(ext) ? ext : null, internal, now)
      const slack = task.slaAt - eta[0]
      checks.push(mkCheck('sla', '时限', slack >= 0, `${task.deadlineLabel}送达，余量 ${(slack / 60).toFixed(1)} 分钟`))
      const feasible = Boolean(externalLegOk(ext) && internal) && checks.every((c) => c.ok)
      const plan = newPlanShell(task, currentExt, stockPharmacy.id, externalLegOk(ext) ? ext : null, internal)
      candidates.push({
        ...plan,
        id: `cand:${task.id}:reroute:${activeGate.id}`,
        eventId: eventKey,
        kind: usedDoor === alternateEntranceId(task) ? 'alt_entrance' : 'intra_reroute',
        title: usedDoor === alternateEntranceId(task) ? `换入口：改用 ${task.targetName} 备用入口送达` : '同组改道：外部 Agent 走未封闭大门与路段',
        summary: `${currentExt.name} 从 ${stockPharmacy.name} 取货，经 ${activeGate.name} 改走未封闭路段，送达 ${task.targetName}`,
        affects: [task.id],
        legs: plan.legs,
        eta,
        latestEta: eta[0],
        slackS: slack,
        route: {
          polyline: [...(internal?.path ?? []), ...(externalLegOk(ext) ? ext.path : [])],
          source: 'sample',
        },
        external: externalLegOk(ext) ? ext : null,
        internal,
        checks,
        feasible,
        score: 0,
        reason: feasible ? ['外部段改道', '内部路网避让封闭路段'] : checks.filter((c) => !c.ok).map((c) => `${c.label}：${c.detail}`),
        dispatchReason: usedDoor === alternateEntranceId(task)
          ? `原入口被 ${event.disaster === 'fire' ? '烟雾' : event.disaster === 'earthquake' ? '损毁' : '封闭'}影响：改走 ${task.targetName} 的备用入口，外部段保持不变`
          : '外部 Agent 尚未进入封闭区域：改走未封闭的大门与内部路段即可继续执行',
        rank: 0,
        agentId: currentExt.id,
        isRelay: false,
      })
      if (!feasible) reasons.push(...checks.filter((c) => !c.ok).map((c) => `${c.label}：${c.detail}`))
    }

    // ---- 候选 B：已标记接驳点接力（外部送接驳点，内部 Agent 送达） ----
    for (const r of reachable) {
      const relay = r.relay
      const intAgent = intAgents.find((a) => a.capacityKg >= task.weightKg)
      if (!intAgent) {
        reasons.push('没有可用的内部 Agent（运力均不足或未配置）')
        break
      }
      const { route: fromRelay, doorKey: relayDoor } = routeToTarget(
        router,
        relay.lngLat,
        buildingCenter(model, task.targetBuildingId),
        { blocked: blocked.verts, blockedRoads: blocked.roads },
        task,
      )
      // 内部 Agent 必须先走到接驳点才能接手：这里必须是真实寻路。
      // 早先误用空起终点，导致所有接力候选都判“接驳点不可达”，换接驳点方案永远不可行。
      //
      // 起点取「可达的内部 Agent 位置」：优先它自己驻守的接驳点；若该接驳点被灾情作废，
      // 则允许它已前置到其它仍可用的接驳点（演练里视为指挥员提前部署），
      // 并在候选的校验说明里写清楚，不假装人凭空出现。
      const relayV = router.verts.byId.get(relay.key) ?? router.verts.byNode.get(relay.key)
      const ownV = intAgent.stagingNodeKey ? router.verts.byNode.get(intAgent.stagingNodeKey) : undefined
      const startPool = [
        ownV,
        ...model.net.staging.map((x) => router.verts.byNode.get(`staging:${x.id}`)),
      ].filter((v): v is NonNullable<typeof v> => Boolean(v) && !blocked.verts.has((v as NonNullable<typeof v>).id))
      const startIds = [...new Set(startPool.map((v) => v.id))]
      let toRelay: ReturnType<typeof router.router.shortest> | null = null
      let startReusedOwn = false
      if (relayV && startIds.length) {
        const res = router.router.shortest(startIds, [relayV.id], blocked.verts, blocked.roads)
        if (res.pathVertices.length) {
          toRelay = res
          startReusedOwn = Boolean(ownV && res.pathVertices[0] === ownV.id)
        }
      }
      const canReachRelay = Boolean(toRelay)
      const walkToRelay = canReachRelay ? toRelay!.distance / intAgent.speedMps : 0
      const walkPath = canReachRelay ? toRelay!.pathVertices.map((id) => fromLocal(router.verts.frame, router.verts.byId.get(id)!.pos)) : []
      const internal: InternalLeg | null = fromRelay.ok
        ? {
            path: [...walkPath, ...fromRelay.polyline],
            roadIds: [...(toRelay?.roadIds ?? []), ...fromRelay.roadIds],
            durationS: fromRelay.durationS + walkToRelay,
            distanceM: fromRelay.lengthM + (toRelay?.distance ?? 0),
            enterGate: relay.label,
            targetBuildingId: task.targetBuildingId,
            targetDoor: relayDoor ?? entranceVertexId(task),
            stops: [],
          }
        : null
      const carrier = currentExt ?? intAgent
      const external = stockPharmacy ? await leg(opts, carrier, stockPharmacy, relay.key) : null
      const checks = [
        mkCheck('reach', '目标可达（内部路网）', Boolean(internal), internal ? `${relay.label} → ${task.targetName}，${Math.round(fromRelay.lengthM)} 米` : fromRelay.error ?? '不可达'),
        mkCheck(
          'relay',
          '接驳点可达',
          canReachRelay,
          canReachRelay
            ? `${intAgent.name} ${startReusedOwn ? '从驻守的接驳点' : '已前置到可用接驳点，'}可赶到 ${relay.label}`
            : '内部 Agent 到接力点的路线被封闭',
        ),
        mkCheck('stock', '物资库存', Boolean(stockPharmacy), stockPharmacy ? `${stockPharmacy.name} 演练库存 ${stockOf(state.inventory, stockPharmacy.id, task.need.item)} / 需 ${task.need.qty}` : '无可用药店'),
        mkCheck('capacity', '运力', intAgent.capacityKg >= task.weightKg, `${intAgent.name} 载重 ${intAgent.capacityKg}kg ≥ ${task.weightKg}kg`),
        mkCheck('route', '避让封闭路段', Boolean(internal), internal ? '内部路线不经过封闭路段' : '无法绕开封闭路段'),
      ]
      const [eta] = etaOf(external, internal, now)
      const slack = task.slaAt - eta
      checks.push(mkCheck('sla', '时限', slack >= 0, `${task.deadlineLabel}送达，余量 ${(slack / 60).toFixed(1)} 分钟`))
      const feasible = Boolean(internal) && canReachRelay && Boolean(stockPharmacy) && checks.every((c) => c.ok)
      const shell = newPlanShell(task, intAgent, stockPharmacy?.id ?? null, external, internal)
      candidates.push({
        ...shell,
        id: `cand:${task.id}:relay:${relay.key}`,
        eventId: eventKey,
        kind: 'staging_relay',
        title: relayDoor === alternateEntranceId(task) ? '接力 + 换入口：经接驳点并改走备用入口' : '接力：外部送到接驳点，内部 Agent 送达',
        summary: `${carrier.name} 送到 ${relay.label}，${intAgent.name} 接力沿内部路网送达 ${task.targetName}`,
        affects: [task.id],
        legs: shell.legs,
        eta: [eta],
        latestEta: eta,
        slackS: slack,
        route: { polyline: internal?.path ?? [], source: 'internal_astar' },
        external,
        internal,
        checks: dedupeChecks(checks),
        feasible,
        score: 0,
        reason: feasible ? ['绕开封闭大门', '接驳点接力'] : checks.filter((c) => !c.ok).map((c) => `${c.label}：${c.detail}`),
        dispatchReason: `改用已标记的「${relay.label}」交接，由内部 Agent 接力送达`,
        rank: 0,
        agentId: intAgent.id,
        isRelay: true,
      })
    }

    // ---- 候选 C：换另一名外部 Agent 重新取货 ----
    if (activeGate && stockPharmacy) {
      for (const alt of extAgents) {
        if (alt.id === currentExt?.id) continue
        const altPharmacy = pharmacies.find((p) => p.id !== stockPharmacy.id && stockOk(p, task.need)) ?? stockPharmacy
        const ext = await leg(opts, alt, altPharmacy, activeGate.id)
        const { route: toTask, doorKey: altDoor } = routeToTarget(
          router,
          altPharmacy.lngLat,
          buildingCenter(model, task.targetBuildingId),
          { startGateId: activeGate.id, blocked: blocked.verts, blockedRoads: blocked.roads },
          task,
        )
        const checks = [
          mkCheck('reach', '目标可达（内部路网）', toTask.ok, toTask.ok ? `经内部路网 ${Math.round(toTask.lengthM)} 米` : toTask.error ?? '不可达'),
          mkCheck('capacity', '运力', alt.capacityKg >= task.weightKg, `${alt.name} 载重 ${alt.capacityKg}kg`),
          mkCheck('stock', '物资库存', stockOk(altPharmacy, task.need), `${altPharmacy.name} 演练库存 ${stockOf(state.inventory, altPharmacy.id, task.need.item)}`),
        ]
        const internal = toTask.ok ? internalFromRoute(toTask, task, altDoor) : null
        const etaList = etaOf(externalLegOk(ext) ? ext : null, internal, now)
        const slack = task.slaAt - etaList[0]
        checks.push(mkCheck('sla', '时限', slack >= 0, `${task.deadlineLabel}送达，余量 ${(slack / 60).toFixed(1)} 分钟`))
        const shell = newPlanShell(task, alt, altPharmacy.id, externalLegOk(ext) ? ext : null, internal)
        candidates.push({
          ...shell,
          id: `cand:${task.id}:ext:${alt.id}`,
          eventId: eventKey,
          kind: 'ext_reroute',
          title: '换组：另一名外部 Agent 从药店接手',
          summary: `${alt.name} 从 ${altPharmacy.name}（演练库存 ${stockOf(state.inventory, altPharmacy.id, task.need.item)}）取货，经 ${activeGate.name} 送达 ${task.targetName}`,
          affects: [task.id],
          legs: shell.legs,
          eta: etaList,
          latestEta: etaList[0],
          slackS: slack,
          route: { polyline: [...(internal?.path ?? []), ...(externalLegOk(ext) ? ext.path : [])], source: 'sample' },
          external: externalLegOk(ext) ? ext : null,
          internal,
          checks,
          feasible: Boolean(externalLegOk(ext) && internal) && checks.every((c) => c.ok),
          score: 0,
          reason:
            externalLegOk(ext) && internal
              ? ['换组重新取货']
              : checks.filter((c) => !c.ok).map((c) => `${c.label}：${c.detail}`),
          dispatchReason: '原 Agent 受阻：换另一名外部 Agent 从演练库存充足的药店重新取货',
          rank: 0,
          agentId: alt.id,
          isRelay: false,
        })
      }
    }

    taskChecks.push({
      taskId: task.id,
      taskTitle: task.title,
      feasible: candidates.some((c) => c.feasible && c.affects.includes(task.id)),
      reasons: dedupeStrings(reasons),
    })
  }

  // 给每个候选补充影响范围
  for (const c of candidates) {
    c.eventId = eventKey
    c.affects = [...new Set([...c.affects, ...(c.internal ? [taskOf(state, c.taskId)?.id ?? ''].filter(Boolean) : [])])]
  }
  return { candidates, taskChecks, activePlans, blockedGateName: blockedGate?.name ?? null, snapshotText: snapshotTextOf(state, event, tasks, now) }
}

function dedupeChecks<T extends { id: string }>(list: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const x of list) {
    if (seen.has(x.id)) continue
    seen.add(x.id)
    out.push(x)
  }
  return out
}

function dedupeStrings(list: string[]): string[] {
  return [...new Set(list)]
}

function union<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set(a)
  for (const x of b) out.add(x)
  return out
}

function buildingCenter(model: CommunityModel, id: string): LngLat {
  return model.buildings.find((b) => b.id === id)?.center ?? model.center
}

function taskOf(state: DrillState, id: string): Task | undefined {
  return state.tasks.find((t) => t.id === id)
}

export type { CandidateKind }
