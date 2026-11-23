/** Admission requirements shared by the editor and App's confirmation handler. */
export interface CommunityReadinessInput {
  fenceDirty: boolean
  roadDraftCount: number
  fenceVertexCount: number
  buildingCount: number
  netValidation: { ok: boolean; errors: string[] }
}

export type CommunityStep = 'fence' | 'buildings' | 'network'

type CompletedSteps = Record<CommunityStep, boolean>

export type CommunityReadiness = { completed: CompletedSteps } & (
  | { ready: true; nextStep: null; action: 'enter'; label: string }
  | {
    ready: false
    nextStep: CommunityStep
    action: 'draw-fence' | 'resume-fence' | 'resume-road' | 'add-buildings' | 'review-network'
    label: string
    notice: { kind: 'warn' | 'error'; text: string }
  }
)

export function getCommunityReadiness(input: CommunityReadinessInput): CommunityReadiness {
  const completed: CompletedSteps = {
    fence: !input.fenceDirty && input.fenceVertexCount >= 3,
    buildings: input.buildingCount > 0,
    network: input.netValidation.ok && input.roadDraftCount === 0,
  }

  // Match confirmCommunity's existing checks and precedence. Geometry and route
  // validation remain in domain; this function does not add admission criteria.
  if (input.fenceDirty || input.roadDraftCount) {
    return {
      completed, ready: false,
      nextStep: input.fenceDirty ? 'fence' : 'network',
      action: input.fenceDirty ? 'resume-fence' : 'resume-road',
      label: input.fenceDirty ? '继续编辑围栏' : '继续绘制路段',
      notice: { kind: 'warn', text: '请先完成或取消当前围栏/路段草稿，再进入指挥台' },
    }
  }
  if (input.fenceVertexCount < 3) {
    return {
      completed, ready: false, nextStep: 'fence', action: 'draw-fence', label: '绘制围栏',
      notice: { kind: 'error', text: '还没有确认的围栏：请先绘制并确认电子围栏' },
    }
  }
  if (!input.buildingCount) {
    return {
      completed, ready: false, nextStep: 'buildings', action: 'add-buildings', label: '添加楼栋',
      notice: { kind: 'error', text: '还没有楼栋：请先批量生成楼栋' },
    }
  }
  if (!input.netValidation.ok) {
    return {
      completed, ready: false, nextStep: 'network', action: 'review-network', label: '完善路网',
      notice: { kind: 'error', text: `路网还不能确认：${input.netValidation.errors.join('；')}` },
    }
  }
  return { completed, ready: true, nextStep: null, action: 'enter', label: '进入指挥台' }
}
