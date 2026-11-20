import type { DrillPreset } from '../domain/sim/presets.ts'

/**
 * 一键演练入口：三个固定场景。
 *
 * 只负责“选场景 + 展示下一步提示”，改派仍然由指挥员确认。
 * 用预置场景时会话会进入「预置场景」模式：不写回用户保存的社区模型。
 */

export interface PresetBarProps {
  presets: DrillPreset[]
  activeId: string | null
  presetMode: boolean
  busy: boolean
  onLoad(id: string): void
}

export function PresetBar(props: PresetBarProps): React.ReactElement {
  const active = props.presets.find((p) => p.id === props.activeId) ?? null
  return (
    <section className="panel" data-testid="preset-bar">
      <div className="panel-header">
        <span className="panel-title">一键演练</span>
        {props.presetMode ? <span className="badge info">预置场景</span> : <span className="badge muted">自定义社区</span>}
      </div>
      <div className="panel-body stack-sm">
        <div className="btn-group">
          {props.presets.map((p) => (
            <button
              key={p.id}
              className={`btn sm ${props.activeId === p.id ? 'is-active' : ''}`}
              onClick={() => props.onLoad(p.id)}
              disabled={props.busy}
              data-testid={`preset-${p.id}`}
              title={p.summary}
            >
              {p.title}
            </button>
          ))}
        </div>
        {props.presetMode ? (
          <p className="field-hint">预置场景使用独立社区副本，不会覆盖你在编辑台保存的社区模型。</p>
        ) : (
          <p className="field-hint">载入预置场景会开一场新演练（固定种子与灾情序列），当前自定义社区不会被保存覆盖。</p>
        )}
        {active ? (
          <div className="panel" data-testid="preset-hint">
            <div className="panel-body stack-sm">
              <div className="row-between">
                <strong>{active.title}</strong>
                <span className="badge muted">种子 {active.seed}</span>
              </div>
              <p className="field-hint">{active.intro}</p>
              <div className="field-hint">下一步：</div>
              <ol className="field-hint" style={{ margin: 0, paddingLeft: 18 }}>
                {active.nextSteps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              <div className="field-hint">关注点：{active.focus.join('；')}</div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
