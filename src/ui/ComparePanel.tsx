import compareSample from '../data/compare-sample.json'

/**
 * 内涝对照结果（只读）。
 *
 * 数据来源就是 `npm run compare -- --out=src/data/compare-sample.json` 生成的 JSON，
 * 这里不重算任何统计：指标口径、盈亏、种子都直接读文件，
 * 避免 Web 与命令行出现两套算法。
 */

interface MetricDefs {
  [k: string]: string
}

interface PairRun {
  metrics: {
    taskTotal: number
    delivered: number
    onTime: number
    late: number
    unfinished: number
    reroutes: number
    deliveryMeanS: number | null
    deliveryMedianS: number | null
  }
  closures: Array<{ roadName: string; at: number; depthM: number; thresholdM: number }>
}

interface Pair {
  seed: number
  delta: { onTime: number; unfinished: number; reroutes: number; deliveryMeanS: number | null }
  assertions: Record<string, { ok: boolean; detail: string }>
  note: string | null
  runs: { static: PairRun; rules: PairRun }
}

const data = compareSample as unknown as {
  experiment: { seeds: number[]; step: number; maxSeconds: number; strategies: string[]; ranker: string; command: string; repro: boolean }
  metricDefinitions: MetricDefs
  pairs: Pair[]
}

function fmtMin(sec: number | null): string {
  return sec === null ? '—' : `${(sec / 60).toFixed(1)} 分`
}

function signed(n: number): string {
  if (n === 0) return '0'
  return n > 0 ? `+${n}` : String(n)
}

export function ComparePanel(): React.ReactElement {
  const { experiment, metricDefinitions, pairs } = data
  const allOk = pairs.every((p) => Object.values(p.assertions).every((a) => a.ok))
  return (
    <section className="panel" data-testid="compare-panel">
      <div className="panel-header">
        <span className="panel-title">内涝对照（只读）</span>
        <span className={`badge ${allOk ? 'ok' : 'warn'}`}>{allOk ? '校验通过' : '有校验失败'}</span>
      </div>
      <div className="panel-body stack-sm">
        <div className="notice info">
          <div>预置对照实验，与当前演练无关，不会随当前演练变化。</div>
          <div className="field-hint">
            场景：演示社区 · 内涝 · 种子 {experiment.seeds.join(' / ')} · 步长 {experiment.step}s · 时长 {Math.round(experiment.maxSeconds / 60)} 分钟 ·
            排序 {experiment.ranker.split('（')[0]}
          </div>
          <div className="field-hint">生成命令：<code>{experiment.command}</code></div>
        </div>

        <div className="stack-sm">
          {pairs.map((p) => (
            <div key={p.seed} className="panel" data-testid={`compare-seed-${p.seed}`}>
              <div className="panel-header">
                <span className="panel-title">种子 {p.seed}</span>
                <span className="badge muted">
                  {p.runs.static.closures.length} 次封路
                </span>
              </div>
              <div className="panel-body stack-sm">
                <div className="grid-3">
                  <div className="metric">
                    <div><span className="metric-value">{p.runs.static.metrics.onTime} → {p.runs.rules.metrics.onTime}</span><span className="metric-label">按时完成</span></div>
                    <div><span className="metric-value">{p.runs.static.metrics.unfinished} → {p.runs.rules.metrics.unfinished}</span><span className="metric-label">未完成</span></div>
                    <div><span className="metric-value">{p.runs.static.metrics.reroutes} → {p.runs.rules.metrics.reroutes}</span><span className="metric-label">改派次数</span></div>
                    <div><span className="metric-value">{fmtMin(p.runs.static.metrics.deliveryMeanS)} → {fmtMin(p.runs.rules.metrics.deliveryMeanS)}</span><span className="metric-label">送达耗时均值</span></div>
                  </div>
                </div>
                <div className="field-hint">
                  差值（规则 − 静态）：按时 {signed(p.delta.onTime)} · 未完成 {signed(p.delta.unfinished)} · 改派 {signed(p.delta.reroutes)} ·
                  耗时 {p.delta.deliveryMeanS === null ? '—' : `${(p.delta.deliveryMeanS / 60).toFixed(1)} 分`}
                </div>
                {p.note ? <div className="notice info">{p.note}</div> : null}
              </div>
            </div>
          ))}
        </div>

        <details className="field-hint">
          <summary>指标口径（直接来自实验输出，未在界面重算）</summary>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {Object.entries(metricDefinitions).map(([k, v]) => (
              <li key={k}>{k}：{v}</li>
            ))}
          </ul>
        </details>

        <div className="notice warn">
          未送达任务不计入送达耗时，也不按 0 处理；表中「—」表示该组没有已送达任务。
          改派由脚本模拟确认，不代表人工决策效果；样本量小，只用于建立评估基线。
        </div>
      </div>
    </section>
  )
}
