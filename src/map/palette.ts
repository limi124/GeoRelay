/** 地图与图例共享状态色；只影响呈现，不参与风险或路径计算。 */
export const MAP_COLORS = {
  active: '#42818A',
  pending: '#A46529',
  original: '#777E76',
  blocked: '#C2443D',
  evacuation: '#7D69A1',
  internal: '#49775E',
  external: '#467B9A',
  firefighter: '#B75D42',
  fence: '#49775E',
} as const

/** Text needs stronger contrast than route strokes on the map's light labels. */
export function mapLabelColor(color: string): string {
  if (color === MAP_COLORS.active) return '#356E76'
  if (color === MAP_COLORS.original) return '#60685F'
  if (color === MAP_COLORS.firefighter) return '#A84F35'
  return color
}
