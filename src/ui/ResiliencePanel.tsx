import type { ResilienceIssue, ResilienceReport } from '../domain/community/analysis.ts'

export function ResiliencePanel({ report, analysis, focusedId, onFocus }: {
  report: ResilienceReport
  analysis?: { stage: string; source: string; summary?: string } | null
  focusedId?: string | null
  onFocus?: (id: string) => void
}): React.ReactElement {
  const issues = report.issues.filter((issue) => issue.kind !== 'assumption')
  const s = report.summary
  const distance = (value: number): string => value < 0 ? '不可评估' : `${value} m`
  const grouped = new Map<string, ResilienceIssue[]>()
  for (const issue of issues) {
    const key = `${issue.level}:${issue.suggestion}`
    const existing = grouped.get(key)
    if (existing) existing.push(issue)
    else grouped.set(key, [issue])
  }
  return (
    <section className="rescue-report" data-testid="resilience-panel">
      <h3 className="rescue-weakness-heading">薄弱点</h3>
      <dl className="rescue-coverage">
        <div data-alert={s.isolatedCount > 0}><dt>图上孤岛</dt><dd>{s.isolatedCount}<small> 栋</small></dd></div>
        <div><dt>大门覆盖</dt><dd>{s.gateReachableCount}<small> / {s.totalBuildings}</small></dd></div>
        <div><dt>接驳覆盖</dt><dd>{s.stagingReachableCount}<small> / {s.totalBuildings}</small></dd></div>
      </dl>
      <div className="rescue-actions-heading"><h3>救援建议</h3><span>{grouped.size} 组规则建议</span></div>
      {analysis?.stage === 'done' ? <section className="rescue-priority-summary" aria-label={analysis.source}><strong>{analysis.source}</strong>{analysis.summary ? <p>{analysis.summary}</p> : null}</section> : null}
      {grouped.size ? <ol className="rescue-action-list" data-testid="resilience-issues">
        {Array.from(grouped, ([key, group]) => {
          const first = group[0]
          return <li key={key}>
            <span className={`rescue-priority ${first.level}`}>{first.level === 'high' ? '优先' : '关注'}</span>
            <div className="rescue-action-body">
              <p>{first.suggestion}</p>
              {onFocus && group.some((issue) => issue.targetId) ? <div className="rescue-targets">
                {group.map((issue) => issue.targetId ? <button key={issue.targetId} type="button" className="btn xs" title={issue.message} aria-label={`定位 ${issue.targetName ?? '楼栋'}`} aria-pressed={focusedId === issue.targetId} onClick={() => onFocus(issue.targetId!)}>{issue.targetName ?? '楼栋'}</button> : null)}
              </div> : null}
              <details className="rescue-evidence"><summary>查看判定依据</summary><ul>{group.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></details>
            </div>
          </li>
        })}
      </ol> : <p className="field-hint">当前图上筛查未触发建议项。</p>}
      <details className="rescue-report-notes">
        <summary>评估指标与口径</summary>
        <dl className="resilience-stats">
          <div><dt>未评估楼栋</dt><dd>{s.unassessedCount} 栋</dd></div>
          <div><dt>重点住户</dt><dd>{s.vulnerableTotal} 户</dd></div>
          <div><dt>可达楼栋平均门距</dt><dd>{distance(s.avgGateDistanceM)}</dd></div>
          <div><dt>可达楼栋平均接驳距</dt><dd>{distance(s.avgStagingDistanceM)}</dd></div>
        </dl>
        <p className="field-hint">随当前封路、封门和接驳点停用状态更新。距离阈值为演示筛查假设，备用门和接入边需现场核实。</p>
      </details>
    </section>
  )
}
