import type { AiAnalysis, AiQuestion } from '../services/lbsClient.ts'

/**
 * AI 调度分析面板。
 *
 * 与地图上的志愿者 Agent 明确区分：这里是「分析 + 建议」，不改任何状态。
 * 建议只进入待确认区；实际执行仍要指挥员确认，并由规则复核（候选必须是当前演练里
 * 未过期、且通过规则校验的候选）。
 */

export interface AiUiState {
  busy: boolean
  question: AiQuestion | null
  analysis: AiAnalysis | null
  /** 校验后仍不可用的引用（未知/不可行/已过期/无模型证据），要显示出来而不是静默丢弃 */
  rejected: Array<{ kind: 'candidate' | 'task' | 'event' | 'evidence'; id: string; reason: string }>
  error: string | null
}

export interface AiPanelProps {
  ui: AiUiState
  /** 服务端当前模式文案（规则模式 / 模拟 AI / 真实模型） */
  modeLabel: string
  onAsk(question: AiQuestion): void
  onJumpTask(taskId: string): void
  onJumpCandidate(candidateId: string): void
}

const QUESTIONS: Array<{ key: AiQuestion; label: string; hint: string }> = [
  { key: 'situation', label: '分析当前灾情', hint: '现在发生了什么、影响哪些对象' },
  { key: 'affected', label: '哪些任务受影响', hint: '逐个说明任务与是否还有可行方案' },
  { key: 'compare', label: '比较可行改派', hint: '比较候选的耗时、余量与风险' },
]

export function AiPanel(props: AiPanelProps): React.ReactElement {
  const { ui } = props
  const a = ui.analysis
  return (
    <section className="panel" data-testid="ai-panel">
      <div className="panel-header">
        <span className="panel-title">AI 调度分析</span>
        <span className={`badge ${a?.mode === 'ai' ? 'ok' : a?.mode === 'mock' ? 'info' : 'muted'}`}>{props.modeLabel}</span>
      </div>
      <div className="panel-body stack-sm">
        <div className="btn-group">
          {QUESTIONS.map((q) => (
            <button key={q.key} className="btn sm" title={q.hint} onClick={() => props.onAsk(q.key)} disabled={ui.busy}>
              {q.label}
            </button>
          ))}
        </div>
        <p className="field-hint">AI 只读取当前演练的结构化状态（事件与依据、受影响任务、候选与校验结果），给出建议；不修改路网、库存、任务或派单。</p>

        {ui.busy ? (
          <div className="notice info">
            <span className="spinner" /> 正在分析…
          </div>
        ) : null}

        {ui.error ? (
          <div className="notice warn" data-testid="ai-error">
            AI 分析失败：{ui.error}
            <div className="field-hint">已保留规则生成的候选，演练可以继续；也可以直接用规则候选确认改派。</div>
          </div>
        ) : null}

        {a && !ui.error ? (
          <div className="panel" data-testid="ai-result">
            <div className="panel-body stack-sm">
              <div className="row-between">
                <strong>{a.label || props.modeLabel}</strong>
                <span className="badge muted">{a.mode === 'ai' ? '真实模型' : a.mode === 'mock' ? '模拟 AI' : '规则模式'}</span>
              </div>
              {a.summary ? <p className="field-hint">{a.summary}</p> : null}

              <div className="stack-sm">
                {(Array.isArray(a.items) ? a.items : []).map((item) => (
                  <div key={item.id} className="check-item">
                    <div className="stack-sm">
                      <span>{item.text}</span>
                      <div className="row" style={{ flexWrap: 'wrap' }}>
                        {item.taskIds.map((id) => (
                          <button key={id} className="chip" onClick={() => props.onJumpTask(id)} title="跳到任务">
                            任务 {shortId(id)}
                          </button>
                        ))}
                        {item.candidateIds.map((id) => (
                          <button key={id} className="chip" onClick={() => props.onJumpCandidate(id)} title="跳到候选">
                            候选 {shortId(id)}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {a.warnings.length ? (
                <div className="notice info">
                  {a.warnings.map((w) => (
                    <div key={w}>{w}</div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {ui.rejected.length ? (
          <div className="notice warn" data-testid="ai-rejected">
            已拦截 {ui.rejected.length} 条不可用建议：
            {ui.rejected.map((r) => (
              <div key={`${r.kind}:${r.id}`}>
                · {r.kind === 'candidate' ? '候选' : r.kind === 'task' ? '任务' : r.kind === 'evidence' ? '模型证据' : '事件'} {shortId(r.id)}：{r.reason}
              </div>
            ))}
          </div>
        ) : null}

        <p className="field-hint">AI 不直接生效：建议只进待确认区，确认与规则复核仍由指挥员完成。地图上的志愿者 Agent 负责执行已确认方案，二者不是一回事。</p>
      </div>
    </section>
  )
}

function shortId(id: string): string {
  const tail = id.split(/[:#]/).filter(Boolean).pop() ?? id
  return tail.length > 12 ? tail.slice(0, 12) : tail
}
