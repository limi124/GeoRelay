/**
 * 指挥台（C）HUD：左上任务卡、右上图例与判据入口、底部接力条与确认改派。
 *
 * 这里只做展示与回调，所有判断（能不能确认、受阻原因是什么）都在 App 里由
 * 规划器/演练状态算出后传进来，避免界面上出现第二套规则。
 */

import { useEffect, useRef, type ReactNode } from 'react'
import type { Candidate, DisasterKind, ExternalLeg, Plan, Responder, Task } from '../domain/sim/types.ts'
import { RESCUE_PRIORITY_LABELS, type EvacuationGroup, type RescuePriority } from '../domain/sim/evacuation.ts'
import type { Engine } from '../domain/sim/engine.ts'
import { RANKING_LABELS, type RankingMode } from '../domain/sim/ranker.ts'

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
  awaitingApproval: boolean
  relay: HudRelay
  canConfirm: boolean
  confirmNote: string
  onConfirm(): void
  onOpenJudgement(): void
  onOpenCandidates(): void
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
  activity: Array<{ id: string; time: string; message: string; onFocus?: () => void }>
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
        <polyline points={projected.map((p) => p.join(',')).join(' ')} fill="none" stroke="#75BFFF" strokeWidth="2.5" strokeDasharray={leg.routeSource === 'sample' ? '5 4' : undefined} />
        <circle cx={projected[0][0]} cy={projected[0][1]} r="4" fill="#75BFFF" />
        <rect x={last[0] - 4} y={last[1] - 4} width="8" height="8" fill="#9FF0B8" />
      </svg>
      <span title={leg.pharmacy.name}>{leg.pharmacy.name}</span>
      <small>{leg.routeSource === 'amap' ? '高德驾车路线' : '演练示例路线'} · {(leg.distanceM / 1000).toFixed(1)} km</small>
    </section>
  )
}

export function SandboxHud(props: SandboxHudProps): React.ReactElement {
  const activityList = useRef<HTMLOListElement>(null)
  const latestActivity = props.activity[0]?.id
  useEffect(() => {
    const list = activityList.current
    if (!list) return
    const paused = () => list.matches(':hover, :focus-within')
    if (!paused()) list.scrollTo({ top: 0, behavior: 'instant' })
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const timer = window.setInterval(() => {
      const row = list.firstElementChild?.getBoundingClientRect().height ?? 0
      const end = list.scrollHeight - list.clientHeight
      if (!row || end < 1 || paused() || motion.matches) return
      const next = (Math.round(list.scrollTop / row) + 1) * row
      list.scrollTo({ top: list.scrollTop >= end - 1 ? 0 : Math.min(next, end), behavior: 'smooth' })
    }, 3000)
    return () => window.clearInterval(timer)
  }, [latestActivity])

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
  const decisionTitle = props.aiPlanning ? 'AI 正在核对演练状态' : currentStep >= 0 ? planningSteps[currentStep][1] : props.planning?.stage === 'error' ? '规划中断' : props.confirmed ? '改派已确认' : props.canConfirm ? '候选待指挥员确认' : props.planning?.stage === 'ready' ? '本轮规划完成' : '等待灾情变化'
  return (
    <>
      <section className="dispatch-decision" data-testid="agent-planning" aria-label="Agent 决策">
        <div className="dispatch-decision-state" role="status">
          <span>Agent 决策</span>
          <strong>{decisionTitle}</strong>
          <select className="input input-compact dispatch-ranker" aria-label="候选排序策略" value={props.rankingPreference} disabled={props.rankingDisabled} onChange={(event) => props.onRankingPreference(event.target.value === 'rl' ? 'rl' : 'rules')}>
            <option value="rules">{RANKING_LABELS.rules}</option>
            <option value="rl">{RANKING_LABELS.rl}</option>
          </select>
        </div>
        <div className="dispatch-decision-main">
          <ol aria-label="规划阶段">
            {planningSteps.map(([stage, label], index) => <li key={stage} data-state={currentStep === index ? 'active' : currentStep > index || props.planning?.stage === 'ready' ? 'done' : 'pending'}>{label}</li>)}
          </ol>
          <p title={props.rankingNote}>{props.aiPlanning ? '核对灾情、受阻任务与候选校验结果' : currentStep >= 0 || props.planning?.stage === 'error' ? props.planning?.detail : props.candidate ? `${RANKING_LABELS[props.rankingMode ?? 'rules']}${props.rankingPreference === 'rl' && props.rankingMode === 'rules' && !props.confirmed ? '（回退）' : ''} · ${props.candidate.title}` : props.planning?.detail ?? '监测封路、封门与接驳点状态'}</p>
        </div>
        {props.candidate && currentStep < 0 && !props.aiPlanning ? <div className="dispatch-preview"><ul className="dispatch-checks" aria-label="候选校验">
          {props.candidate.checks.map((check) => <li key={check.id} data-pass={check.ok} title={check.detail}>{check.ok ? '✓' : '×'} {check.label}</li>)}
        </ul>{props.canConfirm && props.candidate.internal?.path.length ? <button type="button" className="sb-link" onClick={props.onPreviewCandidate}>预览候选路线</button> : null}</div> : null}
        <div className="dispatch-clock-controls" role="group" aria-label="演练时钟">{props.clockControls}</div>
      </section>
      <section className="hud-task" data-testid="hud-task" aria-labelledby="rescue-live-heading" data-plan-sets={props.dataPlanSets} data-impacts={props.dataImpacts} data-plan-phase={props.dataPlanPhase}>
        <h2 className="dispatch-panel-title" id="rescue-live-heading">救援实时信息</h2>
        <div className="hud-evacuation" data-testid="evacuation-summary">
          <header><strong>住户撤离</strong><button className="btn xs" data-testid="open-evacuation" onClick={props.onOpenEvacuation}>楼栋人数</button></header>
          <div className="evacuation-counts">
            <span><b>{arrived}/{total}</b>已撤出</span><span><b>{moving}</b>在途</span><span><b>{stranded}</b>待救援</span>
          </div>
          <progress max={Math.max(total, 1)} value={arrived} aria-label="全社区撤离进度" />
          <small>待下令 {awaiting} 人 · 待出楼 {atDoor} 人 · 转运 {rescuing} 人</small>
          <small>每批 5–30 人 · 出口排队 {gateQueue} 人</small>
          <label className="rescue-strategy">
            <strong>专业救援策略</strong>
            <select className="input" value={props.rescuePriority} onChange={(event) => props.onRescuePriority(event.target.value as RescuePriority)}>
              {Object.entries(RESCUE_PRIORITY_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <small>{props.rescuePriority === 'efficiency' ? '按预计单位时间转运人数排序' : '按已标记重点户数排序，同分按转运效率'}</small>
          <label className="rescue-strategy">
            <strong>消防力量配置</strong>
            <select className="input" value={props.rescueTeams} disabled={props.respondersDispatched > 0} onChange={(event) => props.onRescueTeams(event.target.value === '2' ? 2 : 1)}>
              <option value={1}>单组转运</option>
              <option value={2}>双组并行转运</option>
            </select>
          </label>
          {props.respondersDispatched > 0 ? <small>消防到场 {props.respondersArrived}/{props.respondersDispatched} 组</small> : null}
          {props.activeRescueBuildings.length ? <small>消防正在转运 · {props.activeRescueBuildings.join('、')}</small> : null}
          {props.rescueQueue.length ? <small>下一批待援 · {props.rescueQueue.join(' → ')}</small> : null}
          {awaiting > 0 ? <button className="btn sm primary" data-testid="order-all-rescue" onClick={props.onOrderAll}>启动全社区救援</button> : null}
        </div>
        <div className="responder-status" data-testid="responder-status">
          <strong>{props.responder ? `${props.responder.name} · ${props.responder.status === 'arrived' ? '已到场' : '出警中'}` : '消防力量 · 待命'}</strong>
          {props.responder ? <>
            <span>前往 {props.responder.targetName}</span>
            <span>{props.responder.status === 'arrived' ? rescuing ? `正在模拟转运 ${rescuing} 人` : '已到集结点' : `剩余约 ${Math.ceil(props.responder.remainingS)} 演练秒 · ${Math.round(props.responder.progress * 100)}%`}</span>
            <progress aria-label="消防出警进度" max={1} value={props.responder.progress} />
            <span className="field-hint">模拟路线 · 假设 80 km/h</span>
            <div className="row">
              <button className="btn xs" onClick={props.onViewResponder} data-testid="view-response">出警全程</button>
              <button className="btn xs" onClick={props.onFollowResponder} aria-pressed={props.followingResponder} data-testid="follow-response">{props.followingResponder ? '停止跟随' : '跟随消防车'}</button>
            </div>
          </> : null}
        </div>
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
        {props.evacuationComplete ? (
          <div className="hud-ended" data-testid="hud-ended">
            <strong>全员已撤离 · {arrived}/{total} 人</strong>
            <span>{props.drillEnded ? '所有住户均已到达围栏外集结点。' : '灾情监测与物资保障继续。'}</span>
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
        ) : (
          <div className="hud-ok" data-testid="hud-blocked">当前无受阻事件</div>
        )}
        {props.awaitingApproval ? (
          <p className="hud-hint">备用路线已生成，等待指挥员确认（系统不会自动改派）。</p>
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

      <aside className="hud-legend" data-testid="hud-legend" aria-labelledby="rescue-analysis-heading">
        <header className="hud-legend-head">
          <h2 className="dispatch-panel-title" id="rescue-analysis-heading">救援研判</h2>
          {!props.preventionOpen ? <button className="btn sm dispatch-analysis" onClick={props.onOpenAnalysis} disabled={props.analyzing} data-testid="open-analysis">{props.analyzing ? 'AI 研判中' : 'AI 研判'}</button> : null}
        </header>
        <button className="btn sm dispatch-analysis" type="button" aria-pressed={props.preventionOpen} onClick={props.onTogglePrevention}>{props.preventionOpen ? '返回实时救援研判' : '查看防灾建设评估'}</button>
        {props.preventionOpen ? props.preventionPanel : props.analysisPanel}
        <div className="hud-legend-actions">
          <button className="btn sm" onClick={props.onOpenCandidates} data-testid="open-candidates">
            候选 {props.feasibleCount}/{props.candidateCount}
          </button>
          <button className="btn sm" onClick={props.onOpenJudgement} data-testid="open-judgement">
            查看判据
          </button>
        </div>
        <details className="dispatch-legend"><summary>地图图例</summary><ul className="hud-legend-list">
          <li><span className="lg-line is-active" />已生效路线</li>
          <li><span className="lg-line is-pending" />待确认候选</li>
          <li><span className="lg-line is-original" />原路线（封路）</li>
          <li><span className="lg-dot is-blocked" />受阻点</li>
          <li><span className="lg-line is-fence" />电子围栏</li>
          <li><span className="lg-dot role-internal" />社区内部志愿者 · 配送/接力</li>
          <li><span className="lg-dot role-external" />外部志愿者 · 物资支援</li>
          <li><span className="lg-dot role-firefighter" />消防员 · 专业救援响应</li>
          <li><span className="lg-line hud-evacuation-key" />撤离路线</li>
          <li><span className="lg-dot risk-key" />薄弱楼栋缓冲区</li>
          {!props.externalView ? <li><span className={`lg-line hazard-key ${props.disaster}`} />{props.disaster === 'flood' ? '积水路段' : props.disaster === 'fire' ? '烟雾影响范围' : '受损楼栋、断路'}</li> : null}
          {!props.externalView ? <li className="lg-note">影响区颜色越深，影响程度越高</li> : null}
        </ul></details>
        {!props.externalView && props.externalLeg && props.externalLeg.path.length >= 2 ? <ExternalRouteInset leg={props.externalLeg} onOpen={props.onToggleExternal} /> : null}
      </aside>

      <section className="dispatch-activity" aria-label="调度动态">
        <h2>调度动态</h2>
        {props.activity.length ? <ol ref={activityList} tabIndex={0} aria-label="调度事件列表">{props.activity.map((entry) => <li key={entry.id}>
          <time>{entry.time}</time>
          {entry.onFocus ? <button type="button" title={entry.message} onClick={entry.onFocus}>{entry.message}</button> : <span title={entry.message}>{entry.message}</span>}
        </li>)}</ol> : <p>暂无调度事件</p>}
      </section>
      <section className="hud-relay" data-testid="hud-relay" aria-label="物资接力">
        <div className="relay-steps">
          <div className="relay-step">
            <span className="relay-icon" aria-hidden>✚</span>
            <span className="relay-k">药店</span>
            <span className="relay-v">{props.relay.pharmacy}</span>
          </div>
          <span className="relay-arrow" aria-hidden>→</span>
          <div className="relay-step">
            <span className="relay-icon" aria-hidden>◫</span>
            <span className="relay-k">接驳点</span>
            <span className="relay-v">{props.relay.via}</span>
          </div>
          <span className="relay-arrow" aria-hidden>→</span>
          <div className="relay-step">
            <span className="relay-icon" aria-hidden>▤</span>
            <span className="relay-k">目标楼栋</span>
            <span className="relay-v">{props.relay.target}</span>
          </div>
        </div>
        <div className="relay-action">
          <button
            className="btn primary relay-confirm"
            onClick={props.onConfirm}
            disabled={!props.canConfirm}
            data-testid="confirm-reroute"
            title={props.confirmNote}
          >
            确认改派
          </button>
          <span className="relay-note">{props.confirmNote}</span>
        </div>
      </section>
    </>
  )
}
