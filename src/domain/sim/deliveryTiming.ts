export const PICKUP_WAIT_S = 10
export const HANDOVER_WAIT_S = 12

export function externalTravelSeconds(durationS: number): number {
  return Math.max(1, durationS * 0.92)
}
