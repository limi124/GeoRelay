# 火灾算例：FDS `fire_entrance_smoke_v1`

本页说明 GeoRelay 火灾演练接入的 FDS 算例：它算什么、本机怎么跑通的、输出怎么映射到社区的入口与路段、哪些结论是模型的、哪些是 GeoRelay 演练规则判的、以及明确做不到的地方。

- 求解器：**FDS 6.11.2**（`FDS-6.11.2-0-g8e4c2c4-release`，Smokeview 6.11.3）
- 算例输入：`models/fire_fds/fire_entrance_smoke_v1.fds`
- 归档：`artifacts/model-runs/fds-fire-entrance-20261118/`
- 来源层级：`model`（模型计算结果回放，本机真实跑过求解器）

---

## 1. 算例概览

| 项目 | 取值 | 出处 |
| --- | --- | --- |
| 计算域 | 12 m（x，入口→出口）× 8 m（y）× 3 m（z） | `.fds` 的 `&MESH XB=` |
| 网格 | 0.25 m 均匀，48 × 32 × 12 = 18,432 单元 | `.out` 的 Grid Dimensions |
| 火源 | 1.0 m × 1.0 m 顶面燃烧器，HRRPUA = 500 kW/m²，合计 **500 kW 稳态** | `.fds` 的 `&SURF BURNER` + `&OBST` |
| 燃料 | 丙烷替代燃料，`SOOT_YIELD = 0.10`、`CO_YIELD = 0.01` | `.fds` 的 `&REAC` |
| 门洞 | 入口（x=0）与出口（x=12）各 1.2 × 2.1 m，`SURF_ID='OPEN'` | `.fds` 的 `&VENT` |
| 壁面 | 惰性定温 20 °C（`TMP_FRONT=20`，不模拟墙体热惯性） | `.fds` 的 `&SURF INERT_WALL` |
| 时长 / 输出间隔 | `T_END=300 s`，`DT_DEVC=5 s`、`DT_HRR=5 s` | `.fds` 的 `&TIME` / `&DUMP` |
| 采样通道 | 4 个位置 × 3 个量（VISIBILITY / TEMPERATURE / EXTINCTION COEFFICIENT）= 12 个 `&DEVC` | `.fds` |
| 时间步 | 8748 步（`CFL_MAX=1.0` 自适应） | `.out` 末段 `Time Step 8748` |

计算域是一条「入口进风 → 火源 → 出口排烟」的贯通流路：两扇门与火源都在 y = 4.0 m 中轴线上。

---

## 2. 算例假设与适用范围

**适用**：单层、规则矩形、无隔断无家具的小型门厅 / 通道；火源位于通行路线上、两侧门洞敞开的贯通式通风；关心的是**呼吸高度（z=1.7 m）处能见度随时间的量级与趋势**，以及「是否低于阈值」这个比较。

**关键假设**：

1. 火源为**稳态 500 kW**，无 t² 增长段、无衰减、无喷淋 / 排烟启动；
2. 墙体是定温 20 °C 惰性面，不模拟热惯性、不模拟壁面烟尘沉积；
3. 单一丙烷替代燃料，`SOOT_YIELD = 0.10` 是取值假设（它直接决定能见度绝对值）；
4. 无机械排烟、无开窗、无人员或家具阻塞，门洞全开；
5. 单一 0.25 m 均匀网格，**未做网格无关性验证**；
6. 单次确定性 LES 计算，未做敏感性分析。

**不属于本算例结论的事**：本社区的防火设计、疏散可用时间、性能化设计验证、烟气扩散范围。

---

## 3. 安装 FDS（两个真实的坑）

安装包：`FDS-6.11.2_SMV-6.11.3_win.exe`，**175.42 MB**，sha256
`42F37820C61492C67A65C3E7938ADE17989B00346963E66925E3E5EFE7EABDD4`（本机对下载到的文件用 `Get-FileHash -Algorithm SHA256` 实测）。下载副本留在 `artifacts/model-runs/_downloads/`（该目录不入库）。

### 坑 1：它不是 NSIS 安装包，而是 7-Zip SFX 自解压包

`Start-Process -ArgumentList '/S','/D=...'` 这类 NSIS 静默安装方式**不会生效**：进程留在那里，但不落任何文件。正确做法是当压缩包解：

```powershell
# 本机 7-Zip 通过管理安装解出，无需管理员权限：
#   msiexec /a artifacts\model-runs\_downloads\7z-x64.msi TARGETDIR=E:\GeoRelay\.tools\7zip /qn
& 'E:\GeoRelay\.tools\7zip\Files\7-Zip\7z.exe' x `
    artifacts\model-runs\_downloads\FDS-6.11.2_SMV-6.11.3_win.exe `
    -oE:\GeoRelay\.tools\fds -y
# → E:\GeoRelay\.tools\fds\firemodels\FDS6\bin\fds.exe
```

### 坑 2：`fds.exe` 依赖同目录 `bin\mpi` 下的 Intel MPI DLL

若 PATH 里没有 `bin\mpi`，`fds.exe` 直接以 `0xC0000135`（`-1073741515`，STATUS_DLL_NOT_FOUND）退出，**没有任何提示**。`bin` 下的 `fdsinit.bat` / `fdspath.bat` 做的就是补 PATH。

```powershell
$env:PATH = 'E:\GeoRelay\.tools\fds\firemodels\FDS6\bin\mpi;' +
            'E:\GeoRelay\.tools\fds\firemodels\FDS6\bin;' + $env:PATH
& 'E:\GeoRelay\.tools\fds\firemodels\FDS6\bin\fds.exe' -v
# FDS revision       : FDS-6.11.2-0-g8e4c2c4-release
# MPI library version: Intel(R) MPI Library 2021.16 for Windows* OS
```

`scripts/model_run_fds.ts` 已经把 `bin` 与 `bin\mpi` 前置进子进程 PATH，正常复跑不需要手动设置。默认安装路径是 `.tools/fds/firemodels/FDS6/bin/fds.exe`，也可以用环境变量 `FDS_EXE` 指定别的 `fds.exe`。

---

## 4. 如何复跑

```bash
# 只自检：定位求解器、打印版本与计划，不求解
npm run model:run:fds -- --dry-run

# 正式复跑（本机实测约 8.7 分钟 / 墙钟 520.2 s）
npm run model:run:fds

# 已经存在 status=ok 的归档时，脚本默认「复用、不重跑」；要重跑：
npm run model:run:fds -- --force

# 不求解，只用 models/fire_fds/ 下已有的求解器输出重建归档
npm run model:run:fds -- --archive-only
```

脚本做的事（`scripts/model_run_fds.ts`）：

1. 定位 `fds.exe`（`FDS_EXE` > 默认安装路径），`fds.exe -v` 读版本；
2. 以 `models/fire_fds` 为工作目录运行 `fds fire_entrance_smoke_v1.fds`（FDS 把 `*_devc.csv` / `*.out` 写在 cwd）；
3. 退出码为 0 且三个输出文件齐全才写 `status: 'ok'` 的 `manifest.json`，同时把原始输出复制进归档；
4. 解析 `_devc.csv`，只取 4 个 VISIBILITY 列，**原样搬运**（缺测写 `null`，不插值、不平滑、不做单位换算），写成 `devc-summary.json`；
5. 任一步失败就写 `status: 'failed'` 的 manifest（含 `failure.stage/message/log`），退出码 1，不写 `devc-summary.json`。

不想走脚本也可以直接跑求解器（结果等价，但要自己整理归档）：

```powershell
cd models\fire_fds
& 'E:\GeoRelay\.tools\fds\firemodels\FDS6\bin\fds.exe' fire_entrance_smoke_v1.fds
```

---

## 5. 输出与采样点映射

### 求解器输出

| 文件 | 内容 |
| --- | --- |
| `fire_entrance_smoke_v1_devc.csv` | 12 个 DEVC 通道的时间序列（第 1 行单位、第 2 行通道名、之后每行第 1 列是时间） |
| `fire_entrance_smoke_v1_hrr.csv` | 热释放速率时程（kW） |
| `fire_entrance_smoke_v1.out` | 求解日志：版本、网格、时间步、稳定性、`STOP` 状态 |
| `fire_entrance_smoke_v1.smv` | Smokeview 索引文件（可视化用，不是数值来源） |

### 采样点 → GeoRelay 对象

映射在 `models/fire_fds/mapping.json`（人工标注，**仅对预置演练社区有效**）：

| DEVC 采样点 | 位置（x, y, z）m | 物理含义 | 映射到的对象 | 影响圈半径（示意） |
| --- | --- | --- | --- | --- |
| `S1_ENTRANCE` | 0.5, 4.0, 1.7 | 入口门内侧 0.5 m | `entrance:bld-preset6`（1 号楼主入口） | 8 m |
| `S2_CORRIDOR_A` | 3.5, 4.0, 1.7 | 通道上游（火源靠入口侧） | `road-preseti`（西门 主动脉） | 6 m |
| `S3_CORRIDOR_B` | 8.5, 4.0, 1.7 | 通道下游（火源靠出口侧） | `road-presetm`（3 号楼 入口支线） | 6 m |
| `S4_EXIT` | 11.5, 4.0, 1.7 | 出口门内侧 0.5 m | `entrance:bld-preset7`（2 号楼主入口） | 8 m |

关于这张表必须说清楚的三件事：

- **映射不是物理对应**。FDS 房间使用局部米制坐标，没有社区经纬度（manifest 里 `lngLatHint` 为 `null`）；把「房间走廊」映射到演练社区的主干道与楼栋支线，只是为了把烟气时程落到可调度的对象上。
- **`influenceRadiusM` 是地图示意用的固定值**，不是 FDS 算出的烟气扩散范围。FDS 只输出探针处的时程值。
- 换成用户自建社区时需要在界面里重新选择目标（映射表不适用）。

---

## 6. 判定规则（判据层，不是模型结论）

规则在 `models/fire_fds/drill-rules.json`，作用对象是 `entrance` / `road` / `staging`：

| 规则 ID | 判据 | 结果 | 说明 |
| --- | --- | --- | --- |
| `fire-vis-blocked` | 能见度 **< 10 m** | `blocked`（不可通行） | 达到即触发入口 / 路段受阻事件 |
| `fire-vis-restricted` | 能见度 **< 25 m** | `restricted`（受限但可通行） | 只做提示与图层着色，不改派单 |

阈值参照「能见度低于约 10 m 视为难以通行」的量级，属于**演练假设**，不是 FDS 的结论。改阈值只需改这个文件再 `npm run model:ingest`，不必重跑求解器。

换算过程（`scripts/model_ingest.ts` 的 `buildFireEvents()`）：对每个采样点找**第一次**越过 `fire-vis-blocked` 阈值的时刻，生成一条 `ImpactEvent`；越限时刻即事件的演练时刻。

本机实测结果：四个采样点都在 **t ≈ 20.02 s** 越过 10 m（对应 61 个采样时刻里的第 5 个时刻），因此归档里是 **4 条模型事件**，全部为 `blocked`。

---

## 7. 归档字段

`artifacts/model-runs/fds-fire-entrance-20261118/` 目录：

| 文件 | 说明 |
| --- | --- |
| `manifest.json` | 按 `src/domain/modelrun/types.ts` 的 `ModelManifest` |
| `devc-summary.json` | 4 个 VISIBILITY 采样点的时程（`samples[].series[{t, value}]` + `tEnd` + `dtS`） |
| `devc-summary-all-channels.json` | 全部 12 个通道的时程（温度、消光系数也在内，供反查用；入库流程只读 `devc-summary.json`） |
| `fire_entrance_smoke_v1_devc.csv` / `.out` / `_hrr.csv` / `.smv` | 求解器原始输出副本 |
| `run.log` / `run-raw-console.log` | 求解器控制台输出（后者是未经前缀处理的原文） |

`manifest.json` 关键字段：

| 字段 | 本算例取值 |
| --- | --- |
| `runId` / `model` / `caseId` | `fds-fire-entrance-20261118` / `fds` / `fire_entrance_smoke_v1` |
| `engineVersion` | `FDS 6.11.2 (SMV 6.11.3)` |
| `solverCommand` | `fds fire_entrance_smoke_v1.fds`（工作目录 `models/fire_fds`） |
| `status` | `ok` |
| `startedAt` / `finishedAt` | `2026-11-18T20:37:13+08:00` / `2026-11-18T20:45:53+08:00` |
| `wallClockS` | `520.2` |
| `inputs[]` | `.fds` 输入，sha256 `8f22cadf…ceba7a2`（完整值见 manifest） |
| `outputs[]` | 4 个输出文件，各带 sha256、单位、说明 |
| `samples[]` | 4 个采样点（`S1_ENTRANCE` / `S2_CORRIDOR_A` / `S3_CORRIDOR_B` / `S4_EXIT`） |
| `notes[]` | 网格、时长、边界、火源、采样点、未做网格无关性 / 敏感性的声明 |

---

## 8. 本机实测数字

| 项目 | 实测值 | 出处 |
| --- | --- | --- |
| 版本原文 | `FDS revision : FDS-6.11.2-0-g8e4c2c4-release` | `.out` 头部、`fds.exe -v` |
| 结束标志 | `STOP: FDS completed successfully (CHID: fire_entrance_smoke_v1)`，进程退出码 0 | `.out` 末行 |
| 时间步数 | 8748 | `.out` 末段 |
| 墙钟 | 进程 520.2 s；FDS 内部计时 519.961 s（其时间步进 518.525 s） | `manifest.wallClockS` / `.out` 尾部 |
| 日志告警 | `.out` 中无 `ERROR` / `WARNING` 行 | `.out` 全文检索 |
| 稳态 HRR | 末段总 HRR 均值 **500.04 kW**（验证 500 kW 设计火源） | `manifest.outputs[].note`（由 `_hrr.csv` 统计） |
| 采样时刻 | 61 个（0 → 300 s，`dtS` 中位数 5 s；首间隔 5.0320944 s，因 dt 由 CFL 自适应决定） | `devc-summary.json` |
| t = 300 s 能见度 | 0.664 – 0.714 m（四点分别 0.7127 / 0.7136 / 0.6989 / 0.6645） | `_devc.csv` 末行 |
| t = 300 s 温度 | 95.5 / 98.5 / 97.0 / 103.9 ℃（即 95–104 ℃） | `_devc.csv` 末行 `*_TEMP` |
| t = 300 s 消光系数 | 4.210 / 4.204 / 4.294 / 4.515 1/m（即 4.21–4.51 1/m） | `_devc.csv` 末行 `*_EXT` |

自洽性检查：能见度 ≈ 3 / 消光系数（3 / 4.2098 = 0.713，与同点 0.7127 一致），说明两列没有互相矛盾。

解读：t = 0 时四个点都是 30 m（FDS 能见度上限，洁净空气），约 15–20 s 内骤降到个位数米（烟气前锋抵达呼吸高度），300 s 时稳定在 0.66–0.71 m，远低于两条演练阈值。四个点几乎同步，是因为 500 kW / 288 m³ 的火荷载对这个空间非常大，300 s 内整个空间已被烟气充满、层化消失——**不要拿它去论证「入口先受烟、出口后受烟」的时间差**。

---

## 9. 限制（照实写）

1. **单室场景**：一个矩形门厅 / 通道，无隔断、无家具、无吊顶造型，不能外推到多层建筑、中庭、地下车库。
2. **未做网格无关性验证**：0.25 m 网格对 1 m 火源只有 4×4 个单元，羽流解析偏粗。**绝对能见度值不宜作为设计依据**，只能用于「是否低于阈值」这类量级判断。要更细可比 0.125 m 网格重跑。
3. **未做敏感性分析**：`SOOT_YIELD`、火源功率、门洞开度是能见度的三个主导参数，本算例各取一个固定值；没有给出区间或不确定性。
4. **映射非物理对应**：探针的局部坐标与社区经纬度没有换算关系，`mapping.json` 是人工标注，只对预置演练社区有效。
5. **影响圈半径是示意**：地图上的圆形范围是固定半径，不是 FDS 算出的烟气扩散边界。
6. **不是性能化设计验证**：算例没有按任何消防规范设定设计火灾、没有疏散时间（RSET）与可用疏散时间（ASET）的比较、没有喷淋 / 排烟系统建模。
7. **归档不入库**：`artifacts/`、`.tools/` 被 `.gitignore` 忽略；换机器要重装 FDS 才能复跑（不装也能看已入库的 `src/data/model-runs/*.json` 回放数据）。

---

## 10. 相关文件

- 输入与求解器侧说明：`models/fire_fds/README.md`、`models/fire_fds/fire_entrance_smoke_v1.fds`
- 映射与规则：`models/fire_fds/mapping.json`、`models/fire_fds/drill-rules.json`
- 脚本：`scripts/model_run_fds.ts`、`scripts/model_ingest.ts`、`scripts/model_verify.ts`
- 回放缓存：`src/data/model-runs/fds-fire-entrance-20261118.json`
- 总览：[`docs/models/README.md`](README.md)
