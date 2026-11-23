/**
 * 指挥台工作区：任务、按需分析，以及当前候选的确认操作。
 *
 * 这里只做展示与回调，所有判断（能不能确认、受阻原因是什么）都在 App 里由
 * 规划器/演练状态算出后传进来，避免界面上出现第二套规则。
 */

import { useRef, type ReactNode } from 'react'
import type { Candidate, DisasterKind, ExternalLeg, Plan, Responder, Task } from '../domain/sim/types.ts'
import { RESCUE_PRIORITY_LABELS, type EvacuationGroup, type RescuePriority } from '../domain/sim/evacuation.ts'
import type { Engine } from '../domain/sim/engine.ts'
import { RANKING_LABELS, type RankingMode } from '../domain/sim/ranker.ts'
import { MAP_COLORS } from '../map/palette.ts'
import { DispatchActivity, type DispatchActivityEntry } from './DispatchActivity.tsx'

export interface HudBlocked {
  title: string
  detail: string
}

export interface HudRelay {
  pharmacy: string
  via: string
  target: string
}

export interface SandboxHudProps {
  taskCode: string | null
  taskTitle: string | null
  taskNeed: string | null
  taskWindow: string | null
  targetName: string | null
  blocked: HudBlocked | null
  relay: HudRelay
  canConfirm: boolean
  confirmNote: string
  onConfirm(): void
  onOpenCandidates(): void
  analysisOpen: boolean
  onToggleAnalysis(): void
  candidateCount: number
  feasibleCount: number
  externalView: boolean
  responder: Responder | null
  followingResponder: boolean
  onViewResponder(): void
  onFollowResponder(): void
  onOpenAnalysis(): void
  onShowClosure?: () => void
  onOpenEvacuation(): void
  evacuation: EvacuationGroup[]
  rescuePriority: RescuePriority
  onRescuePriority(priority: RescuePriority): void
  rescueTeams: 1 | 2
  respondersDispatched: number
  respondersArrived: number
  onRescueTeams(teams: 1 | 2): void
  rescueQueue: string[]
  activeRescueBuildings: string[]
  analysisPanel: ReactNode
  preventionPanel: ReactNode
  preventionOpen: boolean
  onTogglePrevention(): void
  analyzing: boolean
  disaster: DisasterKind
  externalLeg: ExternalLeg | null
  totalResidents: number
  planning?: Engine['planning']
  aiPlanning: boolean
  clockControls: ReactNode
  onOrderAll(): void
  onToggleExternal(): void
  onFocusTask(): void
  tasks: Array<{ task: Task; plan?: Plan }>
  activeTaskId: string | null
  onSelectTask(id: string): void
  candidate: Candidate | null
  rankingMode?: RankingMode
  rankingPreference: 'rules' | 'rl'
  rankingNote?: string
  rankingDisabled: boolean
  onRankingPreference(preference: 'rules' | 'rl'): void
  confirmed: boolean
  onPreviewCandidate(): void
  activity: DispatchActivityEntry[]
  /** 调试/验收用：当前预案集数量、已发生影响事件数、选中方案阶段 */
  dataPlanSets: number
  dataImpacts: number
  dataPlanPhase: string
  /** 演练是否已到设定时长（时钟停在窗口末尾，不是卡死） */
  drillEnded?: boolean
  evacuationComplete: boolean
}

const PHASE_LABELS: Record<Plan['phase'], string> = {
  planned: '待出发', external_enroute: '外部取货', external_arrived: '已到入口', pickup_wait: '取货中',
  internal_ready: '待配送', handover_wait: '等待交接', delivering: '配送中', delivered: '已送达',
  blocked: '路线受阻', assist_handovers_pending: '等待支援',
}

function ExternalRouteInset({ leg, onOpen }: { leg: ExternalLeg; onOpen(): void }): React.ReactElement {
  const [lng, lat] = leg.path[0]
  const points = leg.path.map(([x, y]) => [(x - lng) * Math.cos(lat * Math.PI / 180), lat - y])
  const left = Math.min(...points.map(([x]) => x))
  const top = Math.min(...points.map(([, y]) => y))
  const width = Math.max(...points.map(([x]) => x)) - left
  const height = Math.max(...points.map(([, y]) => y)) - top
  const scale = Math.min(200 / (width || 1e-6), 54 / (height || 1e-6))
  const projected = points.map(([x, y]) => [12 + (x - left) * scale + (200 - width * scale) / 2, 10 + (y - top) * scale + (54 - height * scale) / 2])
  const last = projected[projected.length - 1]
  return (
    <section className="hud-external-route" aria-label="圈外支援路线" data-testid="external-route-inset">
      <header><strong>圈外支援</strong><button className="sb-link" onClick={onOpen}>完整地图</button></header>
      <svg viewBox="0 0 224 74" role="img" aria-label="物资点至社区的外部路线">
        <polyline points={projected.map((p) => p.join(',')).join(' ')} fill="none" stroke="var(--gr-info)" strokeWidth="2.5" strokeDasharray={leg.routeSource === 'sample' ? '5 4' : undefined} />
        <circle cx={projected[0][0]} cy={projected[0][1]} r="4" fill="var(--gr-info)" />
        <rect x={last[0] - 4} y={last[1] - 4} width="8" height="8" fill="var(--gr-brand)" />
      </svg>
      <span title={leg.pharmacy.name}>{leg.pharmacy.name}</span>
      <small>{leg.routeSource === 'amap' ? '高德驾车路线' : '演练示例路线'} · {(leg.distanceM / 1000).toFixed(1)} km</small>
    </section>
  )
}

export function SandboxHud(props: SandboxHudProps): React.ReactElement {
  const analysisDetails = useRef<HTMLDetailsElement>(null)

  const residents = (status: EvacuationGroup['status']): number => props.evacuation.reduce((n, group) => n + (group.status === status ? group.residents : 0), 0)
  const arrived = residents('arrived')
  const moving = props.evacuation.reduce((n, group) => n + (group.status === 'moving' && group.departed ? group.residents : 0), 0)
  const atDoor = residents('queued') + residents('moving') - moving
  const gateQueue = props.evacuation.reduce((n, group) => n + (group.gateQueuedAt !== undefined ? group.residents : 0), 0)
  const rescuing = residents('rescuing')
  const stranded = residents('blocked')
  const total = props.totalResidents
  const awaiting = total - arrived - moving - atDoor - stranded - rescuing
  const planningSteps = [['impact', '检查影响'], ['routes', '搜索与校验'], ['rank', '比较候选']] as const
  const currentStep = planningSteps.findIndex(([stage]) => stage === props.planning?.stage)
  const decisionTitle = props.aiPlanning ? '正在研判' : currentStep >= 0 ? planningSteps[currentStep][1] : props.planning?.stage === 'error' ? '规划中断' : props.confirmed ? '改派已确认' : props.canConfirm ? '待确认改派' : props.planning?.stage === 'ready' ? '规划完成' : '灾情监测'
  return (
    <>
      <section className="dispatch-decision" data-testid="agent-planning" aria-label="Agent 决策">
        <div className="dispatch-decision-state" role="status">
          <strong>{decisionTitle}</strong>
          {props.taskCode ? <span className="dispatch-current-task">{props.taskCode} · {props.targetName}</span> : null}
          {props.planning?.stage === 'error' ? <span className="dispatch-status-detail">{props.planning.detail}</span> : null}
          {props.blocked ? props.onShowClosure
            ? <button className="sb-link dispatch-blocked-link" onClick={props.onShowClosure}>{props.blocked.title}</button>
            : <span className="dispatch-status-detail">{props.blocked.title}</span> : null}
        </div>
        {currentStep >= 0 ? <ol className="dispatch-stages" aria-label="规划阶段">
          {planningSteps.map(([stage, label], index) => <li key={stage} data-state={currentStep === index ? 'active' : currentStep > index ? 'done' : 'pending'}>{label}</li>)}
        </ol> : null}
        <div className="dispatch-clock-controls" role="group" aria-label="演练时钟">{props.clockControls}</div>
        <div className="dispatch-panel-actions">
          <button className="btn sm" onClick={props.onOpenCandidates} data-testid="open-candidates">候选与判据{props.candidateCount ? ` ${props.feasibleCount}/${props.candidateCount}` : ''}</button>
          <button className="btn sm desktop-analysis-toggle" type="button" data-testid="toggle-analysis" aria-expanded={props.analysisOpen} aria-controls="console-analysis" onClick={props.onToggleAnalysis}>分析</button>
        </div>
      </section>
      <section className="hud-task" data-testid="hud-task" aria-labelledby="rescue-live-heading" data-plan-sets={props.dataPlanSets} data-impacts={props.dataImpacts} data-plan-phase={props.dataPlanPhase}>
        <h2 className="dispatch-panel-title" id="rescue-live-heading">救援</h2>
        <div className="hud-evacuation" data-testid="evacuation-summary">
          <header><strong>住户撤离</strong><button className="btn xs" data-testid="open-evacuation" onClick={props.onOpenEvacuation}>楼栋人数</button></header>
          <div className="evacuation-counts">
            <span><b>{arrived}/{total}</b>已撤出</span><span><b>{moving}</b>在途</span><span><b>{stranded}</b>待救援</span>
          </div>
          <progress max={Math.max(total, 1)} value={arrived} aria-label="全社区撤离进度" />
          {awaiting > 0 ? <button className="btn sm primary" data-testid="order-all-rescue" onClick={props.onOrderAll}>下达全社区撤离</button> : null}
          <details className="hud-details" data-testid="rescue-settings">
            <summary>救援设置</summary>
            <div className="hud-details-body">
              <small>待下令 {awaiting} 人 · 待出楼 {atDoor} 人 · 转运 {rescuing} 人</small>
              <small>出口排队 {gateQueue} 人</small>
              <label className="rescue-strategy">
                <span>救援优先级</span>
                <select className="input" title={props.rescuePriority === 'efficiency' ? '优先转运单位时间内可救援人数更多的楼栋' : '优先转运重点住户，同分按转运效率'} value={props.rescuePriority} onChange={(event) => props.onRescuePriority(event.target.value as RescuePriority)}>
                  {Object.entries(RESCUE_PRIORITY_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>
              <label className="rescue-strategy">
                <span>消防组数</span>
                <select className="input" value={props.rescueTeams} disabled={props.respondersDispatched > 0} onChange={(event) => props.onRescueTeams(event.target.value === '2' ? 2 : 1)}>
                  <option value={1}>单组转运</option>
                  <option value={2}>双组并行转运</option>
                </select>
              </label>
            </div>
          </details>
          {props.respondersDispatched > 0 ? <small>消防到场 {props.respondersArrived}/{props.respondersDispatched} 组</small> : null}
          {props.activeRescueBuildings.length ? <small>消防正在转运 · {props.activeRescueBuildings.join('、')}</small> : null}
          {props.rescueQueue.length ? <small>下一批待援 · {props.rescueQueue.join(' → ')}</small> : null}
        </div>
        <details className="responder-status hud-details" data-testid="responder-status">
          <summary>{props.responder ? `${props.responder.name} · ${props.responder.status === 'arrived' ? '已到场' : '出警中'}` : '消防 · 待命'}</summary>
          {props.responder ? <div className="hud-details-body">
            <span>前往 {props.responder.targetName}</span>
            <span>{props.responder.status === 'arrived' ? rescuing ? `正在模拟转运 ${rescuing} 人` : '已到集结点' : `剩余约 ${Math.ceil(props.responder.remainingS)} 演练秒 · ${Math.round(props.responder.progress * 100)}%`}</span>
            <progress aria-label="消防出警进度" max={1} value={props.responder.progress} />
            <span className="field-hint">演练路线 · 80 km/h</span>
            <div className="row">
              <button className="btn xs" onClick={props.onViewResponder} data-testid="view-response">出警全程</button>
              <button className="btn xs" onClick={props.onFollowResponder} aria-pressed={props.followingResponder} data-testid="follow-response">{props.followingResponder ? '停止跟随' : '跟随消防车'}</button>
            </div>
          </div> : null}
        </details>
        <details className="hud-details hud-selected-task">
          <summary>{props.taskCode ? `${props.taskCode} · ${props.targetName}` : '任务详情'}</summary>
          <div className="hud-details-body">
            <header className="hud-task-head">
              <span className="hud-task-code">{props.taskCode ?? '无进行中任务'}</span>
              <button className="sb-link" onClick={props.onFocusTask}>聚焦任务</button>
            </header>
            {props.taskTitle ? <p className="hud-task-title">{props.taskTitle}</p> : null}
            <div className="hud-task-rows">
              {props.taskNeed ? <div className="hud-row"><span className="hud-k">物资</span><span>{props.taskNeed}</span></div> : null}
              {props.targetName ? <div className="hud-row"><span className="hud-k">目标</span><span>{props.targetName}</span></div> : null}
              {props.taskWindow ? <div className="hud-row"><span className="hud-k">时限</span><span>{props.taskWindow}</span></div> : null}
            </div>
          </div>
        </details>
        {props.evacuationComplete ? (
          <div className="hud-ended" data-testid="hud-ended">
            <strong>全员已撤离 · {arrived}/{total} 人</strong>
            {!props.drillEnded ? <span>物资保障继续</span> : null}
          </div>
        ) : null}
        {props.blocked ? (
          <div className="hud-blocked" data-testid="hud-blocked">
            <span className="hud-blocked-icon" aria-hidden>!</span>
            <div>
              <strong>{props.blocked.title}</strong>
              <span>{props.blocked.detail}</span>
              {props.onShowClosure ? <button className="sb-link" onClick={props.onShowClosure}>图上查看</button> : null}
            </div>
          </div>
        ) : null}
        <section className="dispatch-tasks" aria-label="物资调度任务">
          <header><strong>物资调度</strong><span>{props.tasks.filter(({ plan }) => plan?.phase === 'delivered').length}/{props.tasks.length} 已送达</span></header>
          <ul>{props.tasks.map(({ task, plan }) => <li key={task.id}>
            <button type="button" aria-pressed={task.id === props.activeTaskId} onClick={() => props.onSelectTask(task.id)}>
              <span><small>{task.code}</small> {task.targetName}</span>
              <span data-phase={plan?.phase}>{plan ? PHASE_LABELS[plan.phase] : '未派单'}</span>
              <progress max={1} value={plan?.phase === 'delivered' ? 1 : plan?.progress ?? 0} aria-label={`${task.code} 当前阶段进度`} />
            </button>
          </li>)}</ul>
        </section>
      </section>

      <aside className="hud-legend" id="console-analysis" data-testid="hud-legend" aria-labelledby="rescue-analysis-heading">
        <header className="hud-legend-head">
          <h2 className="dispatch-panel-title" id="rescue-analysis-heading">分析</h2>
          {!props.preventionOpen ? <button className="btn sm dispatch-analysis" onClick={() => { if (analysisDetails.current) analysisDetails.current.open = true; props.onOpenAnalysis() }} disabled={props.analyzing} data-testid="open-analysis">{props.analyzing ? 'AI 研判中' : 'AI 研判'}</button> : null}
        </header>
        <details className="hud-details hud-analysis-details" ref={analysisDetails}>
          <summary>薄弱点与救援建议</summary>
          <div className="hud-details-body">{props.analysisPanel}</div>
        </details>
        <button className="btn sm ghost" type="button" aria-expanded={props.preventionOpen} aria-controls="prevention-report" onClick={props.onTogglePrevention}>防灾建设评估</button>
        {props.preventionOpen ? <div id="prevention-report">{props.preventionPanel}</div> : null}
        <details className="hud-details" data-testid="planning-details">
          <summary>调度策略{props.candidate ? '与校验' : ''}</summary>
          <div className="hud-details-body">
            <label className="field">
              <span className="field-label">候选排序策略</span>
              <select className="input dispatch-ranker" value={props.rankingPreference} disabled={props.rankingDisabled} onChange={(event) => props.onRankingPreference(event.target.value === 'rl' ? 'rl' : 'rules')}>
                <option value="rules">{RANKING_LABELS.rules}</option>
                <option value="rl">{RANKING_LABELS.rl}</option>
              </select>
            </label>
            {props.candidate && currentStep < 0 && !props.aiPlanning ? <>
              <p className="field-hint">{props.candidate.title} · {RANKING_LABELS[props.rankingMode ?? 'rules']}{props.rankingPreference === 'rl' && props.rankingMode === 'rules' && !props.confirmed ? '（回退）' : ''}</p>
              {props.rankingNote ? <p className="field-hint">{props.rankingNote}</p> : null}
              <ul className="dispatch-checks" aria-label="候选校验">
                {props.candidate.checks.map((check) => <li key={check.id} data-pass={check.ok} title={check.detail}>{check.ok ? '✓' : '×'} {check.label}</li>)}
              </ul>
              {props.canConfirm && props.candidate.internal?.path.length ? <button type="button" className="sb-link" onClick={props.onPreviewCandidate}>预览候选路线</button> : null}
            </> : null}
          </div>
        </details>
        <details className="dispatch-legend hud-details"><summary>地图图例</summary><ul className="hud-legend-list">
          <li><span className="lg-line is-active" style={{ borderColor: MAP_COLORS.active }} />已生效路线</li>
          <li><span className="lg-line is-pending" style={{ borderColor: MAP_COLORS.pending }} />待确认候选</li>
          <li><span className="lg-line is-original" style={{ borderColor: MAP_COLORS.original }} />原路线</li>
          <li><span className="lg-dot is-blocked" style={{ background: MAP_COLORS.blocked }} />受阻点</li>
          <li><span className="lg-line is-fence" style={{ borderColor: MAP_COLORS.fence }} />电子围栏</li>
          <li><span className="lg-dot role-internal" style={{ background: MAP_COLORS.internal }} />内部志愿者</li>
          <li><span className="lg-dot role-external" style={{ background: MAP_COLORS.external }} />外部志愿者</li>
          <li><span className="lg-dot role-firefighter" style={{ background: MAP_COLORS.firefighter }} />消防员</li>
          <li><span className="lg-line hud-evacuation-key" style={{ borderColor: MAP_COLORS.evacuation }} />撤离路线</li>
          <li><span className="lg-dot risk-key" />薄弱楼栋缓冲区</li>
          {!props.externalView ? <li><span className={`lg-line hazard-key ${props.disaster}`} />{props.disaster === 'flood' ? '积水路段' : props.disaster === 'fire' ? '烟雾影响范围' : '受损楼栋、断路'}</li> : null}
          {!props.externalView ? <li className="lg-note">影响区颜色越深，影响程度越高</li> : null}
        </ul></details>
        {!props.externalView && props.externalLeg && props.externalLeg.path.length >= 2 ? <ExternalRouteInset leg={props.externalLeg} onOpen={props.onToggleExternal} /> : null}
      </aside>

      <DispatchActivity entries={props.activity} />
      {props.canConfirm && props.candidate ? <section className="hud-relay" data-testid="hud-relay" data-candidate-id={props.candidate.id} aria-label="确认当前改派方案">
        <button type="button" className="relay-selection" onClick={props.onOpenCandidates}>
          <strong>{props.taskCode} · {props.targetName}</strong>
          <span>{props.candidate.title}</span>
          <small>{props.relay.pharmacy} → {props.relay.via} → {props.relay.target}</small>
        </button>
        <div className="relay-action">
          <button
            className="btn primary relay-confirm"
            onClick={props.onConfirm}
            data-testid="confirm-reroute"
            title={props.confirmNote}
          >
            确认改派
          </button>
          <span className="relay-note">{props.confirmNote}</span>
        </div>
      </section> : null}
    </>
  )
}
