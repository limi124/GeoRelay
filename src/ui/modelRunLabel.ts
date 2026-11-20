/**
 * 引擎展示名：`FDS 6.11.2 (SMV 6.11.3)` / `OpenQuake 3.26.2`。
 *
 * 归档里的 `engineVersion` 已经带产品名（如 FDS 的 `FDS 6.11.2 (SMV 6.11.3)`），
 * 直接拼「FDS + engineVersion」会出现「FDS FDS 6.11.2」；这里统一去重。
 */
export const MODEL_LABEL = { fds: 'FDS', openquake: 'OpenQuake' } as const

export type ModelKind = keyof typeof MODEL_LABEL

export function engineLabel(model: ModelKind, engineVersion: string): string {
  const label = MODEL_LABEL[model]
  return engineVersion.toLowerCase().startsWith(label.toLowerCase()) ? engineVersion : `${label} ${engineVersion}`
}
