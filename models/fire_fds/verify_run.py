#!/usr/bin/env python3
"""Sanity-check a finished run of fire_entrance_smoke_v1.

Reads the solver's own files and prints a summary. It asserts nothing about
physics; it only reports what FDS produced, so the numbers in any report can be
traced back to a file.

Usage:
    python verify_run.py [<run-dir>]
Default run dir: artifacts/model-runs/fds-fire-entrance-20261118
"""

import csv
import json
import sys
from pathlib import Path

REPO = Path(r"E:\GeoRelay")
CASE = "fire_entrance_smoke_v1"
VIS_IDS = ["S1_ENTRANCE", "S2_CORRIDOR_A", "S3_CORRIDOR_B", "S4_EXIT"]


def read_devc(path):
    rows = list(csv.reader(open(path, encoding="utf-8", newline="")))
    units, ids, data = rows[0], rows[1], rows[2:]
    idx = {ids[i]: i for i in range(1, len(ids))}
    unit = {ids[i]: units[i] for i in range(1, len(ids))}
    series = {k: [] for k in idx}
    times = []
    for r in data:
        if not r or not r[0].strip():
            continue
        times.append(float(r[0]))
        for k, i in idx.items():
            series[k].append(float(r[i]))
    return times, idx, unit, series


def main():
    run_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else (
        REPO / "artifacts" / "model-runs" / "fds-fire-entrance-20261118"
    )

    out = run_dir / f"{CASE}.out"
    devc = run_dir / f"{CASE}_devc.csv"
    hrr = run_dir / f"{CASE}_hrr.csv"
    for f in (out, devc, hrr):
        if not f.exists():
            raise SystemExit(f"missing: {f}")

    text = out.read_text(encoding="utf-8", errors="replace")
    ok = "STOP: FDS completed successfully" in text
    print(f"[solver] completed successfully : {ok}")
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("Revision") or s.startswith("Total Elapsed Wall Clock Time"):
            print(f"[solver] {s}")

    times, idx, unit, series = read_devc(devc)
    print(f"\n[devc] {len(times)} time stamps, t = {times[0]:.3f} .. {times[-1]:.3f} s")
    print(f"[devc] {len(idx)} channels")
    print(f"\n{'sample':16s} {'unit':5s} {'t=0':>9s} {'t=end':>9s} {'min':>9s} {'max':>9s}")
    print("-" * 60)
    for sid in VIS_IDS:
        v = series[sid]
        print(f"{sid:16s} {unit[sid]:5s} {v[0]:9.4f} {v[-1]:9.4f} {min(v):9.4f} {max(v):9.4f}")

    print("\n[hrr] steady-state total HRR (last 20 samples):")
    hrows = list(csv.reader(open(hrr, encoding="utf-8", newline="")))
    hi = hrows[1].index("HRR")
    tail = [float(r[hi]) for r in hrows[2:] if r and r[0].strip()][-20:]
    print(f"  mean = {sum(tail) / len(tail):.2f} kW, min = {min(tail):.2f}, max = {max(tail):.2f}")

    man = run_dir / "manifest.json"
    if man.exists():
        m = json.load(open(man, encoding="utf-8"))
        print(f"\n[manifest] status={m['status']} runId={m['runId']} wallClockS={m['wallClockS']}")
        print(f"[manifest] samples={[s['sampleId'] for s in m['samples']]}")


if __name__ == "__main__":
    main()
