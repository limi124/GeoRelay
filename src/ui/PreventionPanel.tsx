import type { assessPrevention } from '../domain/community/prevention.ts'
import type { ImpactEvent } from '../domain/disaster/types.ts'

export function PreventionPanel({ report, onLocate }: {
  report: ReturnType<typeof assessPrevention>
  onLocate(event: ImpactEvent): void
}): React.ReactElement {
  const { baseline, scenario, actions } = report
  return <section className="prevention-panel" data-testid="prevention-panel" aria-labelledby="prevention-title">
    <h3 id="prevention-title">防灾建设评估</h3>
    <dl className="prevention-coverage">
      <div><dt>大门可达</dt><dd>{baseline.gateReachableCount} → <strong>{scenario.gateReachableCount}</strong> 栋</dd></div>
      <div><dt>接驳可达</dt><dd>{baseline.stagingReachableCount} → <strong>{scenario.stagingReachableCount}</strong> 栋</dd></div>
    </dl>
    <p className="field-hint">无灾基线 → 本场景受阻叠加。单点保通收益为路网推演值。</p>
    {actions.length ? <ol className="prevention-actions">
      {actions.map(({ event, measure, gateGain, stagingGain }) => <li key={event.id}>
        <button type="button" className="sb-link" onClick={() => onLocate(event)}>{event.targetName} · 图上定位</button>
        <p>{event.level} · {event.reason}</p>
        <strong>{measure}</strong>
        {gateGain !== null ? <small>单点保通 · 大门 +{gateGain} 栋 · 接驳 +{stagingGain} 栋</small> : <small>建筑专项核查</small>}
      </li>)}
    </ol> : <p className="field-hint">本场景暂无受阻或受损目标。</p>}
  </section>
}
