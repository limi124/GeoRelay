import type { DrillPreset } from '../domain/sim/presets.ts'

/**
 * 一键演练入口：三个固定场景。
 *
 * 只负责选择场景与显示来源，改派仍然由指挥员确认。
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
        <span className="panel-title">预置演练</span>
      </div>
      <div className="panel-body stack-sm">
        <div className="btn-group">
          {props.presets.map((p) => (
            <button
              key={p.id}
              className={`btn sm ${props.activeId === p.id ? 'is-active' : ''}`}
              aria-pressed={props.activeId === p.id && props.presetMode}
              onClick={() => props.onLoad(p.id)}
              disabled={props.busy}
              data-testid={`preset-${p.id}`}
              title={p.summary}
            >
              {p.title}
            </button>
          ))}
        </div>
        <p className="field-hint">独立社区副本，不覆盖当前社区。</p>
        {active ? (
          <details className="hud-details" data-testid="preset-hint">
            <summary>{active.title} · 场景详情</summary>
            <div className="hud-details-body">
              <p className="field-hint">{active.intro}</p>
              <p className="field-hint">{active.focus.join('；')}</p>
              <span className="field-hint">随机种子 {active.seed}</span>
            </div>
          </details>
        ) : null}
      </div>
    </section>
  )
}
