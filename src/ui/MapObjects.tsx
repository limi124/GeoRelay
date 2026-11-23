import type { Pt, SceneBuilding } from '../sandbox/scene.ts'
import { useLayoutEffect, useRef } from 'react'

export interface MapObjectsProps {
  buildings: SceneBuilding[]
  notes?: Array<{ text: string; hint?: string; at?: Pt }>
  focusedBuildingId: string | null
  onFocusBuilding(id: string | null): void
  onLocateNote?(at: Pt): void
  onToggle?(): void
}

/** The SVG and this keyboard-accessible list consume the same scene data. */
export function MapObjects({ buildings, notes = [], focusedBuildingId, onFocusBuilding, onLocateNote, onToggle }: MapObjectsProps): React.ReactElement {
  const selected = buildings.find(building => building.id === focusedBuildingId)
  const detailRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const detail = detailRef.current
    if (!detail?.closest('details[open]')) return
    detail.focus({ preventScroll: true })
    detail.scrollIntoView({ block: 'nearest' })
  }, [focusedBuildingId])
  const annotations = [...new Map(notes.map(note => [`${note.text}:${note.hint ?? ''}`, note])).values()]
  return <details className="map-object-browser" data-testid="map-object-browser" onToggle={onToggle}>
    <summary>楼栋 <span>{buildings.length}</span></summary>
    <div className="map-object-content">
      {selected ? <section ref={detailRef} tabIndex={-1} className="map-object-detail" aria-label={`${selected.name}详情`} data-testid="map-building-detail">
        <header><strong>{selected.name}</strong><button type="button" className="sb-link" onClick={() => onFocusBuilding(null)}>取消定位</button></header>
        <dl><div><dt>楼层</dt><dd>{selected.floors} 层</dd></div><div><dt>楼内</dt><dd>{selected.inside} 人</dd></div><div><dt>紧急度</dt><dd>{selected.urgency} / 100</dd></div></dl>
        <p>{selected.detail}</p>
      </section> : null}
      <ul className="map-object-list" aria-label="地图楼栋">
        {buildings.map(building => <li key={building.id}>
          <button type="button" className="map-object-button" data-testid={`map-building-${building.id}`} aria-pressed={focusedBuildingId === building.id} onClick={() => onFocusBuilding(building.id)}>
            <span>{building.name}</span>
            {building.status ? <small>{building.status}</small> : null}
          </button>
        </li>)}
      </ul>
      {annotations.length ? <details className="map-object-notes" onToggle={onToggle}>
        <summary>其他标注</summary>
        <ul>{annotations.map(note => <li key={`${note.text}:${note.hint ?? ''}`}>
          {note.at && onLocateNote ? <button type="button" className="map-object-button" data-testid="map-note" onClick={() => onLocateNote(note.at!)}>
            <span>{note.text}</span>{note.hint ? <small>{note.hint}</small> : null}
          </button> : <><span>{note.text}</span>{note.hint ? <small>{note.hint}</small> : null}</>}
        </li>)}</ul>
      </details> : null}
    </div>
  </details>
}
