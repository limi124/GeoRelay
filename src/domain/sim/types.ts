import type { LngLat } from '../geo/types.ts'

/** 演练时钟的单位刻度：秒（模拟时间） */
export type SimTime = number

export interface DrillsClockConfig {
  /** 演练起始时刻（真实时间戳，ms） */
  startMs: number
  /** 演练起点的墙上时间（HH:mm） */
  startLabel: string
  /** 1 秒真实 = speed 秒演练 */
  speed: number
}

/**
 * 演练时钟：纯数据，不依赖真实时间。模拟器只接受 tick(seconds)，
 * 因此浏览器内、批处理、测试三处运行结果一致。
 */
export interface ClockState {
  /** 当前演练时间（秒，从 0 起） */
  t: SimTime
  running: boolean
  speed: number
  startMs: number
  startLabel: string
}

export function formatSimTime(t: SimTime, startLabel = '08:00'): string {
  const [hh, mm] = startLabel.split(':').map((x) => Number.parseInt(x, 10))
  const total = hh * 3600 + mm * 60 + Math.floor(t)
  const h = Math.floor(total / 3600) % 24
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function scaleSim(t: SimTime, kind: 'start' | 'flood' | 'closure' | 'pickup' | 'drop' | 'confirm' | 'reach' | 'deliver' | 'reset'): SimTime {
  void kind
  return t
}

/** 外部接驳状态机 */
export type RelayStage = 'external_enroute' | 'pickup_wait' | 'internal_wait' | 'delivering' | 'delivered'

export interface DepthSeries {
  /** 峰值水深（米） */
  peak: number
  /** 逐步增长的时刻表：[时刻, 水深] */
  points: Array<[SimTime, number]>
}

export type DisasterKind = 'flood' | 'fire' | 'earthquake'

export type EventKind =
  | 'sim_started'
  | 'entrance_blocked'
  | 'staging_blocked'
  | 'building_damaged'
  | 'flood_risen'
  | 'road_closed'
  | 'road_cleared'
  | 'candidates_proposed'
  | 'plan_confirmed'
  | 'agent_assigned'
  | 'agent_accepted'
  | 'agent_pickup'
  | 'agent_relay'
  | 'supply_arrived'
  | 'agent_blocked'
  | 'agent_waiting'
  | 'agent_delivered'
  | 'responder_dispatched'
  | 'responder_arrived'
  | 'rescue_assigned'
  | 'task_sla_risk'
  | 'drill_reset'
  | 'external_left'
  | 'note'

export interface RoadClosureEvidence {
  roadId: string
  roadName: string
  depthM: number
  thresholdM: number
  at: SimTime
  /** 逐渐上涨的历史 */
  history: Array<[SimTime, number]>
  reason: string
  disaster: DisasterKind
  /** 对应的统一影响事件 ID（火灾/地震也会写入封路集合） */
  impactId?: string
}

export interface SimEvent {
  id: string
  at: SimTime
  kind: EventKind
  /** 结构化事件（灾情事件 / 封路事件）的载荷 */
  payload: RoadClosureEvidence | { message: string } | { planId: string } | { taskId: string; agentId?: string } | { pharmacyId: string; atGate: string }
  message: string
  /** 事件与哪些对象相关（用于界面高亮） */
  refs?: { roadIds?: string[]; taskIds?: string[]; agentIds?: string[]; responderIds?: string[]; buildingId?: string; planId?: string }
}

export interface ExternalLeg {
  /** 药店（物资点） */
  pharmacy: { id: string; name: string; lngLat: LngLat; source: 'amap' | 'sample'; address?: string; distanceM?: number }
  atGate: string
  /** 外部路线（WGS-84 折线） */
  path: LngLat[]
  durationS: number
  distanceM: number
  /** 路线来源：'amap' 为高德驾车路线；'sample' 为示例直线（明确标注） */
  routeSource: 'amap' | 'sample'
  routeNote?: string
}

export interface InternalStop {
  at: SimTime
  nodeKey: string
  kind: 'gate' | 'entrance' | 'staging' | 'junction'
}

export interface InternalLeg {
  path: LngLat[]
  /** 途经的路段 ID（Dijkstra 结果，权威数据，用于封路判定） */
  roadIds: string[]
  durationS: number
  distanceM: number
  enterGate: string
  targetBuildingId: string
  /** 实际使用的目标入口节点键（正门 entrance:<id> 或备用入口 entranceAlt:<id>） */
  targetDoor?: string
  stops: InternalStop[]
}

export type TaskStatus = 'pending' | 'in_transit' | 'relayed' | 'delivered' | 'blocked' | 'rescued' | 'assist_completed'

export interface Task {
  id: string
  code: string
  title: string
  kind: 'supply' | 'assist'
  targetBuildingId: string
  targetName: string
  slot: 'morning' | 'afternoon'
  slaAt: SimTime
  deadlineLabel: string
  need: { item: string; qty: number }
  weightKg: number
  priority: 'high' | 'normal'
}

export type AgentRole = 'external' | 'internal'

export interface Agent {
  id: string
  name: string
  role: AgentRole
  group: 'A' | 'B' | 'C' | 'D'
  /** 外部 Agent 的起点（界外） */
  origin: LngLat | null
  /** 外部 Agent 可用运力（kg） */
  capacityKg: number
  /** 内部 Agent 的出发点（接驳点 ID，从用户路网读取） */
  stagingNodeKey?: string
  speedMps: number
  /** 受阻时停下的位置（由模拟器写入） */
  restingAt?: LngLat
  /** 演练数据标注 */
  demo: true
}

/** 消防响应独立于志愿者物资派单；到达集结点不代表排险或救援完成。 */
export interface Responder {
  id: string
  name: string
  role: 'firefighter'
  /** 界外模拟起点，不是真实消防站 */
  origin: LngLat
  originName: string
  originSource: 'sample'
  /** 社区大门 / 接驳集结点（无可用节点时为外围模拟点），不进入楼栋 */
  target: LngLat
  targetName: string
  /** 示意直线路径（WGS-84），未验证道路通行能力 */
  path: LngLat[]
  routeSource: 'sample'
  routeNote: string
  /** 路径总长（米） */
  pathLengthM: number
  /** 假设恒速 80 / 3.6 m/s，仅用于演练 */
  speedMps: number
  status: 'dispatched' | 'arrived'
  /** 0-1 沿路径进度 */
  progress: number
  position: LngLat
  /** 剩余演练秒数，不随墙上时间或 UI 倍速直接变化 */
  remainingS: number
  dispatchedAt: SimTime
  /** 实际到达集结点的演练时刻；尚在途中为 null */
  arrivedAt: SimTime | null
}

export type LegStatus = 'planned' | 'pickup_pending' | 'handover_pending' | 'delivering' | 'delivered' | 'blocked' | 'waiting' | 'assist'

export interface PlanLegs {
  external: (ExternalLeg & { status: LegStatus }) | null
  internal: (InternalLeg & { status: LegStatus }) | null
}

export interface Plan {
  id: string
  /** 版本号，每次确认 +1 */
  version: number
  taskId: string
  agentId: string
  agentName: string
  /** 实际携带最后一段（送达）的 Agent：接力时为内部 Agent */
  carryAgentId: string
  relay: boolean
  /** 由谁携带最后一段（接力时最后一段由内部 Agent 完成） */
  carry: 'external' | 'internal'
  pharmacyId: string | null
  /** 封路前生成的原始方案标记为 baseline */
  origin: 'baseline' | 'reconfirmed'
  createdBy: 'system' | 'commander'
  rationale: string
  legs: PlanLegs
  /** 计算时使用的路网版本（社区模型 updatedAt） */
  networkVersion: string
  confirmedAt: SimTime | null
  // ---- 执行状态（由模拟器推进） ----
  phase:
    | 'planned'
    | 'external_enroute'
    | 'external_arrived'
    | 'pickup_wait'
    | 'internal_ready'
    | 'handover_wait'
    | 'delivering'
    | 'delivered'
    | 'blocked'
    | 'assist_handovers_pending'
  progress: number
  blockedRoadId: string | null
  /** 受阻对象（路段 / 入口 / 接驳点）：火灾地震可能不是路段 */
  blockedBy?: { kind: 'road' | 'door' | 'staging'; id: string; label: string } | null
  deliveredAt: SimTime | null
  pickupAt: SimTime | null
  /** 接力点（接驳点） */
  relayAt: SimTime | null
  // ---- 预估 ----
  eta: SimTime[]
  risk: 'on_time' | 'late' | 'unknown'
  riskNote?: string
  // ---- 改写记录 ----
  supersededBy?: string
  /** 被灾情打断的时刻 */
  interruptedAt?: SimTime
}

export interface CandidateImpact {
  tasks: string[]
  buildings: string[]
  /** 改动/新增的路段 */
  roads: string[]
  agents: string[]
  note: string
}

export type CandidateKind = 'intra_reroute' | 'ext_reroute' | 'staging_relay' | 'alt_entrance' | 'manual'

export interface Candidate {
  id: string
  /** 关联的灾情事件 */
  eventId: string
  kind: CandidateKind
  title: string
  summary: string
  /** 该候选服务的目标任务 */
  taskId: string
  affects: string[]
  legs: PlanLegs
  /** 预计送达时刻（演练秒） */
  eta: SimTime[]
  latestEta: SimTime
  /** 相对 SLA 的余量（秒，负数=超时） */
  slackS: number
  route: { polyline: LngLat[]; source: 'internal_astar' | 'amap' | 'sample' }
  external: ExternalLeg | null
  internal: InternalLeg | null
  /** 规则校验结果（不可行时给出缺项条件） */
  checks: Array<{ id: string; label: string; ok: boolean; detail: string }>
  feasible: boolean
  score: number
  reason: string[]
  /** 该候选代表的“改派理由” */
  dispatchReason: string
  rank: number
  /** 外部 Agent 使用的起点（可为空：复用既有 Agent） */
  agentId: string
  isRelay: boolean
  /** 保持原方案（不构成改派） */
  keepsAssignment?: boolean
}

export interface PlanSet {
  id: string
  eventId: string
  taskId: string
  at: SimTime
  snapshot: string
  candidates: Candidate[]
  rankingMode: import('./ranker.ts').RankingMode
  rankingNote?: string
  /** 已确认的方案 ID */
  confirmedCandidateId: string | null
  confirmedAt: SimTime | null
  confirmedBy: string | null
  aiExplain?: string
  aiStatus: 'disabled' | 'ok' | 'error'
}

export interface InventoryPoint {
  id: string
  name: string
  label: string
  source: 'amap' | 'sample'
  stock: Record<string, number>
  lngLat: LngLat
  address?: string
  availability: 'available' | 'limited' | 'out'
}

export interface DrillConfig {
  untilAllEvacuated?: boolean
  continueAfterEvacuation?: boolean
  seed: number
  /** 积水深度阈值（米） */
  depthThresholdM: number
  /** 演练时长（秒） */
  durationS: number
  /** 起点 */
  startLabel: string
  /** 起始时刻（真实时间 ms） */
  startMs: number
  /** 每段路段涨水峰值由种子决定的幅度区间 */
  depthPeakM: [number, number]
  /** 降雨强度系数（影响涨水速度） */
  rain: number
  /** 外部 Agent 起点离社区的距离（米） */
  externalOriginRadiusM: number
}

export interface Snapshot {
  at: SimTime
  label: string
  planId: string | null
  changedRoads: string[]
  changedBuildings: string[]
  eventIds: string[]
}

export interface DrillRecord {
  seed: number
  startedAt: string
  /** 全部事件（含封路事件的结构化载荷） */
  events: SimEvent[]
  plans: Plan[]
  /** 确认记录 */
  confirmations: Array<{ at: SimTime; planSetId: string; candidateId: string | null; by: string; note: string }>
  snapshots: Snapshot[]
  results: Array<{ at: SimTime; taskId: string; planId: string; status: TaskStatus; slaMet: boolean | null }>
  /** 库存变化记录 */
  inventory: Array<{ at: SimTime; pharmacyId: string; item: string; delta: number; left: number }>
}

export interface DrillState {
  /** 演练 ID：每次重置生成新的 */
  id: string
  tick: number
  clock: ClockState
  config: DrillConfig
  status: 'editing' | 'running' | 'finished'
  /** 社区模型版本（演练开始时锁定） */
  communityVersion: string
  communityName: string
  /** 当前灾种 */
  disaster: DisasterKind
  /** 封路状态：路段 ID → 证据 */
  closures: Record<string, RoadClosureEvidence>
  /** 已生效的统一影响事件：eventId → 事件 */
  impacts: Record<string, import('../disaster/types.ts').ImpactEvent>
  /** 不可通行的楼栋入口：入口节点键 → 影响事件 */
  blockedDoors: Record<string, import('../disaster/types.ts').ImpactEvent>
  /** 不可用的接驳点：接驳点 ID → 影响事件 */
  blockedStaging: Record<string, import('../disaster/types.ts').ImpactEvent>
  /** 当前水深：路段 ID → 米 */
  depths: Record<string, number>
  inventory: Record<string, InventoryPoint>
  tasks: Task[]
  agents: Agent[]
  /** 专业救援力量（消防等）：独立响应单元，不参与派单但参与展示 */
  responders: Responder[]
  evacuation: import('./evacuation.ts').EvacuationGroup[]
  evacuationCompletedAt?: SimTime
  rescuePriority?: import('./evacuation.ts').RescuePriority
  rescueTeams?: 1 | 2
  /** 当前生效的派单：taskId → planId */
  assignments: Record<string, string>
  plans: Record<string, Plan>
  planSets: Record<string, PlanSet>
  /** 被替换/历史方案 */
  superseded: string[]
  events: SimEvent[]
  record: DrillRecord
  /** 上次快照时刻，由模拟器维护 */
  snapshotAt: SimTime
  /** 演练数据/真实数据标志 */
  dataMode: { map: 'amap' | 'fallback'; lbs: 'amap' | 'sample'; ai: 'off' | 'on' }
}
