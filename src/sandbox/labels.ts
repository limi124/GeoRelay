import type { SceneNode } from './scene.ts'

export type SceneLabel = Extract<SceneNode, { type: 'label' }>
export interface LabelRect { x: number; y: number; width: number; height: number }
export interface PlacedLabel extends LabelRect {
  key: string
  node: SceneLabel
  text: string
  anchorX: number
  anchorY: number
}

const overlaps = (a: LabelRect, b: LabelRect): boolean =>
  a.x < b.x + b.width + 4 && a.x + a.width + 4 > b.x && a.y < b.y + b.height + 4 && a.y + a.height + 4 > b.y

/** Screen-space placement: higher-priority labels get first choice; the semantic
 * object browser retains every detail even when the viewport has no free slot. */
export function layoutLabels(labels: Array<{ key: string; node: SceneLabel }>, viewport: {
  width: number; height: number; scale: number; offsetX: number; offsetY: number; zoom: number
}, obstacles: LabelRect[]): PlacedLabel[] {
  const { width, height, scale, offsetX, offsetY, zoom } = viewport
  const placed: PlacedLabel[] = []
  const priority = (node: SceneLabel): number => node.priority ?? (node.tone === 'warn' ? 80 : node.tone === 'firefighter' ? 75 : 40)
  const ordered = [...labels].sort((a, b) => priority(b.node) - priority(a.node))
  for (const { key, node } of ordered) {
    const anchorX = node.at.x * scale + offsetX
    const anchorY = node.at.y * scale + offsetY
    if (anchorX < -20 || anchorX > width + 20 || anchorY < -20 || anchorY > height + 20) continue
    const full = node.detailText && zoom >= (node.detailAtZoom ?? Infinity) ? node.detailText : node.text
    const choices = full === node.text ? [full] : [full, node.text]
    let found: PlacedLabel | undefined
    for (const text of choices) {
      const w = Array.from(text).reduce((sum, ch) => sum + (ch.charCodeAt(0) < 128 ? .58 : 1), 0) * 11 + 12
      if (w > width - 20) continue
      const preferredX = node.anchor === 'start' ? anchorX : node.anchor === 'end' ? anchorX - w : anchorX - w / 2
      const offsets = [[0, -23], [0, -47], [0, 9], [0, 33], [-w / 2 - 12, -23], [w / 2 + 12, -23], [0, -71], [0, 57]]
      for (const [dx, dy] of offsets) {
        const rect = { x: Math.max(10, Math.min(width - w - 10, preferredX + dx)), y: Math.max(10, Math.min(height - 30, anchorY + dy)), width: w, height: 20 }
        if ([...obstacles, ...placed].some(other => overlaps(rect, other))) continue
        found = { ...rect, key, node, text, anchorX, anchorY }
        break
      }
      if (found) break
    }
    if (found) placed.push(found)
  }
  return placed
}
