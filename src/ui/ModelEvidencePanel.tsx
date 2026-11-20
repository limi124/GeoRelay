import { useMemo, useState } from 'react'
import type { Engine } from '../domain/sim/engine.ts'
import type { ImpactEvent } from '../domain/disaster/types.ts'
import type { DrillRule, ModelDrillBundle } from '../domain/modelrun/types.ts'
import { PROVENANCE_LABEL } from '../domain/modelrun/types.ts'
import { engineLabel } from './modelRunLabel.ts'

/**
 * 两层证据面板：把「模型算出了什么」与「GeoRelay 按哪条演练规则判定」分开显示。
 *
 * 设计约束（避免把工程判据说成模型结论）：
 *  - 上半：只有求解器输出（FDS 探针能见度时程 / oQ 逐资产受损状态分布）与采样点、资产、时刻；
 *  - 下半：GeoRelay 的演练通行规则（阈值、比较方向、规则 ID）与它给出的结论；
 *  - 地震的道路/接驳点关闭来自独立设定文件，单独成块并明确标注「非模型结论」。
 *
 * 面板不修改演练状态：点击条目只做地图定位与选中，不改派单。
 */

type ModelEvidence = NonNullable<ImpactEvent['evidence']>
type EvidencedEvent = ImpactEvent & { evidence: ModelEvidence }

export interface ModelEvidencePanelProps {
  engine: Engine
  /** 点击证据：定位地图对象并选中对应任务/候选集 */
  onFocus(ev: ImpactEvent): void
}

const METRIC_LABEL: Record<string, string> = {
  visibility: '能见度',
  damage_complete: '倒塌概率',
  damage_extensive_plus: '严重及以上概率',
  damage_moderate_plus: '中等及以上概率',
  damage_slight_plus: '轻微及以上概率',
}

const COMPARATOR_TEXT: Record<DrillRule['comparator'], string> = { lt: '<', lte: '≤', gt: '>', gte: '≥' }

const TARGET_TEXT: Record<ImpactEvent['targetType'], string> = {
  road: '路段',
  entrance: '楼栋入口',
  staging: '接驳点',
  building: '楼栋',
}

const STATE_TEXT: Record<string, string> = {
  no_damage: '完好',
  slight: '轻微',
  moderate: '中等',
  extensive: '严重',
  complete: '倒塌',
}

function metricText(metric: string): string {
  return METRIC_LABEL[metric] ?? metric
}

function targetText(type: ImpactEvent['targetType']): string {
  return TARGET_TEXT[type] ?? type
}

function conclusionText(ev: ImpactEvent): string {
  if (ev.targetType === 'building') return `受损等级：${ev.level}`
  if (ev.traffic === 'blocked') return '不可通行'
  if (ev.traffic === 'restricted') return `受限（${ev.level}）`
  return '可通行'
}

function valueText(value: number | null, unit: string): string {
  if (value === null) return `缺测（${unit}）`
  const digits = Math.abs(value) < 1 ? 3 : 2
  return `${value.toFixed(digits)} ${unit}`
}

function matchesComparator(comparator: DrillRule['comparator'], value: number, threshold: number): boolean {
  if (comparator === 'lt') return value < threshold
  if (comparator === 'lte') return value <= threshold
  if (comparator === 'gt') return value > threshold
  return value >= threshold
}

function ruleOfMetric(rules: DrillRule[], metric: string): DrillRule | null {
  return rules.find((r) => r.metric === metric && r.consequence === 'blocked') ?? rules.find((r) => r.metric === metric) ?? null
}

function crossingOf(
  series: Array<{ t: number; value: number | null }>,
  rule: DrillRule,
): { t: number; value: number } | null {
  for (const p of series) {
    if (p.value === null) continue
    if (matchesComparator(rule.comparator, p.value, rule.threshold)) return { t: p.t, value: p.value }
  }
  return null
}

/** 极简 SVG 折线：横轴演练秒、纵轴指标值；画阈值横线与首次越阈点，不引入图表库 */
function SampleSeriesChart(props: { sample: ModelDrillBundle['samples'][number]; rules: DrillRule[] }): React.ReactElement {
  const { sample, rules } = props
  const W = 320
  const H = 132
  const padL = 40
  const padR = 12
  const padT = 14
  const padB = 24
  const rule = useMemo(() => ruleOfMetric(rules, sample.quantity), [rules, sample.quantity])
  const cross = useMemo(() => (rule ? crossingOf(sample.series, rule) : null), [sample.series, rule])

  const pts = sample.series.filter((p): p is { t: number; value: number } => p.value !== null)
  if (!pts.length) {
    return <div className="empty-hint">该采样点没有有效数值（缺测不插值）</div>
  }
  const tMin = sample.series[0]?.t ?? 0
  const tMax = sample.series[sample.series.length - 1]?.t ?? tMin + 1
  const values = pts.map((p) => p.value)
  if (rule) values.push(rule.threshold)
  const rawMin = Math.min(...values)
  let vMin = rawMin
  let vMax = Math.max(...values)
  if (vMax - vMin < 1e-9) {
    vMin -= 1
    vMax += 1
  }
  const spanV = vMax - vMin
  vMin -= spanV * 0.08
  vMax += spanV * 0.08
  // 指标都是非负量（能见度、概率）时不要出现负数刻度
  if (rawMin >= 0) vMin = Math.max(0, vMin)
  const spanT = Math.max(1e-9, tMax - tMin)
  const x = (t: number): number => padL + ((t - tMin) / spanT) * (W - padL - padR)
  const y = (v: number): number => padT + (1 - (v - vMin) / (vMax - vMin)) * (H - padT - padB)

  // 缺测处断开折线（不做插值）
  const segments: Array<Array<{ t: number; value: number }>> = []
  let cur: Array<{ t: number; value: number }> = []
  for (const p of sample.series) {
    if (p.value === null) {
      if (cur.length) segments.push(cur)
      cur = []
    } else {
      cur.push({ t: p.t, value: p.value })
    }
  }
  if (cur.length) segments.push(cur)

  const unit = sample.unit
  const midT = Math.round((tMin + tMax) / 2)
  return (
    <div className="evidence-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${sample.sampleId} 时程曲线`} preserveAspectRatio="none">
        <line x1={padL} y1={padT} x2={padL} y2={H - padB} className="evidence-axis" />
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} className="evidence-axis" />
        {[0, 0.5, 1].map((k) => {
          const v = vMax - (vMax - vMin) * k
          return (
            <g key={k}>
              <line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} className="evidence-grid" />
              <text x={padL - 4} y={y(v) + 3} textAnchor="end" className="evidence-tick">
                {Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(0)}
              </text>
            </g>
          )
        })}
        {rule ? (
          <g data-testid="evidence-threshold-line">
            <line x1={padL} y1={y(rule.threshold)} x2={W - padR} y2={y(rule.threshold)} className="evidence-threshold" />
            <text x={W - padR} y={y(rule.threshold) - 3} textAnchor="end" className="evidence-threshold-text">
              阈值 {rule.threshold} {rule.unit}
            </text>
          </g>
        ) : null}
        {segments.map((seg, i) => (
          <polyline
            key={i}
            className="evidence-line"
            points={seg.map((p) => `${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')}
          />
        ))}
        {cross ? (
          <g data-testid="evidence-crossing" className="evidence-crossing">
            <line x1={x(cross.t)} y1={padT} x2={x(cross.t)} y2={H - padB} className="evidence-crossing-line" />
            <circle cx={x(cross.t)} cy={y(cross.value)} r={3.5} className="evidence-crossing-dot" />
            <text x={Math.min(W - padR - 4, x(cross.t) + 6)} y={padT + 10} className="evidence-crossing-text">
              首次越阈 t={Math.round(cross.t)}s
            </text>
          </g>
        ) : null}
        <text x={padL} y={H - 8} className="evidence-tick">
          0s
        </text>
        <text x={x(midT)} y={H - 8} textAnchor="middle" className="evidence-tick">
          {Math.round(tMin + (tMax - tMin) / 2)}s
        </text>
        <text x={W - padR} y={H - 8} textAnchor="end" className="evidence-tick">
          {Math.round(tMax)}s
        </text>
        <text x={padL} y={padT - 4} className="evidence-tick">
          {unit}
        </text>
      </svg>
      <div className="field-hint">
        {sample.sampleId} · {sample.quantity}（{unit}）· {sample.targetType === 'entrance' ? '入口' : sample.targetType === 'road' ? '路段' : '接驳点'}「
        {sample.targetName}」· 影响圈 {sample.influenceRadiusM}m（示意）
      </div>
    </div>
  )
}

export function ModelEvidencePanel(props: ModelEvidencePanelProps): React.ReactElement | null {
  const { engine } = props
  const plan = engine.disaster.plan
  const bundle = engine.modelRun ?? null
  const provenance = plan.provenance ?? null
  const [sampleId, setSampleId] = useState<string | null>(null)

  if (!provenance) return null

  const events = plan.modelEvents ?? []
  const evidenced = events.filter((e): e is EvidencedEvent => Boolean(e.evidence))
  const samples = bundle?.samples ?? []
  const rules = bundle?.rules ?? []
  const closures = bundle?.closures ?? []
  const assets = bundle?.assets ?? []
  const selectedSample = samples.find((s) => s.sampleId === sampleId) ?? samples.find((s) => s.series.some((p) => p.value !== null)) ?? null
  const sourceLine = (ev: EvidencedEvent): string => `${ev.evidence.runId} / ${ev.evidence.engineVersion} / ${ev.evidence.caseId}`
  const probText = (assetId: string | undefined): string | null => {
    if (!assetId) return null
    const asset = assets.find((a) => a.assetId === assetId)
    if (!asset) return null
    return asset.states.map((s, i) => `${STATE_TEXT[s] ?? s} ${((asset.probs[i] ?? 0) * 100).toFixed(1)}%`).join(' · ')
  }

  return (
    <section className="panel" data-testid="model-evidence">
      <div className="panel-header">
        <span className="panel-title">模型证据（两层）</span>
        <span className="badge info">{PROVENANCE_LABEL[provenance.level]}</span>
      </div>
      <div className="panel-body stack-sm">
        {/* 算例范围：来源、命令、输入、时间 */}
        <div className="evidence-scope" data-testid="model-provenance-scope">
          <div className="row-between">
            <strong>算例范围</strong>
            <span className="badge muted">{engineLabel(provenance.model, provenance.engineVersion)}</span>
          </div>
          <p className="field-hint">{provenance.scope}</p>
          <div className="field-hint mono">caseId：{provenance.caseId} · runId：{provenance.runId}</div>
          <div className="field-hint mono">求解命令：{provenance.solverCommand ?? '未记录'}</div>
          <div className="field-hint mono">
            输入文件：{provenance.inputs.length ? provenance.inputs.map((i) => i.path).join('；') : '未记录'}
          </div>
          <div className="field-hint">运行时间：{provenance.ranAt ?? '未记录'}</div>
        </div>

        {/* 上半：模型算出了什么 */}
        <div className="evidence-layer" data-testid="model-layer">
          <div className="row-between">
            <strong className="evidence-layer-title">模型算出了什么</strong>
            <span className="badge muted">求解器输出 · 非判定</span>
          </div>
          {evidenced.length === 0 ? (
            <div className="empty">
              <div className="empty-title">这个算例没有可展示的模型事件</div>
              <div className="empty-hint">求解器输出与映射可能未被识别；请检查 src/data/model-runs 下的回放包</div>
            </div>
          ) : (
            <div className="stack-sm">
              {evidenced.map((ev, i) => {
                const evd = ev.evidence
                const isSample = Boolean(evd.sampleId)
                const prob = probText(evd.assetId)
                return (
                  <button
                    key={`${ev.id}-model`}
                    className="evidence-row"
                    data-testid={`model-evidence-row-${i}`}
                    onClick={() => props.onFocus(ev)}
                    title="定位到地图对象并选中对应任务/候选集"
                  >
                    <div className="row-between">
                      <strong>{ev.targetName}</strong>
                      <span className="badge muted">
                        {isSample ? `采样点 ${evd.sampleId}` : `资产 ${evd.assetId ?? '—'}`}
                      </span>
                    </div>
                    <div className="field-hint">
                      {targetText(ev.targetType)} · {metricText(evd.metric)} {valueText(evd.value, evd.unit)} · 演练 +
                      {Math.round(evd.atS)}s
                    </div>
                    {prob ? <div className="field-hint mono">受损状态分布：{prob}</div> : null}
                    <div className="field-hint mono">来源：{sourceLine(ev)}</div>
                  </button>
                )
              })}
            </div>
          )}

          {provenance.disaster === 'fire' && samples.length ? (
            <div className="evidence-chart-block">
              <div className="row-between">
                <strong className="evidence-layer-title">采样点能见度时程（FDS 输出）</strong>
                <span className="badge muted">{samples.length} 个探针</span>
              </div>
              {samples.length > 1 ? (
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  {samples.map((s) => (
                    <button
                      key={s.sampleId}
                      className={`chip ${selectedSample?.sampleId === s.sampleId ? 'is-active' : ''}`}
                      data-testid={`evidence-sample-${s.sampleId}`}
                      onClick={() => setSampleId(s.sampleId)}
                    >
                      {s.sampleId}
                    </button>
                  ))}
                </div>
              ) : null}
              {selectedSample ? <SampleSeriesChart sample={selectedSample} rules={rules} /> : null}
            </div>
          ) : null}
        </div>

        {/* 下半：GeoRelay 按哪条演练规则判定 */}
        <div className="evidence-layer" data-testid="rule-layer">
          <div className="row-between">
            <strong className="evidence-layer-title">GeoRelay 按哪条演练规则判定</strong>
            <span className="badge warn">演练判据 · 非模型结论</span>
          </div>
          {evidenced.length === 0 ? (
            <p className="field-hint">没有触发任何演练通行规则的事件。</p>
          ) : (
            <div className="stack-sm">
              {evidenced.map((ev, i) => {
                const evd = ev.evidence
                return (
                  <div key={`${ev.id}-rule`} className="evidence-rule" data-testid={`model-rule-row-${i}`}>
                    <div className="row-between">
                      <strong>规则 {evd.ruleId}</strong>
                      <span className={`badge ${ev.traffic === 'blocked' ? 'warn' : 'info'}`}>{conclusionText(ev)}</span>
                    </div>
                    <div className="field-hint">
                      {evd.ruleLabel} · 判据 {metricText(evd.metric)} {COMPARATOR_TEXT[evd.comparator]} {evd.threshold} {evd.unit}
                      {evd.value !== null ? `（模型值 ${valueText(evd.value, evd.unit)}）` : ''}
                    </div>
                    <div className="field-hint mono">模型层：{evd.layers.model}</div>
                    <div className="field-hint mono">判据层：{evd.layers.rule}</div>
                    <button className="btn sm ghost" onClick={() => props.onFocus(ev)}>
                      定位地图对象
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          {rules.length ? (
            <details className="evidence-rules-config">
              <summary className="field-hint">本次算例的演练通行规则（独立配置文件，改阈值只需重跑 model:ingest）</summary>
              <ul className="field-hint" style={{ margin: 0, paddingLeft: 18 }}>
                {rules.map((r) => (
                  <li key={r.id}>
                    {r.id} · {r.label} · 适用：{r.appliesTo.map((t) => targetText(t)).join('/')} · {r.note}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>

        {/* 地震：独立设定的道路/接驳点关闭 */}
        {provenance.disaster === 'earthquake' ? (
          <div className="evidence-layer" data-testid="model-closures">
            <div className="row-between">
              <strong className="evidence-layer-title">道路 / 接驳点关闭</strong>
              <span className="badge warn">人工设定/独立规则，非模型结论</span>
            </div>
            <p className="field-hint">
              oQ Scenario Damage 只给出资产受损状态分布；道路与接驳点是否关闭来自 models/quake_oq/closures.json
              的独立设定，不由楼栋受损推导。
            </p>
            {closures.length === 0 ? (
              <p className="field-hint">本算例没有独立的道路/接驳点关闭设定。</p>
            ) : (
              <div className="stack-sm">
                {closures.map((c, i) => (
                  <div key={`${c.targetType}:${c.targetId}:${i}`} className="evidence-closure" data-testid={`model-closure-row-${i}`}>
                    <div className="row-between">
                      <strong>
                        {c.targetType === 'road' ? '路段' : '接驳点'}：{c.targetName}
                      </strong>
                      <span className="badge muted">{c.mode === 'manual' ? '人工设定' : '独立规则'}</span>
                    </div>
                    <div className="field-hint">
                      关闭时刻：演练 +{Math.round(c.at)}s · 依据：{c.note}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        <p className="field-hint">
          说明：上半部分来自 {provenance.model === 'fds' ? 'FDS' : 'OpenQuake'} 求解器输出文件；下半部分是 GeoRelay
          的演练通行规则（阈值与结论）。两层分开显示，避免把工程判据说成模型结论。
        </p>
      </div>
    </section>
  )
}
