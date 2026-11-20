import { useState } from 'react'
import type { Engine } from '../domain/sim/engine.ts'
import { estimatedResidents, evacuationByBuilding } from '../domain/sim/evacuation.ts'

export function EvacuationPanel({ engine, onOrder }: { engine: Engine; onOrder(ids: string[]): void }): React.ReactElement {
  const [selected, setSelected] = useState<string[]>([])
  const groups = evacuationByBuilding(engine.state.evacuation)
  const buildings = engine.view.model.buildings
  const available = buildings.filter((b) => !groups.has(b.id))
  const valid = available.filter((b) => selected.includes(b.id))
  const finished = engine.state.status === 'finished'

  return (
    <section className="evacuation-panel" data-testid="evacuation-panel">
      <div className="evacuation-panel-heading">
        <strong>撤离楼栋</strong>
        <button className="btn sm" disabled={finished || !available.length} onClick={() => setSelected(valid.length === available.length ? [] : available.map((b) => b.id))}>{valid.length === available.length && available.length ? '取消全选' : '全选待撤楼栋'}</button>
      </div>
      <div className="evacuation-buildings">
        {buildings.map((b) => {
          const group = groups.get(b.id)
          const residents = group?.residents ?? estimatedResidents(b.floors, engine.view.model.unitsPerFloor)
          const inside = group?.inside ?? residents
          const status = !group ? 'ready' : group.arrived === residents ? 'arrived' : group.rescuing ? 'rescuing' : group.waiting ? 'blocked' : 'moving'
          return (
            <label key={b.id} className="evacuation-building" data-status={status}>
              <input type="checkbox" checked={Boolean(group) || selected.includes(b.id)} disabled={finished || Boolean(group)} onChange={(e) => setSelected(e.target.checked ? [...selected, b.id] : selected.filter((id) => id !== b.id))} />
              <strong>{b.name}</strong>
              <span data-testid="building-remaining">楼内 {inside} 人</span>
              <span>{status === 'arrived' ? '已在门外集结' : status === 'ready' ? '待下令' : status === 'blocked' ? `${group?.waiting} 人待救援` : status === 'rescuing' ? `${group?.rescuing} 人转运中` : `已集结 ${group?.arrived} 人`}</span>
            </label>
          )
        })}
      </div>
      <p className="field-hint">估算人数 · 步行 1 m/s · 专业转运为演练假设</p>
      <button className="btn primary" data-testid="order-evacuation" disabled={finished || !valid.length} onClick={() => onOrder(valid.map((b) => b.id))}>下达撤离指令{valid.length ? ` · ${valid.length} 栋` : ''}</button>
    </section>
  )
}
