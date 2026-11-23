import { useLayoutEffect, useRef, useState } from 'react'

export interface DispatchActivityEntry {
  id: string
  time: string
  message: string
  onFocus?: () => void
}

/** Keep the reader's place while the engine prepends real dispatch events. */
export function DispatchActivity({ entries }: { entries: DispatchActivityEntry[] }): React.ReactElement {
  const list = useRef<HTMLOListElement>(null)
  const previousIds = useRef(new Set(entries.map(entry => entry.id)))
  const anchor = useRef<{ id: string; offset: number } | null>(null)
  const following = useRef(true)
  const [readingHistory, setReadingHistory] = useState(false)
  const [freshIds, setFreshIds] = useState<string[]>([])
  const [announcement, setAnnouncement] = useState('')
  const eventIds = entries.map(entry => entry.id).join('\0')

  const rememberViewport = (): void => {
    const element = list.current
    if (!element) return
    const top = element.getBoundingClientRect().top
    const firstVisible = Array.from(element.children).find(child => child.getBoundingClientRect().bottom > top + 1)
    anchor.current = firstVisible ? { id: firstVisible.getAttribute('data-event-id') ?? '', offset: firstVisible.getBoundingClientRect().top - top } : null
    following.current = element.scrollTop <= 2
    setReadingHistory(!following.current)
  }

  useLayoutEffect(() => {
    const added = entries.filter(entry => !previousIds.current.has(entry.id))
    previousIds.current = new Set(entries.map(entry => entry.id))
    setFreshIds(added.map(entry => entry.id))
    if (!entries.length) {
      anchor.current = null
      following.current = true
      setReadingHistory(false)
      setAnnouncement('')
      return
    }
    if (added.length) setAnnouncement(`${added[0].time} ${added[0].message}`)

    const element = list.current
    if (element) {
      // A focused event is also a reading position: do not move it out from
      // under the keyboard when new events arrive above it.
      const focusedRow = element.contains(document.activeElement) ? document.activeElement?.closest('[data-event-id]') : null
      if (following.current && !focusedRow) element.scrollTop = 0
      else if (anchor.current) {
        const row = Array.from(element.children).find(child => child.getAttribute('data-event-id') === anchor.current?.id)
        if (row) element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.current.offset
        else element.scrollTop = element.scrollHeight
      }
      rememberViewport()
    }
    const timer = window.setTimeout(() => setFreshIds([]), 2200)
    return () => window.clearTimeout(timer)
  }, [eventIds])

  const returnToLatest = (): void => {
    if (!list.current) return
    list.current.scrollTop = 0
    list.current.focus({ preventScroll: true })
    rememberViewport()
  }

  return <section className="dispatch-activity" aria-label="调度动态">
    <div className="dispatch-activity-heading">
      {readingHistory
        ? <button type="button" className="dispatch-activity-latest" onClick={returnToLatest} aria-controls="dispatch-events">返回最新</button>
        : <h2>调度动态</h2>}
    </div>
    {entries.length ? <ol id="dispatch-events" ref={list} tabIndex={0} aria-label="调度事件列表" onScroll={rememberViewport} onFocus={rememberViewport}>
      {entries.map(entry => <li key={entry.id} data-event-id={entry.id} className={freshIds.includes(entry.id) ? 'dispatch-activity-new' : undefined}>
        <time>{entry.time}</time>
        {entry.onFocus ? <button type="button" title={entry.message} onClick={entry.onFocus}>{entry.message}</button> : <span title={entry.message}>{entry.message}</span>}
      </li>)}
    </ol> : <p>暂无调度事件</p>}
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </section>
}
