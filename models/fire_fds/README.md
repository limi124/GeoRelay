# `fire_entrance_smoke_v1` — FDS 固定火灾小算例

本目录存放 GeoRelay 火灾演练可视化所用的**固定、可复现**的 FDS（NIST Fire Dynamics Simulator）算例。
目标不是做工程设计级 CFD，而是为「社区门厅/通道起火 → 烟气能见度下降 → 入口不可通行」这条演练逻辑
提供一个**真实求解器输出**的烟气/能见度时间序列，供上层程序直接消费（不手写、不插值、不编造数值）。

- 输入文件：`fire_entrance_smoke_v1.fds`（本目录）
- 求解器：FDS 6.11.2（Smokeview 6.11.3），Windows x64
- 求解命令：`fds fire_entrance_smoke_v1.fds`（工作目录即本目录）
- 产物归档：`artifacts/model-runs/fds-fire-entrance-<YYYYMMDD>/`

---

## 1. 算例目的

1. 给定一个**固定几何 + 固定火源**，让 FDS 真实求解 300 s 的浮力驱动烟气输运；
2. 在「入口 / 通道上游 / 通道下游 / 出口」四个位置输出**能见度**（`VISIBILITY`，m）时间序列，
   作为 GeoRelay 火灾演练中「入口受烟、通道能见度不足」判定的**数据来源**；
3. 同时输出温度（`TEMPERATURE`，°C）与消光系数（`EXTINCTION COEFFICIENT`，1/m），
   便于反查能见度变化的物理原因（消光系数 ∝ 烟粒子浓度）。

## 2. 几何（简化模型）

计算域是一个**单层矩形大厅/通道**，x 方向为「入口 → 出口」的主通行方向：

| 项目 | 取值 |
| --- | --- |
| 计算域 | 12.0 m (x) × 8.0 m (y) × 3.0 m (z) |
| 净空高度 | 3.0 m（单层门厅，无吊顶造型、无梁、无家具） |
| 入口门（x = 0 墙面） | 1.2 m 宽 × 2.1 m 高，位于 y = 3.4–4.6 m，**敞开** |
| 出口门（x = 12 m 墙面） | 1.2 m 宽 × 2.1 m 高，位于 y = 3.4–4.6 m，**敞开** |
| 其余墙面 / 地面 / 顶棚 | 默认惰性固体边界（`INERT_WALL`） |

两扇门与火源都在 y = 4.0 m 中轴线上，因此形成一条「入口进风 → 火源 → 出口排烟」的贯通流路。

## 3. 火源

| 项目 | 取值 |
| --- | --- |
| 设计热释放速率 | **500 kW（稳态，无增长段）** |
| 燃烧器面积 | 1.0 m × 1.0 m 顶面（`&OBST` 顶面 `SURF_IDS='BURNER'`，四周与底面惰性） |
| HRRPUA | **500 kW/m²**（500 kW / 1.0 m²） |
| 燃烧器位置 | x = 5.0–6.0 m，y = 3.5–4.5 m，z = 0.0–0.1 m（贴地薄垫） |
| 燃料 | 丙烷替代燃料 `FUEL='PROPANE'`（代表混合内饰/塑料火荷载） |
| 产烟率 | `SOOT_YIELD = 0.10`（能见度的决定性参数） |
| CO 产率 | `CO_YIELD = 0.01` |

火源位于入口（x=0）与出口（x=12）之间，距入口 5.0 m、距出口 6.0 m。

## 4. 边界条件与初始化

| 项目 | 取值 |
| --- | --- |
| 环境温度 | `TMPA = 20 °C` |
| 初始场 | 静止、均匀 20 °C、无初始烟气 |
| 门洞 | `SURF_ID='OPEN'`（压力边界，允许双向流动） |
| 壁面 | `&SURF ID='INERT_WALL', DEFAULT=.TRUE., TMP_FRONT=20.0` — **惰性、定温 20 °C**，不模拟墙体材料热惯性 |
| 辐射 | 开启（`RADIATION=.TRUE.`，FDS 默认辐射模型） |
| 湍流 | FDS 默认（Deardorff 型 LES 亚格子模型） |

## 5. 网格与时间

| 项目 | 取值 |
| --- | --- |
| 网格 | 单一 `&MESH`，`IJK = 48 × 32 × 12` = **18,432 个网格单元** |
| 网格步长 | **0.25 m**（x/y/z 均匀，与 12 / 8 / 3 m 计算域整除对齐） |
| 模拟时长 | `T_END = 300 s` |
| 输出间隔 | `DT_DEVC = 5.0 s`、`DT_HRR = 5.0 s`（0 s 起，共 61 个采样时刻） |
| 时间步 | 由 FDS 按 `CFL_MAX = 1.0` 自适应控制 |
| 重启文件 | 关闭（`DT_RESTART = 10000 s`） |

> 0.25 m 网格对 1 m × 1 m 火源只有 4×4 个单元，属于**偏粗**的演示级分辨率；见第 8 节。

## 6. 采样点（DEVC）

全部位于 **z = 1.7 m（人员呼吸高度）**、y = 4.0 m 中轴线上：

| DEVC ID | x (m) | y (m) | z (m) | 物理含义 | 对应 GeoRelay 对象（见 `mapping.json`） |
| --- | --- | --- | --- | --- | --- |
| `S1_ENTRANCE` | 0.5 | 4.0 | 1.7 | 入口门内侧 0.5 m | `entrance` / `entrance:bld-preset6`（1 号楼主入口），影响半径 8 m |
| `S2_CORRIDOR_A` | 3.5 | 4.0 | 1.7 | 通道上游，火源靠入口侧 1.5 m | `road` / `road-preseti`（西门主动脉），影响半径 6 m |
| `S3_CORRIDOR_B` | 8.5 | 4.0 | 1.7 | 通道下游，火源靠出口侧 2.5 m | `road` / `road-presetm`（3 号楼入口支线），影响半径 6 m |
| `S4_EXIT` | 11.5 | 4.0 | 1.7 | 出口门内侧 0.5 m | `entrance` / `entrance:bld-preset7`（2 号楼主入口），影响半径 8 m |

> 机器可读的「采样点 → GeoRelay 对象」映射与演练判据分别存放在同目录的
> `mapping.json`（对象映射、影响半径）与 `drill-rules.json`（能见度阈值 → 通行状态）。
> **FDS 只提供探针处的能见度时序；「是否判定为不可通行」是演练规则层的事，不在本算例内。**
> 注意：`influenceRadiusM` 是地图示意用的固定值，不是 FDS 算出的烟气扩散范围。


坐标单位为米，原点在计算域左下角（x=0 为入口墙面，y=0 为一侧墙，z=0 为地面）。
`lngLatHint` 在清单中为 `null`：本源算例是**局部米制坐标**，尚未绑定到 WGS-84 经纬度，
调用方需自行按演练场景做局部坐标 → 经纬度的平移旋转映射。

每个采样点定义 3 个 `&DEVC`，命名规则 `S<n>_<NAME>` / `_TEMP` / `_EXT`：

- `QUANTITY='VISIBILITY'` → 单位 **m**（FDS 按消光系数与反光标志物判据计算）
- `QUANTITY='TEMPERATURE'` → 单位 **°C**
- `QUANTITY='EXTINCTION COEFFICIENT'` → 单位 **1/m**

`_devc.csv` 的列名即为上述 DEVC ID，可直接按 ID 取列。

## 7. 适用范围内与假设（重要）

**适用**：

- 单层、规则矩形、无隔断、无家具的小型门厅/通道；
- 火源位于通行路线上，两侧门洞敞开的「贯通式」通风条件；
- 关心的是**呼吸高度处能见度随时间的相对趋势**与量级（数十米 → 数米），
  以及「入口是否因烟气而不可通行」这一判定所需的阈值比较。

**关键假设（不适用于严格审查）**：

1. **火源为稳态 500 kW**，无 t² 增长段、无衰减、无喷淋/排烟启动；
2. **墙体为定温 20 °C 惰性面**，不模拟混凝土/石膏的热惯性、不模拟壁面烟尘沉积；
3. 单一丙烷替代燃料，`SOOT_YIELD = 0.10` 为取值假设（真实内饰材料差异很大，直接影响能见度绝对值）；
4. 无机械排烟、无开窗、无人员/家具阻塞，门洞为全开状态；
5. 单一均匀 0.25 m 网格，**未做网格无关性验证**；
6. 单精度 FDS 默认数值设置，未做敏感性分析。

## 8. 已知局限 / 后续工作

- **未做网格无关性验证**：0.25 m 网格对 1 m 火源仅有 4×4 单元，羽流解析偏粗；
  定性趋势可用，绝对能见度值不应作为设计依据。后续可用 0.125 m 网格重跑对比。
- **未做敏感性分析**：`SOOT_YIELD`、火源功率、门洞开度是能见度的三个主导参数。
- 局部米制坐标尚未与真实场地经纬度对齐（`lngLatHint: null`）。
- 单次确定性计算（FDS LES 在固定输入下可复现，但不同 FDS 版本/编译选项可能有细微差异）。

## 9. 如何复跑

```powershell
# 在 models\fire_fds 下
& 'E:\GeoRelay\.tools\fds\fds.exe' fire_entrance_smoke_v1.fds
```

FDS 会在当前目录生成：

- `fire_entrance_smoke_v1_devc.csv` — DEVC 时间序列（本算例的主要交付物）
- `fire_entrance_smoke_v1_hrr.csv` — 热释放速率时间序列
- `fire_entrance_smoke_v1.out` — 求解日志（版本、网格、稳定性、警告）
- `fire_entrance_smoke_v1.smv` — Smokeview 索引文件
- `fire_entrance_smoke_v1.bf` / `.restart` 等中间文件（可丢弃）

后处理脚本与归档见 `artifacts/model-runs/fds-fire-entrance-<YYYYMMDD>/`。

辅助脚本（本目录）：

| 文件 | 作用 |
| --- | --- |
| `run_fds.ps1` | 设置 PATH（含 `impi.dll` 所在目录）并运行算例，输出 `run.log` |
| `archive_run.py` | 把产物复制到 `artifacts/model-runs/<runId>/` 并生成 `manifest.json` |
| `make_devc_summary.py` | 把 `_devc.csv` 转成 `devc-summary.json`（纯数值搬运，不插值/不平滑） |
| `verify_run.py` | 回读求解器自己的输出，打印校验摘要 |

---

## 10. 安装方式（供复现，实际踩过的坑）

FDS 官方 Windows 安装包 `FDS-6.11.2_SMV-6.11.3_win.exe`（175.4 MB，sha256
`42F37820C61492C67A65C3E7938ADE17989B00346963E66925E3E5EFE7EABDD4`）
**不是 NSIS 安装包，而是 7-Zip SFX 自解压包**（内嵌 `7zS.sfx` 存根）。
因此 `Start-Process -ArgumentList '/S','/D=...'` 的 NSIS 静默安装方式**无效**，
会挂起（进程存留但不落任何文件）。

可用的解包方式：

```powershell
# 用 7-Zip 直接解包 SFX（推荐）
& 'E:\GeoRelay\.tools\7zip\Files\7-Zip\7z.exe' x <installer.exe> -oE:\GeoRelay\.tools\fds -y
# -> E:\GeoRelay\.tools\fds\firemodels\FDS6\bin\fds.exe
```

> 7-Zip 本身来自 `7z2501-x64.msi`，用 `msiexec /a ... TARGETDIR=... /qn` 做管理安装解出，
> 无需管理员权限。

**关键：`fds.exe` 依赖同目录 `mpi\` 下的 `impi.dll`。** 若 PATH 中没有该目录，
`fds.exe -v` 会直接以 `-1073741515`（`0xC0000135`，STATUS_DLL_NOT_FOUND）退出，无任何提示。
必须先把 `<...>\bin\mpi` 加入 PATH（`fdsinit.bat` / `fdspath.bat` 做的就是这件事）。

```powershell
$env:PATH = 'E:\GeoRelay\.tools\fds\firemodels\FDS6\bin\mpi;E:\GeoRelay\.tools\fds\firemodels\FDS6\bin;' + $env:PATH
& 'E:\GeoRelay\.tools\fds\firemodels\FDS6\bin\fds.exe' -v
# FDS revision       : FDS-6.11.2-0-g8e4c2c4-release
# MPI library version: Intel(R) MPI Library 2021.16 for Windows* OS
```

---

## 11. 已完成的真实运行记录

| 项目 | 值 |
| --- | --- |
| 运行日期 | 2026-11-18 |
| 求解器 | `E:\GeoRelay\.tools\fds\firemodels\FDS6\bin\fds.exe` |
| 版本原文 | `FDS revision : FDS-6.11.2-0-g8e4c2c4-release` |
| 状态 | **ok** — `STOP: FDS completed successfully (CHID: fire_entrance_smoke_v1)`，进程退出码 0 |
| 时间步 | 8748 步（初始 dt 0.23 s，末步 0.774 ms，CFL 自适应） |
| 墙钟 | FDS 内部计时 519.961 s；进程墙钟 520.2 s |
| 稳态 HRR 实测 | 末 20 个采样点均值 **500.04 kW**（min 498.64 / max 501.34），与 500 kW 设计值一致 |
| 采样 | 61 个时刻（0 → 300 s，DT_DEVC≈5 s，实际均值 5.0 s）× 12 通道 |

能见度实测（单位 m，取自 `fire_entrance_smoke_v1_devc.csv`）：

| 采样点 | t = 0 s | t = 300 s | 全程最小 |
| --- | --- | --- | --- |
| `S1_ENTRANCE` | 30.0000 | 0.7127 | 0.7100 |
| `S2_CORRIDOR_A` | 30.0000 | 0.7136 | 0.6981 |
| `S3_CORRIDOR_B` | 30.0000 | 0.6989 | 0.6974 |
| `S4_EXIT` | 30.0000 | 0.6645 | 0.6645 |

解读：t=0 时全为 30 m（FDS 能见度上限，洁净空气）；约 **15–20 s** 内能见度从 30 m 骤降到
个位数米（烟气前锋抵达呼吸高度），300 s 时稳定在 **0.66–0.71 m**，即四个采样点全都
远低于「影响疏散」的判据阈值。温度同步升到约 95–105 °C（`*_TEMP` 通道），
消光系数约 4.2–4.5 1/m（`*_EXT` 通道），与能见度完全自洽（V ≈ 3/K）。

> 说明：三个采样点（含出口）能见度几乎相同，是因为 500 kW / 288 m³ 的火荷载对这个小空间
> 而言非常大，300 s 内整个空间已被烟气充满、层化消失。若需要区分「入口先受烟、出口后受烟」
> 的时间差，应降低火源功率或延长模拟时长。

归档目录：`artifacts/model-runs/fds-fire-entrance-20261118/`
（`fire_entrance_smoke_v1_devc.csv`、`_hrr.csv`、`.out`、`.smv`、`run.log`、
`devc-summary.json`、`manifest.json`）。
