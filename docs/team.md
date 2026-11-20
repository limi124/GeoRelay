# 团队分工

| 负责人 | 职责 | 可验收交付 |
| --- | --- | --- |
| 项目负责人 | Web 全栈、核心功能与最终联调 | 社区建模与路网接口、内涝事件、增量重调度、Agent 模拟与状态回写（`src/domain/**`、`server/**`、`src/App.tsx`） |
| Bubble | Web 前端优化 | 三维地图交互、受阻原因与候选对比面板、Agent 轨迹与任务状态（`src/ui/**`、`src/styles/**`、`src/map/**`） |
| 野有茶 | 测试与验收 | 固定演练案例、端到端与规则自测、缺陷复现记录（`scripts/test.ts`、`scripts/e2e_check.py`、`scripts/layout_audit.py`） |

## 当前状态

首版 MVP 已完成并通过自动化验证，详细清单见 [首版验收](mvp.md)。仍在等人力/凭据的两处：

- **真实高德凭据**：代码路径已实现（`server/amap.mjs`、`src/map/amap.ts`、`src/domain/routing/external.ts` 的 `AmapExternalProvider`），需要凭据后单独验证真实接口。
- **AI 调度接口协议**：服务端代理与可替换排序接口已就绪（`server/ai.mjs`、`src/domain/sim/ranker.ts`），等协议确定后接入。

## 协作约定

- 接口或演练数据形状变更，在对应 PR 里说明，并同步给受影响的成员。
- 缺陷至少记录：场景与版本、复现步骤、预期结果、实际结果，有条件时附截图（`artifacts/e2e/` 可直接放端到端截图）。
- 改 `src/domain/**` 后必须跑 `npm test` 与 `npm run sim`；改界面后必须跑 `python scripts/e2e_check.py` 与 `python scripts/layout_audit.py`。
- 不提交 `src/domain/**` 里依赖 DOM/React 的代码：那会破坏无头复现能力。
