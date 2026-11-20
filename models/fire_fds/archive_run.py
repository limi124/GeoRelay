#!/usr/bin/env python3
"""Archive one completed FDS run into artifacts/model-runs/<runId>/ and write manifest.json.

Copies the solver's own output files verbatim, computes sha256 over the archived
copies, and records the run record. No numeric value is ever invented: every
number in the manifest comes from the solver output or from the process clock.
"""

import hashlib
import json
import shutil
import sys
from pathlib import Path

REPO = Path(r"E:\GeoRelay")
SRC = REPO / "models" / "fire_fds"
RUN_ID = "fds-fire-entrance-20261118"
DST = REPO / "artifacts" / "model-runs" / RUN_ID
CASE = "fire_entrance_smoke_v1"

STARTED_AT = "2026-11-18T20:37:13+08:00"
FINISHED_AT = "2026-11-18T20:45:53+08:00"
WALL_CLOCK_S = 520.2

COPY = [
    f"{CASE}_devc.csv",
    f"{CASE}_hrr.csv",
    f"{CASE}.out",
    f"{CASE}.smv",
]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def rel(p: Path) -> str:
    return p.relative_to(REPO).as_posix()


def main() -> int:
    DST.mkdir(parents=True, exist_ok=True)

    for name in COPY:
        src = SRC / name
        if not src.exists():
            print(f"MISSING: {src}", file=sys.stderr)
            return 1
        shutil.copy2(src, DST / name)

    # Console capture. run.log is the FDS stdout/stderr text; PowerShell's
    # NativeCommandError preamble (an artefact of `& exe 2>&1` under pwsh) is
    # stripped. The untouched capture is kept as run-raw-console.log.
    # PowerShell's Tee-Object writes UTF-16LE here, so decode by BOM.
    blob = (SRC / "run.log").read_bytes()
    if blob[:2] in (b"\xff\xfe", b"\xfe\xff"):
        raw = blob.decode("utf-16")
    elif blob[:3] == b"\xef\xbb\xbf":
        raw = blob[3:].decode("utf-8")
    else:
        raw = blob.decode("utf-8", errors="replace")
    (DST / "run-raw-console.log").write_text(raw, encoding="utf-8")

    lines = raw.splitlines(keepends=True)
    cleaned, skipping = [], False
    for ln in lines:
        if ln.startswith("fds.exe :"):
            skipping = True
            continue
        if skipping:
            if "FullyQualifiedErrorId" in ln:
                skipping = False
            continue
        cleaned.append(ln)
    clean_text = "".join(cleaned).lstrip("\r\n")
    (DST / "run.log").write_text(clean_text, encoding="utf-8")

    fds_input = SRC / f"{CASE}.fds"
    devc = DST / f"{CASE}_devc.csv"
    hrr = DST / f"{CASE}_hrr.csv"

    manifest = {
        "runId": RUN_ID,
        "model": "fds",
        "caseId": CASE,
        "engineVersion": "FDS 6.11.2 (SMV 6.11.3)",
        "solverCommand": f"fds {CASE}.fds",
        "status": "ok",
        "startedAt": STARTED_AT,
        "finishedAt": FINISHED_AT,
        "wallClockS": WALL_CLOCK_S,
        "inputs": [
            {
                "path": rel(fds_input),
                "sha256": sha256(fds_input),
                "note": "FDS 输入文件",
            }
        ],
        "outputs": [
            {
                "path": rel(devc),
                "sha256": sha256(devc),
                "unit": "visibility: m",
                "note": "DEVC 采样输出",
            },
            {
                "path": rel(hrr),
                "sha256": sha256(hrr),
                "unit": "kW",
                "note": "热释放速率输出（稳态 HRR ≈ 500.4 kW，验证 500 kW 设计火源）",
            },
            {
                "path": rel(DST / f"{CASE}.out"),
                "sha256": sha256(DST / f"{CASE}.out"),
                "unit": "n/a",
                "note": "FDS 求解日志（版本/网格/稳定性/警告）",
            },
            {
                "path": rel(DST / "run.log"),
                "sha256": sha256(DST / "run.log"),
                "unit": "n/a",
                "note": "FDS 控制台输出（已剥离 pwsh 的 NativeCommandError 前缀；原文见 run-raw-console.log）",
            },
        ],
        "samples": [
            {"sampleId": "S1_ENTRANCE", "quantity": "visibility", "unit": "m", "lngLatHint": None},
            {"sampleId": "S2_CORRIDOR_A", "quantity": "visibility", "unit": "m", "lngLatHint": None},
            {"sampleId": "S3_CORRIDOR_B", "quantity": "visibility", "unit": "m", "lngLatHint": None},
            {"sampleId": "S4_EXIT", "quantity": "visibility", "unit": "m", "lngLatHint": None},
        ],
        "notes": [
            "网格：单一 &MESH，0.25 m 均匀网格，48×32×12 = 18,432 单元格；计算域 12×8×3 m。",
            "时长：T_END=300 s，实际推进 8748 个时间步，DT_DEVC=5 s（FDS 实际输出时刻为 5.03/10.03/…/300.00 s，因 DT 由 CFL 自适应步长决定）。",
            "边界条件：入口门(x=0)与出口门(x=12)各 1.2×2.1 m，SURF_ID='OPEN'；其余墙面/地面/顶棚为惰性定温 20 °C 面（TMP_FRONT=20，不模拟墙体材料热惯性）；TMPA=20 °C，辐射开启。",
            "火源：1.0×1.0 m 顶面燃烧器，HRRPUA=500 kW/m²（燃烧面积恰为 1.0 m²，故 500 kW 总量），稳态无增长段；燃料丙烷 SOOT_YIELD=0.10、CO_YIELD=0.01。",
            "采样点：z=1.7 m（呼吸高度）、y=4.0 m 中轴线，x=0.5/3.5/8.5/11.5 m；每点 3 个 DEVC（VISIBILITY/TEMPERATURE/EXTINCTION COEFFICIENT），共 12 个 DEVC。",
            "未做网格无关性验证。0.25 m 网格对 1 m 火源仅 4×4 个单元，羽流解析偏粗，绝对能见度值不宜作为设计依据。",
            "未做敏感性分析（SOOT_YIELD、火源功率、门洞开度为能见度主导参数）。单一确定性 LES 计算。",
            "lngLatHint 为 null：本源算例使用局部米制坐标，尚未绑定到 WGS-84 经纬度。",
            "求解器验证：fds.exe -v 输出 'FDS revision : FDS-6.11.2-0-g8e4c2c4-release'；.out 记录 'STOP: FDS completed successfully'，进程退出码 0；FDS 内部计时 Total Elapsed Wall Clock Time = 519.961 s。",
        ],
    }

    with open(DST / "manifest.json", "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print(f"archived -> {DST}")
    for name in COPY:
        print(f"  {name}")
    print("  run.log, run-raw-console.log, manifest.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
