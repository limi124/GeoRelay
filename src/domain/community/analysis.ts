import type { CommunityModel } from './model.ts'
import { validateFence } from './operations.ts'
import { CommunityRouter } from '../routing/internal.ts'

/** unavailable = 缺少评估输入；unreachable = 输入存在，但当前封闭状态下无图上路线。 */
export type AccessStatus = 'reachable' | 'unreachable' | 'unavailable'

export interface ResilienceOptions {
  /** 路段 ID，例如 Object.keys(state.closures)；只封边，不封交叉点。 */
  blockedRoadIds?: Iterable<string>
  /** 入口节点键：entrance:<buildingId> / entranceAlt:<buildingId>。 */
  blockedDoorIds?: Iterable<string>
  /** 接驳点 ID，例如 Object.keys(state.blockedStaging)。 */
  blockedStagingIds?: Iterable<string>
}

export interface BuildingScore {
  id: string
  name: string
  vulnerable: number
  /** 图上路线的几何长度；-1 表示无距离，原因见对应 status。 */
  gateDistanceM: number
  stagingDistanceM: number
  gateStatus: AccessStatus
  stagingStatus: AccessStatus
  /** 至少一个已建模来源可达，不代表外部补给链或现场安全已验证。 */
  reachable: boolean
  /** 仅一个候选入口可达；包含推导备用门，不表示独立疏散通道数。 */
  singleEntry: boolean
  reachableEntryCount: number
}

export interface ResilienceIssue {
  level: 'high' | 'medium' | 'low'
  kind: 'isolated' | 'distant' | 'single-entry' | 'vulnerable-distant' | 'staging-gap' | 'gate-gap' | 'model-gap' | 'assumption'
  targetId?: string
  targetName?: string
  message: string
  suggestion: string
}

export interface ResilienceReport {
  buildings: BuildingScore[]
  issues: ResilienceIssue[]
  summary: {
    totalBuildings: number
    /** 有至少一类可评估来源、但均不可达的楼栋；不含完全缺少输入的楼栋。 */
    isolatedCount: number
    distantCount: number
    vulnerableTotal: number
    /** 仅对相应来源可达的楼栋取整平均（含零距离）；无样本时为 -1。 */
    avgStagingDistanceM: number
    avgGateDistanceM: number
    stagingReachableCount: number
    gateReachableCount: number
    unassessedCount: number
  }
}

// 仅供演示筛查的距离假设，不是消防、救援或人力配送的专业标准。
const DISTANT_STAGING_M = 300
const FAR_STAGING_M = 500
const DISTANT_GATE_M = 250
const DEMO_NOTE = '（演示假设，非专业标准）'

/**
 * 静态图上薄弱点筛查；可传入指挥台当前封路/封门/接驳点停用 ID。
 * 不推断灾情阈值、不评估车辆通行/运力/外部补给，也不把结果解释为安全认证。
 * 只使用已确认路段；备用门及 access 边仍是路由器推导的演示假设，须现场核实。
 */
export function analyzeResilience(model: CommunityModel, options: ResilienceOptions = {}): ResilienceReport {
  const gates = model.net.gates
  const staging = model.net.staging
  const buildings = model.buildings
  const issues: ResilienceIssue[] = []
  const fenceReady = model.fence.polygon.every((p) => p.every(Number.isFinite)) && validateFence(model.fence.polygon).ok
  const confirmedRoads = model.net.roads.filter((r) => r.status === 'user')
  const router = fenceReady ? new CommunityRouter({ ...model, net: { ...model.net, roads: confirmedRoads } }) : null
  // 不能让自动生成的 access 边掩盖尚未绘制/确认路网的事实。
  const routingReady = Boolean(router?.verts.segments.length)
  const blockedRoads = new Set(options.blockedRoadIds)
  const blockedVerts = new Set<string>()
  for (const key of options.blockedDoorIds ?? []) {
    const v = router?.verts.byNode.get(key)
    if (v) blockedVerts.add(v.id)
  }
  for (const id of options.blockedStagingIds ?? []) {
    const v = router?.verts.byNode.get(`staging:${id}`)
    if (v) blockedVerts.add(v.id)
  }
  const gateIds = gates.flatMap((g) => {
    const v = router?.verts.byNode.get(`gate:${g.id}`)
    return v ? [v.id] : []
  })
  const stagingIds = staging.flatMap((s) => {
    const v = router?.verts.byNode.get(`staging:${s.id}`)
    return v ? [v.id] : []
  })

  const modelGap = (message: string, suggestion: string): void => {
    issues.push({ level: 'high', kind: 'model-gap', message, suggestion })
  }
  if (!fenceReady) modelGap('围栏缺失或未通过模型校验，距离暂不可评估', '请先完善并校验社区围栏，再复核入口与路网')
  if (!buildings.length) modelGap('尚未标记楼栋，不能判断救援覆盖', '请补充楼栋和入口位置后重新分析')
  if (!routingReady) modelGap('缺少有效的已确认路网，不能评估救援距离与覆盖', '请绘制连通入口的路段并确认路网；自动备用门连线不能替代真实道路')
  if (confirmedRoads.length < model.net.roads.length) {
    modelGap('存在尚未确认的示例路段，未纳入本次分析，模型仍不完整', '请现场核实这些路段后确认路网，再重新分析')
  }
  if (!gates.length) {
    issues.push({
      level: 'high', kind: 'gate-gap',
      message: '社区尚未标记大门，外部接入能力无法评估',
      suggestion: '请在“入口与路网”中标记并核实社区大门',
    })
  }
  if (!staging.length) {
    issues.push({
      level: 'high', kind: 'staging-gap',
      message: '社区尚未标记接驳点，内部补给距离无法评估',
      suggestion: '请在“入口与路网”中标记并核实接驳点',
    })
  } else if (stagingIds.length && stagingIds.every((id) => blockedVerts.has(id))) {
    issues.push({
      level: 'high', kind: 'staging-gap',
      message: '当前所有已标记接驳点均已停用，不能提供接驳覆盖',
      suggestion: '请核实灾情，评估其它可用接驳位置；不要沿用停用点安排配送',
    })
  }

  // route() 面向界外接入，始终先选大门；内部接驳源必须直接取 byNode 顶点。
  // shortest 按距离+拐弯惩罚选路；这里只统计返回路线的 distance，不把 cost 当作米数。
  const distanceTo = (sources: string[], target: string): number => {
    if (!router || !routingReady) return -1
    let best = Infinity
    for (const source of sources) {
      const result = router.router.shortest([source], [target], blockedVerts, blockedRoads)
      if (result.pathVertices.length && Number.isFinite(result.distance)) best = Math.min(best, result.distance)
    }
    return Number.isFinite(best) ? best : -1
  }
  const minimum = (distances: number[]): number => {
    const reachable = distances.filter((d) => d >= 0)
    return reachable.length ? Math.min(...reachable) : -1
  }
  const status = (distance: number, sourceCount: number): AccessStatus =>
    !routingReady || !sourceCount ? 'unavailable' : distance >= 0 ? 'reachable' : 'unreachable'

  const scores: BuildingScore[] = buildings.map((b) => {
    const doors = [`entrance:${b.id}`, `entranceAlt:${b.id}`].flatMap((key) => {
      const v = router?.verts.byNode.get(key)
      return v ? [{ key, gate: distanceTo(gateIds, v.id), staging: distanceTo(stagingIds, v.id) }] : []
    })
    const reachableDoors = doors.filter((d) => d.gate >= 0 || d.staging >= 0)
    const gateDistanceM = minimum(doors.map((d) => d.gate))
    const stagingDistanceM = minimum(doors.map((d) => d.staging))
    const score: BuildingScore = {
      id: b.id, name: b.name, vulnerable: b.vulnerable ?? 0,
      gateDistanceM, stagingDistanceM,
      gateStatus: status(gateDistanceM, gates.length),
      stagingStatus: status(stagingDistanceM, staging.length),
      reachable: reachableDoors.length > 0,
      singleEntry: reachableDoors.length === 1,
      reachableEntryCount: reachableDoors.length,
    }
    if (score.singleEntry) {
      const derivedOnly = reachableDoors[0].key.startsWith('entranceAlt:')
      issues.push({
        level: derivedOnly ? 'high' : 'medium', kind: 'single-entry', targetId: b.id, targetName: b.name,
        message: derivedOnly
          ? `${b.name} 仅推导的备用门在图上可达，正门无可用路线；不能据此认定现场可达`
          : `${b.name} 当前仅一个候选入口可达，缺少可达的备用入口`,
        suggestion: derivedOnly
          ? '优先核实备用门及其自动接入连线是否真实可通行，同时排查正门封闭或路网缺口'
          : '核实备用入口及接入道路，检查是否与现有路线共用易中断路段',
      })
    }
    return score
  })

  const isUnassessed = (s: BuildingScore): boolean => s.gateStatus === 'unavailable' && s.stagingStatus === 'unavailable'
  for (const s of scores) {
    const target = { targetId: s.id, targetName: s.name }
    if (isUnassessed(s)) continue
    if (!s.reachable) {
      issues.push({
        level: 'high', kind: 'isolated', ...target,
        message: `${s.name} 从当前已建模的大门/接驳点均无可用路线，属于图上救援孤岛${s.vulnerable > 0 ? `，涉及 ${s.vulnerable} 户重点住户` : ''}`,
        suggestion: '优先核实现场情况、入口封闭与路网连通性；缺路数据不等于现场确实无法到达',
      })
      continue
    }
    if (s.gateStatus === 'unreachable') {
      issues.push({
        level: 'high', kind: 'gate-gap', ...target,
        message: `${s.name} 虽可从接驳点到达，但当前大门均无路线到达，外部补给链未连通`,
        suggestion: '排查大门至内部路网的封闭与断点，核实接驳点能否持续获得外部补给',
      })
    }
    if (s.stagingStatus === 'unreachable') {
      issues.push({
        level: 'high', kind: 'staging-gap', ...target,
        message: `${s.name} 虽可从大门到达，但当前接驳点均无可用路线${s.vulnerable > 0 ? `，涉及 ${s.vulnerable} 户重点住户` : ''}`,
        suggestion: '检查接驳点停用与路段封闭情况，核实可用接驳位置及内部配送路线',
      })
    }
    if (s.stagingDistanceM > DISTANT_STAGING_M) {
      const far = s.stagingDistanceM > FAR_STAGING_M
      issues.push({
        level: far ? 'high' : 'medium', kind: 'distant', ...target,
        message: `${s.name} 接驳路线 ${Math.round(s.stagingDistanceM)} m，超过 ${far ? FAR_STAGING_M : DISTANT_STAGING_M} m 筛查阈值${DEMO_NOTE}`,
        suggestion: '结合实际通行条件、人员与运力，评估增设中转点或缩短内部配送路线',
      })
    }
    if (s.gateDistanceM > DISTANT_GATE_M) {
      issues.push({
        level: 'medium', kind: 'gate-gap', ...target,
        message: `${s.name} 大门路线 ${Math.round(s.gateDistanceM)} m，超过 ${DISTANT_GATE_M} m 筛查阈值${DEMO_NOTE}`,
        suggestion: '结合实际通行条件核实进入路线，不据此推定车辆可通行或必须增设大门',
      })
    }
    if (s.vulnerable > 0 && s.stagingDistanceM > DISTANT_STAGING_M) {
      issues.push({
        level: 'high', kind: 'vulnerable-distant', ...target,
        message: `${s.name} 有 ${s.vulnerable} 户重点住户，接驳路线 ${Math.round(s.stagingDistanceM)} m，超过 ${DISTANT_STAGING_M} m 优先筛查阈值${DEMO_NOTE}`,
        suggestion: '优先核实重点住户需求，评估内部志愿者配置或前置储备物资',
      })
    }
  }

  const stagingDistances = scores.filter((s) => s.stagingStatus === 'reachable').map((s) => s.stagingDistanceM)
  const gateDistances = scores.filter((s) => s.gateStatus === 'reachable').map((s) => s.gateDistanceM)
  const average = (distances: number[]): number => distances.length
    ? distances.reduce((sum, d) => sum + d, 0) / distances.length : -1
  const avgStaging = average(stagingDistances)
  if (avgStaging > DISTANT_STAGING_M) {
    issues.push({
      level: 'medium', kind: 'staging-gap',
      message: `接驳可达的 ${stagingDistances.length}/${buildings.length} 栋楼平均路线 ${Math.round(avgStaging)} m，超过 ${DISTANT_STAGING_M} m 筛查阈值${DEMO_NOTE}`,
      suggestion: '平均值不含不可达或缺少输入的楼栋；请先处理覆盖缺口，再结合实际运力评估接驳位置',
    })
  }
  issues.push({
    level: 'low', kind: 'assumption',
    message: `本分析仅为图上演示筛查：门距 ${DISTANT_GATE_M} m、接驳距 ${DISTANT_STAGING_M}/${FAR_STAGING_M} m 均为演示假设，非专业标准；-1 表示距离不可用，不是零距离`,
    suggestion: '备用门及其接入边为自动推导，未验证真实存在、独立通路或现场通行；请复核模型和当前封闭状态，结果不构成安全或救援覆盖认证',
  })
  const priority = { high: 0, medium: 1, low: 2 }
  issues.sort((a, b) => priority[a.level] - priority[b.level])

  return {
    buildings: scores,
    issues,
    summary: {
      totalBuildings: buildings.length,
      isolatedCount: scores.filter((s) => !s.reachable && !isUnassessed(s)).length,
      distantCount: scores.filter((s) => s.stagingDistanceM > DISTANT_STAGING_M || s.gateDistanceM > DISTANT_GATE_M).length,
      vulnerableTotal: scores.reduce((sum, s) => sum + s.vulnerable, 0),
      avgStagingDistanceM: Math.round(avgStaging),
      avgGateDistanceM: Math.round(average(gateDistances)),
      stagingReachableCount: stagingDistances.length,
      gateReachableCount: gateDistances.length,
      unassessedCount: scores.filter(isUnassessed).length,
    },
  }
}
