import type { DisasterKind } from '../domain/sim/types.ts'
import type { DisasterPlan, ImpactEvent } from '../domain/disaster/types.ts'
import type { ModelRunIndexEntry } from '../domain/modelrun/registry.ts'
import { MODEL_RUNS, modelBundleOf } from '../domain/modelrun/registry.ts'
import { PROVENANCE_LABEL } from '../domain/modelrun/types.ts'
import { engineLabel } from './modelRunLabel.ts'

/**
 * 灾种切换与灾情证据面板。
 *
 * 三个灾种各有一个固定、可复跑的示例场景；切换灾种会开一场新演练
 * （清空上一场的封路/候选/派单/AI 分析），但保留社区模型。
 *
 * 数据来源在这里显式分层：
 *  - 专业模型算例（FDS / OpenQuake）：数值来自求解器输出文件，入口按灾种分组；
 *  - 简化演示：GeoRelay 内置公式，不是求解器输出。
 * 徽标随当前演练的来源同步变化，避免把演示公式说成模型结论。
 */

export interface DisasterUiState {
  kind: DisasterKind
  scenarioTitle: string
  scenarioSummary: string
  fixedInputs: string[]
  impacts: ImpactEvent[]
  selectedImpactId: string | null
  /** 未来事件（尚未发生），用于“接下来会发生什么” */
  upcoming: ImpactEvent[]
  running: boolean
}

export interface DisasterBarProps {
  ui: DisasterUiState
  busy: boolean
  onSwitch(kind: DisasterKind): void
  onSelectImpact(id: string): void
  /** 当前演练来源（专业模型算例时非空；简化演示为空） */
  provenance: DisasterPlan['provenance'] | null
  /** 开始一场专业模型算例回放（由 App 创建预置社区 + 模型引擎） */
  onStartModelRun(runId: string): void
  /** 模型回放 ↔ 简化演示：用同一灾种重建引擎 */
  onSwitchProvenance(level: 'model' | 'simplified'): void
  /** 滚到「模型证据」面板（两层证据在侧栏下方，长列表里给一个跳转） */
  onJumpToEvidence(): void
}

const KIND_LABEL: Record<DisasterKind, string> = { flood: '内涝', fire: '火灾', earthquake: '地震' }
const MODEL_LABEL: Record<'fds' | 'openquake', string> = { fds: 'FDS', openquake: 'OpenQuake' }

/** 当前来源徽标文案：模型回放必须带引擎版本与算例 ID，简化演示必须写明不是求解器输出 */
function provenanceBadgeText(provenance: DisasterPlan['provenance'] | null): string {
  if (provenance && provenance.level !== 'simplified') {
    return `${PROVENANCE_LABEL[provenance.level]} · ${engineLabel(provenance.model, provenance.engineVersion)} · ${provenance.caseId}`
  }
  return '简化演示 · GeoRelay 内置公式（非求解器输出）'
}

function startable(run: ModelRunIndexEntry): boolean {
  return run.status === 'ok' && run.available && modelBundleOf(run.runId) !== null
}

function runTitle(run: ModelRunIndexEntry): string {
  if (run.status !== 'ok') return `求解器未成功运行：${run.failure?.message ?? '无详情'}`
  if (!run.available) return '算例不可用'
  if (!modelBundleOf(run.runId)) return '回放包缺失：请重跑 npm run model:ingest'
  return `${run.title ?? run.caseId} · ${run.engineVersion}（采样点 ${run.sampleCount ?? 0} / 资产 ${run.assetCount ?? 0} / 事件 ${run.eventCount ?? 0}）`
}

export function DisasterBar(props: DisasterBarProps): React.ReactElement {
  const { ui } = props
  const selected = ui.impacts.find((i) => i.id === ui.selectedImpactId) ?? null
  const isModel = Boolean(props.provenance && props.provenance.level !== 'simplified')
  const fireRuns = MODEL_RUNS.filter((r) => r.disaster === 'fire')
  const quakeRuns = MODEL_RUNS.filter((r) => r.disaster === 'earthquake')
  const availableRun = MODEL_RUNS.find((r) => r.disaster === ui.kind && startable(r)) ?? null
  const badgeText = provenanceBadgeText(props.provenance)

  return (
    <>
      {/* 数据来源：徽标 + 模型回放 ↔ 简化演示 */}
      <section className="panel" data-testid="provenance-panel">
        <div className="panel-header">
          <span className="panel-title">数据来源</span>
          <span className={`badge ${isModel ? 'info' : 'muted'}`}>{isModel ? '模型回放' : '简化演示'}</span>
        </div>
        <div className="panel-body stack-sm">
          <div
            className={`provenance-line ${isModel ? 'is-model' : 'is-simplified'}`}
            data-testid="provenance-badge"
            data-provenance={isModel ? 'model' : 'simplified'}
            title={isModel ? '数值来自求解器输出文件（FDS / OpenQuake）' : 'GeoRelay 内置公式演示，不是求解器输出'}
          >
            {badgeText}
          </div>
          <div className="btn-group" data-testid="provenance-switch">
            <button
              className={`btn sm ${isModel ? 'is-active' : ''}`}
              data-testid="provenance-to-model"
              onClick={() => props.onSwitchProvenance('model')}
              disabled={props.busy || isModel || !availableRun}
              aria-pressed={isModel}
              title={
                availableRun
                  ? `切换到专业模型算例回放：${availableRun.caseId}（${engineLabel(availableRun.model, availableRun.engineVersion)}）`
                  : '当前灾种没有可用的专业模型算例（先运行 npm run model:run:fds / npm run model:run:oq）'
              }
            >
              模型回放
            </button>
            <button
              className={`btn sm ${isModel ? '' : 'is-active'}`}
              data-testid="provenance-to-simplified"
              onClick={() => props.onSwitchProvenance('simplified')}
              disabled={props.busy || !isModel}
              aria-pressed={!isModel}
              title="切回 GeoRelay 内置公式演示（同一灾种，重新开始演练）"
            >
              简化演示
            </button>
          </div>
          {isModel ? (
            <button className="btn sm ghost block" data-testid="jump-to-evidence" onClick={props.onJumpToEvidence}>
              查看两层证据 ↓
            </button>
          ) : null}
          <p className="field-hint">
            {isModel
              ? '当前演练由专业模型算例驱动：灾情数值来自求解器输出，是否受阻由单独的演练通行规则判定（见「模型证据」面板）。'
              : '当前演练使用 GeoRelay 内置公式生成灾情（不是求解器输出）；载入专业模型算例后，同一界面会显示两层证据。'}
          </p>
        </div>
      </section>

      {/* 专业模型算例入口：按灾种分组 */}
      <section className="panel" data-testid="model-runs-panel">
        <div className="panel-header">
          <span className="panel-title">专业模型算例</span>
          <span className="badge muted">{MODEL_RUNS.length} 个归档</span>
        </div>
        <div className="panel-body stack-sm">
          {MODEL_RUNS.length === 0 ? (
            <div className="notice info" data-testid="model-runs-empty">
              暂无算例（先运行 npm run model:run:fds / model:run:oq）
            </div>
          ) : (
            <>
              <ModelRunGroup title="火灾算例" model="fds" runs={fireRuns} busy={props.busy} onStart={props.onStartModelRun} />
              <ModelRunGroup title="地震算例" model="openquake" runs={quakeRuns} busy={props.busy} onStart={props.onStartModelRun} />
              <p className="field-hint">
                模型算例使用预置演练社区（与「一键演练」同一套固定社区），不会覆盖你在编辑台保存的社区模型。
                算例由求解器运行 + <code>npm run model:ingest</code> 归档，Web 只读缓存产物。
              </p>
            </>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">灾情</span>
          <span className="data-flag">演练模拟</span>
        </div>
        <div className="panel-body stack-sm">
          <div className="btn-group" data-testid="disaster-switch">
            {(['flood', 'fire', 'earthquake'] as DisasterKind[]).map((k) => (
              <button
                key={k}
                className={`btn sm ${ui.kind === k ? 'is-active' : ''}`}
                onClick={() => props.onSwitch(k)}
                disabled={props.busy || ui.kind === k}
                aria-pressed={ui.kind === k}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <p className="field-hint">切换灾种会开启新演练：清空封路、候选、派单与 AI 分析，保留社区模型。</p>
          <div className="panel">
            <div className="panel-body stack-sm">
              <div className="row-between">
                <strong>{ui.scenarioTitle}</strong>
                <span className="badge muted">{KIND_LABEL[ui.kind]}示例</span>
              </div>
              <p className="field-hint">{ui.scenarioSummary}</p>
              <ul className="field-hint" style={{ margin: 0, paddingLeft: 18 }}>
                {ui.fixedInputs.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">影响事件</span>
          <span className="badge muted">{ui.impacts.length}</span>
        </div>
        <div className="panel-body stack-sm">
          {ui.impacts.length === 0 ? (
            <div className="empty">
              <div className="empty-title">还没有生效的影响事件</div>
              <div className="empty-hint">开始演练后，{KIND_LABEL[ui.kind]}影响会按演练时钟依次生效</div>
            </div>
          ) : (
            ui.impacts.slice(-12).reverse().map((ev) => (
              <button
                key={ev.id}
                className={`task-card ${ui.selectedImpactId === ev.id ? 'is-selected' : ''}`}
                onClick={() => props.onSelectImpact(ev.id)}
                data-testid={`impact-${ev.targetType}`}
              >
                <div className="row-between">
                  <strong>{ev.targetName}</strong>
                  <span className={`badge ${ev.traffic === 'blocked' ? 'warn' : 'info'}`}>{ev.level}</span>
                </div>
                <div className="field-hint">
                  {targetTypeLabel(ev.targetType)}· {ev.traffic === 'blocked' ? '不可通行' : ev.traffic === 'restricted' ? '受限' : '恢复'} · 演练 {formatAt(ev.at)}
                </div>
              </button>
            ))
          )}
          {ui.upcoming.length ? (
            <p className="field-hint">后续还将发生 {ui.upcoming.length} 起影响事件（按演练时钟推进）。</p>
          ) : null}
        </div>
      </section>

      {selected ? (
        <section className="panel" data-testid="impact-detail">
          <div className="panel-header">
            <span className="panel-title">影响详情</span>
            <span className="data-flag">演练模拟</span>
          </div>
          <div className="panel-body stack-sm">
            <div className="row-between">
              <strong>{selected.targetName}</strong>
              <span className={`badge ${selected.traffic === 'blocked' ? 'warn' : 'info'}`}>{selected.level}</span>
            </div>
            <p className="field-hint">{selected.reason}</p>
            <div className="field-hint">来源：{sourceLabel(selected)}</div>
            <div className="field-hint">发生时刻：演练 {formatAt(selected.at)}（演练开始后 {Math.round(selected.at)} 秒）</div>
            <div className="field-hint">判定依据：</div>
            <ul className="field-hint" style={{ margin: 0, paddingLeft: 18 }}>
              {selected.basis.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
            {selected.metrics ? (
              <div className="field-hint">
                指标：
                {[
                  selected.metrics.depthM !== undefined ? `水深 ${selected.metrics.depthM.toFixed(2)} m` : null,
                  selected.metrics.thresholdM !== undefined ? `阈值 ${selected.metrics.thresholdM.toFixed(2)} m` : null,
                  selected.metrics.smokeRadiusM !== undefined ? `烟雾前锋 ${selected.metrics.smokeRadiusM.toFixed(0)} m` : null,
                  selected.metrics.distanceToIgnitionM !== undefined ? `距起火点 ${selected.metrics.distanceToIgnitionM.toFixed(0)} m` : null,
                  selected.metrics.damageRatio !== undefined ? `受损指数 ${selected.metrics.damageRatio.toFixed(2)}` : null,
                  selected.metrics.magnitude !== undefined ? `震级 ${selected.metrics.magnitude}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </>
  )
}

function ModelRunGroup(props: {
  title: string
  model: 'fds' | 'openquake'
  runs: ModelRunIndexEntry[]
  busy: boolean
  onStart(runId: string): void
}): React.ReactElement {
  return (
    <div className="model-run-group" data-testid={`model-run-group-${props.model}`}>
      <div className="row-between">
        <strong className="field-label">{props.title}</strong>
        <span className="badge muted">{MODEL_LABEL[props.model]}</span>
      </div>
      {props.runs.length === 0 ? (
        <p className="field-hint">暂无{props.title}（先运行 npm run model:run:{props.model === 'fds' ? 'fds' : 'oq'}）</p>
      ) : (
        <div className="model-run-list">
          {props.runs.map((run) => (
            <button
              key={run.runId}
              className="btn sm"
              data-testid={`model-run-${run.runId}`}
              data-run-status={run.status}
              onClick={() => props.onStart(run.runId)}
              disabled={props.busy || !startable(run)}
              title={runTitle(run)}
            >
              {run.caseId}
              {run.status !== 'ok' ? '（失败）' : run.available ? '' : '（不可用）'}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function targetTypeLabel(t: ImpactEvent['targetType']): string {
  return t === 'road' ? '路段' : t === 'entrance' ? '楼栋入口' : t === 'staging' ? '接驳点' : '楼栋'
}

function sourceLabel(ev: ImpactEvent): string {
  if (ev.evidence) return `${ev.evidence.model === 'fds' ? 'FDS' : 'OpenQuake'} 算例 ${ev.evidence.caseId}（模型输出 + 演练规则）`
  if (ev.disaster === 'fire') return '火灾烟雾扩散（起火点 + 固定演练延迟）'
  if (ev.disaster === 'earthquake') return '地震受损判定（震级 + 震中距 + 楼层放大 + 固定种子）'
  return '内涝积水（按演练时钟涨水，达到阈值封路）'
}

function formatAt(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.round(t % 60)
  return `+${m}分${String(s).padStart(2, '0')}秒`
}
