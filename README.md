# GeoRelay

**面向社区的多灾种应急推演、薄弱点筛查与救援协同平台**

灾害来临时，一条积水路段、一处被烟雾封住的入口，或一个失效的接驳点，都可能让原本可行的救援方案失效。GeoRelay 将社区空间、灾害影响、居民撤离和物资接力放进同一场可复现的演练，让社区回答三个具体问题。

- **哪里容易失去救援通达性？** 找出图上孤岛、单一入口依赖和接驳覆盖不足的楼栋。
- **哪里值得优先改造？** 对比无灾基线和灾害场景，估算保住关键路段、入口或接驳点能恢复多少栋楼的可达性。
- **现场条件改变后如何协调？** 查看谁在撤离、哪里排队、当前派单为何受阻，以及哪些备选路线通过了校验。

## 现实应用

| 阶段 | 使用方式 | 产出 |
| --- | --- | --- |
| 灾前准备 | 物业、街道和社区志愿队共同核对大门、消防通道与接驳点 | 可定位的薄弱点、备选通道和防灾改造清单 |
| 联合演练 | 在同一套场景下比较不同撤离和改派策略 | 已撤人数、出口排队、任务送达与受阻记录 |
| 真实救援辅助 | 以现场人员核实的路况、楼栋、入口和资源信息为依据，辅助会商、路线对照和交接协调 | 可核对的态势信息、候选方案和人工确认记录 |
| 灾后复盘 | 回看事件、候选和确认后的执行结果 | 可复查的时间线，供更新预案和安排现场巡检 |

当前版本定位为演练原型。内置灾情、人口、消防行程、库存与预防区均有场景假设。真实救援应以有权限的现场指挥和官方渠道为准，现场核实道路可通行性、建筑安全及资源可用性。防灾评分和单点保通收益用于确定现场核查顺序，工程改造需结合实测与专业鉴定。演练请使用脱敏或合成住户数据，经授权后再将现场信息提交给外部模型服务。

## 研究方法

- **图论与空间可达性。** 将社区道路、楼栋入口、大门和接驳点建模为路网。Dijkstra 在确认过的内部路网上搜索，灾情事件将受阻道路和节点纳入约束。防灾评估在同一场景下比较基线、受灾与单点保通三种条件，量化大门与接驳点覆盖变化。 [系统架构](docs/architecture.md)
- **灾害模型与数据溯源。** 内涝、火灾、地震通过统一的影响事件驱动调度，可复现简化场景，也可回放有映射规则的 FDS 火灾烟气与 OpenQuake 地震算例。界面记录数据来源、阈值和触发时刻。 [专业模型算例](docs/models/README.md)
- **多主体与离散事件仿真。** 志愿者负责圈外取货、接驳和内部配送，消防响应单元处理受阻居民的模拟转运。居民按固定种子的随机序列分批撤离，出口模型显式维护队列。消防可选单组或双组，按转运效率或重点住户优先级分配。 [系统架构](docs/architecture.md)
- **人机协同与强化学习。** 规则生成候选并校验通行、运力、库存和时限。表格型 contextual bandit 用仿真送达结果学习候选顺位，样本不足时使用规则。Agent API 用于分析和解释，实际改派由指挥员确认。可运行 `npm run rl:train` 复训并评估。 [功能验收](docs/mvp.md)

当前离线实验用 243 次模拟改派结果训练，每个灾种用 12 个独立种子对照规则排序。

| 灾种 | 规则排序按时送达 | 强化学习排序按时送达 |
| --- | ---: | ---: |
| 内涝 | 60 | 60 |
| 火灾 | 72 | 72 |
| 地震 | 56 | 60 |

以上是当前示例社区和固定场景的任务计数，可用于复现实验和比较策略。跨社区泛化与现场效果仍需实测。

## 如何使用

1. **建模。** 打开 GeoRelay，点击「载入演示社区」快速体验。录入自有社区时，先搜索或定位，再确认围栏、配置楼栋和重点住户、标注大门和接驳点，最后确认路网。
2. **评估。** 点击「进入指挥台」。选择内涝、火灾或地震，在右侧打开「防灾建设评估」，对比受灾前后的覆盖，点选结果在地图上定位。
3. **演练。** 选择专业救援优先策略和消防组数，再开始推进时钟并下达撤离指令。可切换沙盘与地理地图，以及态势、物资、撤离、灾情视角。全员集结后仍可继续观察物资保障和灾情。
4. **改派与复盘。** 遇到阻断时，在 Agent 决策区选择规则排序或强化学习排序，预览候选和判据后确认改派。底部调度动态可定位关联任务，判据面板可回看事件和方案。

## 本地运行与继续开发

需要 Git、Node.js 22.18+ 和 npm。以下命令适用于 PowerShell。已打开本地仓库时，从 `npm ci` 开始。

```powershell
git clone https://github.com/limi124/GeoRelay.git
Set-Location GeoRelay
npm ci
npm run dev
```

浏览器打开终端显示的地址，默认是 `http://127.0.0.1:5173/`。不配置凭据也能在示例地图上完成建模、灾害推演、撤离与强化学习排序。需要验证生产构建时，运行 `npm run build` 和 `npm run start`，默认在端口 `8791` 提供静态页面与同源 API。

界面布局约定、语义控件与浏览器回归方式见 [界面维护](docs/interface.md)。

### 配置高德地图 API

首次配置时在项目根目录执行 `Copy-Item .env.example .env`。已有 `.env` 时直接编辑该文件。

1. 注册并登录高德开放平台，按平台要求完成开发者认证，在控制台创建应用。 [高德控制台](https://console.amap.com/) · [JS API 2.0 快速上手](https://developer.amap.com/api/javascript-api-v2/getting-started)
2. 添加服务平台为「Web 端（JS API）」的 Key，把 Key 填入 `AMAP_WEB_KEY`，把同一 Key 配套的安全密钥填入 `AMAP_SECURITY_JS_CODE`。在控制台按需配置实际访问域名。 [JS API 2.0 快速上手](https://developer.amap.com/api/javascript-api-v2/getting-started)
3. 添加服务平台为「Web 服务」的 Key，填入 `AMAP_REST_KEY`，用于地理编码、周边搜索和驾车路线。 [高德 Web 服务 API](https://developer.amap.com/api/webservice/summary/)
4. 重启开发服务。进入首页观察「高德 3D 白模」标记，用地址搜索验证 Web 服务，再查看同源 `/api/health` 中的高德配置状态。

```dotenv
AMAP_WEB_KEY=
AMAP_SECURITY_JS_CODE=
AMAP_REST_KEY=
```

当前本地集成会把 JS API 安全码交给浏览器。公开部署前，应使用高德推荐的服务代理方案，并为公开环境配置独立的应用凭据与域名限制。 [高德安全密钥配置](https://developer.amap.com/api/javascript-api-v2/guide/abc/prepare)

### 配置 Agent 模型 API

1. 在模型服务商控制台申请 API Key，确认账户有调用权限，并选择支持 OpenAI 兼容 Chat Completions 和 JSON 对象输出的模型。 [DeepSeek API 首次调用](https://api-docs.deepseek.com/zh-cn/quick_start/your_first_api_call)
2. 在同一个 `.env` 填入下列变量。以 DeepSeek 为例，Base URL 和模型名可参考下面的值，Key 在本机填写。使用其他兼容服务时，保留该服务商要求的 URL 路径前缀，例如 `/v1`。程序会拼接 `AI_CHAT_PATH`。

```dotenv
AI_BASE_URL=https://api.deepseek.com
AI_API_KEY=
AI_MODEL=deepseek-flash
AI_CHAT_PATH=/chat/completions
AI_MOCK=0
```

3. 重启服务，访问同源 `/api/ai/status`，检查 `enabled`，再从指挥台实际发起一次「AI 研判」确认服务可用。缺少凭据时可设置 `AI_MOCK=1` 验证模拟流程。强化学习排序在本地运行，无需模型 API。

### 修改后及时推送 GitHub

每次完成可独立验证的改动后，先运行测试并检查暂存内容，再提交与推送。用具体路径替换示例中的文件列表。

```powershell
npm run build
npm test
npm run check:secrets
git status --short
git add -- README.md src
git diff --cached --stat
git diff --cached
git commit -m "Describe the GeoRelay change"
git push origin main
```

`.env`、构建目录和本地验收产物属于本地文件。只提交空值模板 `.env.example`，检查 README、截图和日志中也没有凭据。协作开发时在功能分支提交和推送，再通过 Pull Request 合入主分支。
