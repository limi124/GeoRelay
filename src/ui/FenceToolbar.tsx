/**
 * 围栏浮动工具条：绘制/编辑时悬浮在地图上方，
 * 实时显示顶点数、周长、面积，并提供矩形、撤销、完成、退出操作。
 * 按钮文案刻意避开右侧步骤里的「绘制 / 编辑顶点 / 重画」，两套入口互不干扰。
 */

export interface FenceToolbarProps {
  fenceMode: 'draw' | 'edit'
  draftCount: number
  areaM2: number
  perimeterM: number
  invalid: boolean
  selfIntersect: boolean
  rectMode: boolean
  onFinish(): void
  onUndo(): void
  onCancel(): void
  onToggleRect(): void
}

function fmtArea(m2: number): string {
  if (m2 <= 0) return '—'
  return m2 >= 10000 ? `${(m2 / 10000).toFixed(2)} 万m²` : `${Math.round(m2).toLocaleString()} m²`
}

export function FenceToolbar(props: FenceToolbarProps): React.ReactElement {
  const drawing = props.fenceMode === 'draw'
  return (
    <div className="fence-toolbar" data-testid="fence-toolbar" role="toolbar" aria-label="围栏工具">
      <div className="fence-toolbar-stats">
        <span className="fence-stat"><b>{props.draftCount}</b> 顶点</span>
        <span className="fence-stat-sep" aria-hidden />
        <span className="fence-stat"><b>{props.perimeterM > 0 ? Math.round(props.perimeterM).toLocaleString() : '—'}</b> m 周长</span>
        <span className="fence-stat-sep" aria-hidden />
        <span className="fence-stat"><b>{fmtArea(props.areaM2)}</b> 面积</span>
        {props.selfIntersect ? <span className="fence-flag danger">边线自交</span> : props.invalid && props.draftCount >= 3 ? <span className="fence-flag warn">面积不合规</span> : null}
      </div>
      <div className="fence-toolbar-actions">
        {drawing ? (
          <>
            <button className={`btn sm ${props.rectMode ? 'is-active' : ''}`} onClick={props.onToggleRect} aria-pressed={props.rectMode}>
              {props.rectMode ? '✓ 矩形模式' : '矩形围栏'}
            </button>
            <button className="btn sm ghost" onClick={props.onUndo} disabled={props.draftCount === 0 || props.rectMode}>撤销顶点</button>
            {!props.rectMode ? <button className="btn sm primary" onClick={props.onFinish} disabled={props.draftCount < 3}>完成 <kbd>Enter</kbd></button> : null}
          </>
        ) : (
          <button className="btn sm primary" onClick={props.onFinish}>保存修改 <kbd>Enter</kbd></button>
        )}
        <button className="btn sm ghost" onClick={props.onCancel}>退出 <kbd>Esc</kbd></button>
      </div>
      <p className="fence-toolbar-hint">
        {drawing
          ? props.rectMode
            ? '点击两个对角位置，自动生成矩形围栏'
            : '单击加点 · 双击或点回起点闭合 · 退格撤销上一点'
          : '拖动顶点微调 · 点边上的 + 插点 · 右键顶点删除'}
      </p>
    </div>
  )
}