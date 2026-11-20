import { useMemo, useState } from 'react'

import type { ReplayEntry } from '../domain/sim/replay.ts'

/**
 * 复盘时间线：只读当场记录，不修改演练状态。
 *
 * 点击条目会定位到对应地图对象（路段 / 任务 / 方案），
 * 选中改派时同时高亮原路线与新路线。
 * 支持按任务筛选：只读过滤，不改变任何演练状态。
 */

export interface ReplayPanelProps {
  entries: ReplayEntry[]
  selectedId: string | null
  /** 可选：按任务筛选（传任务 id + 名称，界面上用中文标签） */
  tasks?: Array<{ id: string; code: string; targetName: string }>
  onSelect(entry: ReplayEntry): void
}

const KIND_LABEL: Record<ReplayEntry['kind'], string> = {
  impact: '灾情',
  route_blocked: '受阻',
  candidates: '候选',
  confirm: '确认',
  relay: '交接',
  delivered: '送达',
  agent: '执行',
}

export function ReplayPanel(props: ReplayPanelProps): React.ReactElement {
  const [taskFilter, setTaskFilter] = useState<string>('all')
  const tasks = props.tasks ?? []
  const shown = useMemo(() => {
    if (taskFilter === 'all') return props.entries
    return props.entries.filter((e) => (e.refs?.taskIds ?? []).includes(taskFilter))
  }, [props.entries, taskFilter])

  return (
    <section className="panel" data-testid="replay-panel">
      <div className="panel-header">
        <span className="panel-title">复盘时间线</span>
        <span className="badge muted">{shown.length === props.entries.length ? props.entries.length : `${shown.length}/${props.entries.length}`}</span>
      </div>
      <div className="panel-body stack-sm">
        <p className="field-hint">只读当场记录：灾情发生与判据 → 原路线受阻 → 人工确认 → 交接或送达。点条目可定位地图对象。</p>
        {tasks.length > 1 ? (
          <label className="field">
            <span className="field-label">按任务筛选</span>
            <select
              className="input"
              value={taskFilter}
              onChange={(e) => setTaskFilter(e.target.value)}
              data-testid="replay-task-filter"
              aria-label="按任务筛选复盘记录"
            >
              <option value="all">全部任务</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>{`${t.code} · ${t.targetName}`}</option>
              ))}
            </select>
          </label>
        ) : null}
        {shown.length === 0 ? (
          <div className="empty">
            <div className="empty-title">{props.entries.length ? '该任务没有可复盘的记录' : '还没有可复盘的记录'}</div>
            <div className="empty-hint">{props.entries.length ? '切回「全部任务」可以看灾情与其他任务的记录' : '开始演练并产生事件后，这里会按演练时刻列出'}</div>
          </div>
        ) : (
          <div className="stack-sm" style={{ maxHeight: 260, overflowY: 'auto' }}>
            {shown.map((e) => (
              <button
                key={e.id}
                className={`task-card ${props.selectedId === e.id ? 'is-selected' : ''}`}
                onClick={() => props.onSelect(e)}
                data-testid={`replay-${e.kind}`}
              >
                <div className="row-between">
                  <strong>{e.title}</strong>
                  <span className="badge muted">{KIND_LABEL[e.kind]}</span>
                </div>
                <div className="field-hint">{e.detail}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
