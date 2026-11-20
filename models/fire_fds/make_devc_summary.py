#!/usr/bin/env python3
"""Parse an FDS *_devc.csv into a GeoRelay-consumable series JSON.

Pure transport of numbers: no smoothing, no interpolation, no synthesis.
Missing values become null. Times are the exact time stamps FDS wrote.

FDS DEVC csv layout:
    row 0 : units
    row 1 : device IDs (col 0 is the time column label)
    row 2+ : data

Usage:
    python make_devc_summary.py <devc.csv> <out.json>
"""

import csv
import json
import sys


def parse_devc(path):
    with open(path, "r", encoding="utf-8", newline="") as fh:
        rows = list(csv.reader(fh))
    if len(rows) < 3:
        raise SystemExit(f"unexpected devc csv: only {len(rows)} rows in {path}")

    units = rows[0]
    ids = rows[1]
    data = rows[2:]

    columns = {}
    for i in range(1, len(ids)):
        columns[ids[i]] = {"unit": units[i].strip(), "col": i}

    times = []
    values = {cid: [] for cid in columns}
    col_order = {cid: [] for cid in columns}

    for r in data:
        if not r or r[0].strip() == "":
            continue
        try:
            t = float(r[0])
        except ValueError:
            continue
        times.append(t)
        for cid, meta in columns.items():
            raw = r[meta["col"]].strip() if meta["col"] < len(r) else ""
            if raw == "" or raw.lower() in ("nan", "na"):
                values[cid].append(None)
            else:
                values[cid].append(float(raw))

    return {"times": times, "columns": columns, "values": values}


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]

    parsed = parse_devc(src)
    times = parsed["times"]
    values = parsed["values"]
    columns = parsed["columns"]

    # The four visibility channels defined by the case (see models/fire_fds/README.md).
    visibility_ids = ["S1_ENTRANCE", "S2_CORRIDOR_A", "S3_CORRIDOR_B", "S4_EXIT"]

    samples = []
    for sid in visibility_ids:
        if sid not in columns:
            # Device absent -> report it explicitly rather than inventing data.
            samples.append({"sampleId": sid, "unit": "m", "series": []})
            continue
        series = [{"t": t, "value": v} for t, v in zip(times, values[sid])]
        samples.append(
            {"sampleId": sid, "unit": columns[sid]["unit"] or "m", "series": series}
        )

    # Sampling interval: nominal DT_DEVC = 5 s, actual spacing reported too.
    nominal_dt = 5
    dts = [round(times[i + 1] - times[i], 6) for i in range(len(times) - 1)]
    actual_dt = round(sum(dts) / len(dts), 6) if dts else None

    out = {
        "samples": samples,
        "tEnd": 300,
        "dtS": nominal_dt,
        "source": {
            "file": src.replace("\\", "/").split("/")[-1],
            "nTimeStamps": len(times),
            "tFirst": times[0] if times else None,
            "tLast": times[-1] if times else None,
            "dtSActualMean": actual_dt,
            "dtSRequested": nominal_dt,
            "note": "values copied verbatim from FDS DEVC output; no smoothing/interpolation",
        },
    }

    with open(dst, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    # Supplementary: every channel in the file, so temperature / extinction survive too.
    all_samples = []
    for cid, meta in columns.items():
        all_samples.append(
            {
                "sampleId": cid,
                "unit": meta["unit"],
                "series": [{"t": t, "value": v} for t, v in zip(times, values[cid])],
            }
        )
    all_out = {"samples": all_samples, "tEnd": 300, "dtS": nominal_dt}
    dst_all = dst.replace(".json", "-all-channels.json")
    with open(dst_all, "w", encoding="utf-8") as fh:
        json.dump(all_out, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print(f"wrote {dst} ({len(samples)} visibility samples, {len(times)} time stamps)")
    print(f"wrote {dst_all} ({len(all_samples)} channels)")


if __name__ == "__main__":
    main()
