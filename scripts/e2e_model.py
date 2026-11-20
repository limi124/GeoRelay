"""专业模型算例（FDS / OpenQuake）的浏览器验收（Playwright + 系统 Chrome）。

覆盖链路：
  求解器输出 → Web 展示（来源徽标 / 两层证据）→ 受阻事件进既有流程
  → 规则候选 → 人工确认 → Agent 送达
并单独验证：
  · 来源标签随「模型回放 ↔ 简化演示」切换同步变化；
  · 地图/界面上的数值能追溯到模型产物（runId / engineVersion / sampleId / 资产 / 阈值）。

数据来源：`src/data/model-runs/index.json` 与 `<runId>.json`（由 npm run model:ingest 生成）。
没有可用算例时脚本以退出码 2 结束（未就绪，不算失败）。

运行前需启动开发服务：python scripts/e2e_model.py
退出码：全过 0 / 有失败 1 / 无可用算例 2
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:5173"
SHOTS = ROOT / "artifacts" / "e2e-model"
DATA_DIR = ROOT / "src" / "data" / "model-runs"
INDEX_PATH = DATA_DIR / "index.json"

results: list[tuple[str, bool, str]] = []
limitations: list[str] = []

DISASTER_LABEL = {"fire": "火灾", "earthquake": "地震"}
MODEL_LABEL = {"fds": "FDS", "openquake": "OpenQuake"}


# ---------------------------------------------------------------------------
# 断言 / 截图 / 小工具
# ---------------------------------------------------------------------------


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append((name, bool(cond), detail))
    print(("  ✓ " if cond else "  ✗ ") + name + (f"  [{detail}]" if detail else ""))


def note(text: str) -> None:
    limitations.append(text)
    print(f"  · 记录：{text}")


def shot(page, name: str) -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SHOTS / f"{name}.png"))


def panel_text(page) -> str:
    loc = page.locator(".side-panel.right")
    return loc.inner_text() if loc.count() else ""


def safe_text(page, selector: str) -> str:
    loc = page.locator(selector)
    if not loc.count():
        return ""
    try:
        return loc.first.inner_text()
    except Exception:
        return ""


def click_tid(page, tid: str) -> None:
    page.locator(f"[data-testid={tid}]").first.evaluate("el => el.click()")


def numbers_in(text: str) -> list[float]:
    out: list[float] = []
    for m in re.findall(r"-?\d+(?:\.\d+)?", text):
        try:
            out.append(float(m))
        except ValueError:
            pass
    return out


def closest_gap(text: str, value: float) -> float:
    nums = numbers_in(text)
    if not nums:
        return float("inf")
    return min(abs(n - value) for n in nums)


def value_text(value: float) -> str:
    """与 ModelEvidencePanel.valueText 一致：<1 保留 3 位，否则 2 位。"""
    return f"{value:.3f}" if abs(value) < 1 else f"{value:.2f}"


def wait_badge(page, level: str, case_id: str | None = None, timeout: int = 25000) -> bool:
    """等来源徽标切到目标层级（必要时还要等徽标文案里出现该算例 caseId）。"""
    expr = """
      ([sel, attr, val, needle]) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        if (el.getAttribute(attr) !== val) return false;
        return needle ? (el.textContent || '').includes(needle) : true;
      }
    """
    try:
        page.wait_for_function(
            expr,
            arg=["[data-testid=provenance-badge]", "data-provenance", level, case_id],
            timeout=timeout,
        )
        return True
    except Exception:
        return False


def enter_console(page) -> None:
    """最短路径进入指挥台：载入演示社区 → 确认路网 → 确认社区并进入指挥台。"""
    page.get_by_role("button", name="载入演示社区").click()
    page.wait_for_timeout(700)
    page.get_by_role("button", name="确认路网").click()
    page.wait_for_timeout(300)
    page.get_by_role("button", name="确认社区并进入指挥台").click()
    page.wait_for_selector(".side-panel.right", timeout=20000)
    page.wait_for_timeout(500)


def step_min(page, times: int = 1) -> None:
    for _ in range(times):
        page.get_by_role("button", name="+1 分钟").evaluate("el => el.click()")
        page.wait_for_timeout(220)


def start_drill(page) -> None:
    sidebar = page.locator(".side-panel.right")
    # 「开始演练」只在顶栏；开始后顶栏与侧栏都会出现同名「暂停」，暂停时只点侧栏那个
    page.get_by_role("button", name="开始演练").first.evaluate("el => el.click()")
    page.wait_for_timeout(350)
    # 暂停自动时钟，后续用 +1 分钟确定性步进（开始演练已经发生）
    pause = sidebar.get_by_role("button", name="暂停")
    if pause.count():
        pause.first.evaluate("el => el.click()")
        page.wait_for_timeout(150)


def impact_count(page, target_type: str) -> int:
    return page.locator(f".side-panel.right [data-testid=impact-{target_type}]").count()


def task_cards(page):
    return page.locator('.side-panel.right [data-testid^="task-"]')


def task_card_text(page, testid: str) -> str:
    return safe_text(page, f".side-panel.right [data-testid={testid}]")


# ---------------------------------------------------------------------------
# 算例数据：直接读 Python 文件（不经浏览器），用于数值追溯
# ---------------------------------------------------------------------------


def load_index() -> list[dict]:
    if not INDEX_PATH.exists():
        return []
    data = json.loads(INDEX_PATH.read_text(encoding="utf-8-sig"))
    return list(data.get("runs") or [])


def load_bundle(run_id: str) -> dict | None:
    path = DATA_DIR / f"{run_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8-sig"))


def available_runs(runs: list[dict]) -> list[dict]:
    return [r for r in runs if r.get("status") == "ok" and r.get("available") and (DATA_DIR / f"{r['runId']}.json").exists()]


# ---------------------------------------------------------------------------
# 单项验证
# ---------------------------------------------------------------------------


def check_entry_panel(page, runs: list[dict]) -> None:
    print("【1】算例入口与来源徽标")
    check("专业模型算例面板存在", page.locator("[data-testid=model-runs-panel]").count() == 1)
    check(
        "按灾种分组（FDS / OpenQuake）",
        page.locator("[data-testid=model-run-group-fds]").count() == 1
        and page.locator("[data-testid=model-run-group-openquake]").count() == 1,
    )
    listed = []
    missing = []
    for run in runs:
        loc = page.locator(f"[data-testid=model-run-{run['runId']}]")
        if loc.count():
            listed.append(run["runId"])
            status = loc.first.get_attribute("data-run-status")
            if status != "ok":
                missing.append(f"{run['runId']} status={status}")
        else:
            missing.append(f"{run['runId']} 无按钮")
    check("每个 available 算例都有入口按钮", len(listed) == len(runs) and not missing, " / ".join(listed) if not missing else "; ".join(missing))
    check("算例按钮标注 data-run-status=ok", not missing, "; ".join(missing))


def start_model_run(page, run: dict) -> bool:
    tid = f"model-run-{run['runId']}"
    loc = page.locator(f"[data-testid={tid}]")
    if not loc.count():
        check(f"{DISASTER_LABEL.get(run['disaster'], run['disaster'])}：算例入口可点击", False, "找不到算例按钮")
        return False
    loc.first.evaluate("el => el.click()")
    ok = wait_badge(page, "model", run["caseId"])
    badge = safe_text(page, "[data-testid=provenance-badge]")
    active = safe_text(page, "[data-testid=disaster-switch] button.is-active")
    check(
        f"{DISASTER_LABEL.get(run['disaster'], run['disaster'])}：载入算例后徽标为模型计算结果回放",
        ok and ("模型计算结果回放" in badge) and active == DISASTER_LABEL.get(run["disaster"], run["disaster"]),
        f"{active} · {badge[:60]}",
    )
    check(
        "徽标 data-provenance=model",
        page.locator("[data-testid=provenance-badge]").first.get_attribute("data-provenance") == "model",
    )
    check("模型回放时提供「查看两层证据」入口", page.locator("[data-testid=jump-to-evidence]").count() == 1)
    check("两层证据面板出现", page.locator("[data-testid=model-evidence]").count() == 1)
    return ok


def check_traceability(page, run: dict, bundle: dict) -> dict:
    """数值可追溯：第一条带 evidence 的事件 ← 求解器输出文件。"""
    print("【2】数值可追溯（模型产物 → 界面）")
    evidenced = [e for e in bundle.get("events", []) if e.get("evidence")]
    if not evidenced:
        check("算例含带证据的模型事件", False, "events 里没有 evidence")
        return {}
    ev = evidenced[0]
    evd = ev["evidence"]
    scope = safe_text(page, "[data-testid=model-provenance-scope]")
    badge = safe_text(page, "[data-testid=provenance-badge]")
    check("证据面板标出 runId", bool(scope) and evd["runId"] in scope, evd["runId"])
    check(
        "证据面板标出 engineVersion",
        evd["engineVersion"] in scope or evd["engineVersion"] in badge,
        evd["engineVersion"],
    )
    check("证据面板标出 caseId", bundle["provenance"]["caseId"] in (scope + badge), bundle["provenance"]["caseId"])

    row = safe_text(page, "[data-testid=model-evidence-row-0]")
    check("模型层列出第一条证据事件", bool(row) and ev["targetName"] in row, ev["targetName"])
    check("证据行自带到 runId（可回到算例）", evd["runId"] in row, "")

    value = evd.get("value")
    fmt = value_text(value) if isinstance(value, (int, float)) else ""
    gap = closest_gap(row, float(value)) if isinstance(value, (int, float)) else float("inf")
    check(
        f"界面数值与算例一致（{evd.get('metric')}={fmt} {evd.get('unit')}，容差 0.05）",
        bool(fmt) and (fmt in row or gap <= 0.05),
        f"文件值 {value} · 界面最近值差 {gap:.4f}" if isinstance(value, (int, float)) else "无 value",
    )

    if evd.get("sampleId"):
        sample_id = evd["sampleId"]
        chips = page.locator(f"[data-testid=evidence-sample-{sample_id}]")
        in_layer = sample_id in safe_text(page, "[data-testid=model-layer]")
        check(f"采样点 {sample_id} 可在证据面板定位", chips.count() > 0 or in_layer, f"chip={chips.count()}")
        if chips.count():
            chips.first.evaluate("el => el.click()")
            page.wait_for_timeout(300)
            hint = safe_text(page, "[data-testid=model-layer]")
            check("采样点时程图带 sampleId 与单位", sample_id in hint and evd["unit"] in hint, "")
        check("阈值参考线可见（模型值 vs 判据阈值）", page.locator("[data-testid=evidence-threshold-line]").count() >= 1)
        check("首次越阈点标在时程图上", page.locator("[data-testid=evidence-crossing]").count() >= 1)
    if evd.get("assetId"):
        asset_id = evd["assetId"]
        asset = next((a for a in bundle.get("assets", []) if a.get("assetId") == asset_id), None)
        layer = safe_text(page, "[data-testid=model-layer]")
        check(f"资产 {asset_id} 可在模型层定位", asset_id in layer, "")
        if asset:
            pct = f"{asset['probs'][0] * 100:.1f}%"
            gap_pct = closest_gap(row, asset["probs"][0] * 100)
            check(
                "资产受损状态分布与 oQ 输出一致（百分比，容差 0.1）",
                pct in row or gap_pct <= 0.1,
                f"{asset_id} {pct} · 差 {gap_pct:.3f}",
            )
    if bundle.get("closures"):
        check("地震独立关闭单独成块（model-closures）", page.locator("[data-testid=model-closures]").count() == 1)
        check(
            "独立关闭条目数与算例一致",
            page.locator("[data-testid^=model-closure-row-]").count() == len(bundle["closures"]),
            f"{page.locator('[data-testid^=model-closure-row-]').count()} / {len(bundle['closures'])}",
        )
    return evd


def check_layers(page, evd: dict) -> None:
    """模型层与判据层分开显示。"""
    print("【3】模型层与判据层分开")
    model_layer = safe_text(page, "[data-testid=model-layer]")
    rule_layer = safe_text(page, "[data-testid=rule-layer]")
    check("模型层存在", page.locator("[data-testid=model-layer]").count() == 1)
    check("判据层存在", page.locator("[data-testid=rule-layer]").count() == 1)
    if not evd:
        check("判据层标出规则 ID 与阈值", False, "没有证据事件")
        return
    rule_id = evd.get("ruleId", "")
    threshold = evd.get("threshold")
    check(
        f"判据层标出规则 {rule_id}",
        bool(rule_id) and rule_id in rule_layer,
        rule_id,
    )
    check(
        f"判据层标出阈值 {threshold} {evd.get('unit', '')}",
        str(threshold) in rule_layer,
        "",
    )
    check("页面同时出现「模型」与「演练规则/判据」两类词", "模型" in model_layer and ("演练规则" in rule_layer or "判据" in rule_layer))
    check("模型层声明求解器输出、非判定", "求解器输出" in model_layer, "")
    check("判据层声明演练判据、非模型结论", "非模型结论" in rule_layer, "")


def check_events_into_flow(page, run: dict, bundle: dict) -> bool:
    """受阻事件进入既有流程：开始演练 → 步进 → 影响事件 → 候选。"""
    print("【4】受阻事件进入既有流程（开始演练 → +1 分钟 → 影响 → 候选）")
    start_drill(page)
    required = ["entrance", "road"] if run["disaster"] == "fire" else ["building"]
    found = {}
    for _ in range(60):
        found = {t: impact_count(page, t) for t in required}
        if any(v > 0 for v in found.values()):
            break
        step_min(page, 1)
    check(
        "步进后出现模型影响的" + "/".join(required) + "事件",
        any(v > 0 for v in found.values()),
        " · ".join(f"{k}={v}" for k, v in found.items()),
    )
    shot(page, f"04-{run['disaster']}-impacts")

    # 影响详情可回溯到算例与判据
    detail = ""
    for t in required:
        loc = page.locator(f".side-panel.right [data-testid=impact-{t}]")
        if loc.count():
            loc.first.evaluate("el => el.click()")
            page.wait_for_timeout(400)
            detail = safe_text(page, "[data-testid=impact-detail]")
            if detail:
                break
    case_id = run["caseId"]
    model_name = MODEL_LABEL.get(run["model"], run["model"])
    check(
        "影响详情可追溯到算例来源",
        case_id in detail and model_name in detail and "判定依据" in detail,
        f"{model_name} {case_id}",
    )

    cands = 0
    for _ in range(60):
        cands = page.locator(".side-panel.right .candidate-card").count()
        if cands:
            break
        step_min(page, 1)
    body = panel_text(page)
    no_feasible = ("无可行" in body) or ("还没有可行候选" in body) or ("没有可行候选" in body)
    if cands:
        check("受阻后生成规则候选（.candidate-card）", True, f"候选 {cands} 个")
    else:
        check("受阻后生成规则候选（.candidate-card）", no_feasible, "无可行候选提示（已记录）")
        if no_feasible:
            note(f"{DISASTER_LABEL.get(run['disaster'])}：本场景无可行候选，按「无可行」提示记通过")
    shot(page, f"05-{run['disaster']}-candidates")
    return cands > 0


def check_confirm_and_delivery(page, run: dict) -> None:
    """人工确认 + Agent 送达。"""
    print("【5】人工确认 + Agent 送达")
    cards = task_cards(page)
    blocked: list[str] = []
    for i in range(cards.count()):
        card = cards.nth(i)
        tid = card.get_attribute("data-testid") or ""
        txt = card.inner_text()
        if "受阻" in txt:
            blocked.append(tid)
    check("存在受影响（受阻）任务卡", bool(blocked), ", ".join(blocked[:4]))
    if not blocked:
        return

    cand_cards = page.locator(".side-panel.right .candidate-card")
    confirmed = False
    for i in range(cand_cards.count()):
        btn = cand_cards.nth(i).get_by_role("button", name="确认此方案")
        if btn.count() and btn.first.is_enabled():
            btn.first.evaluate("el => el.click()")
            page.wait_for_timeout(800)
            confirmed = True
            break
    check("确认一条可行候选（人工确认，非自动生效）", confirmed, f"候选 {cand_cards.count()} 个")
    if not confirmed:
        return
    check("确认后提示已确认生效", "已确认" in panel_text(page), "")

    target = blocked[0]
    delivered = False
    delivering = False
    for _ in range(120):
        txt = task_card_text(page, target)
        if "已送达" in txt:
            delivered = True
            break
        if "配送中" in txt:
            delivering = True
        step_min(page, 1)
    if delivered:
        check("受影响任务卡出现「已送达」", True, target)
    elif delivering and run["disaster"] == "earthquake":
        check("受影响任务至少进入「配送中」（受演练时长限制未送达）", True, f"{target} 配送中")
        note("地震：受演练时长限制未送达，已进入配送中（按限制记录）")
    else:
        check("受影响任务卡出现「已送达」", False, f"{target} 最后状态：{task_card_text(page, target)[:80]}")
    shot(page, f"06-{run['disaster']}-delivered")


def check_provenance_switch(page, run: dict) -> None:
    """来源标签随模式切换同步变化。"""
    print("【6】来源标签随模式切换同步变化")
    label = DISASTER_LABEL.get(run["disaster"], run["disaster"])
    page.locator("[data-testid=provenance-to-simplified]").first.evaluate("el => el.click()")
    ok = wait_badge(page, "simplified")
    badge = safe_text(page, "[data-testid=provenance-badge]")
    check(
        f"{label}：切到简化演示后徽标变化",
        ok and ("简化演示" in badge) and (page.locator("[data-testid=model-evidence]").count() == 0),
        f"证据面板 {page.locator('[data-testid=model-evidence]').count()} · {badge[:40]}",
    )
    check("简化演示时 data-provenance=simplified", page.locator("[data-testid=provenance-badge]").first.get_attribute("data-provenance") == "simplified")
    shot(page, f"07-{run['disaster']}-simplified")

    to_model = page.locator("[data-testid=provenance-to-model]")
    if to_model.count() and to_model.first.is_enabled():
        to_model.first.evaluate("el => el.click()")
        back = wait_badge(page, "model", run["caseId"])
        badge2 = safe_text(page, "[data-testid=provenance-badge]")
        check(
            "切回模型回放后徽标与证据面板同步回来",
            back and ("模型计算结果回放" in badge2) and page.locator("[data-testid=model-evidence]").count() == 1,
            badge2[:50],
        )
    else:
        check("切回模型回放按钮可用", to_model.count() > 0 and to_model.first.is_enabled(), "按钮不可用")
    shot(page, f"08-{run['disaster']}-back-to-model")


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def main() -> int:
    runs = load_index()
    usable = available_runs(runs)
    if not usable:
        print("无可用模型算例：src/data/model-runs/index.json 里没有 status=ok 且 available 的算例。")
        print("模型算例还没有归档（求解器可能仍在运行），本次不判定为失败。")
        print("\n模型算例浏览器验收 通过 0 / 0（未就绪，退出码 2）")
        return 2

    print(f"发现 {len(usable)} 个可用模型算例：" + " / ".join(f"{r['runId']}（{DISASTER_LABEL.get(r['disaster'], r['disaster'])}）" for r in usable))

    bundles = {}
    for run in usable:
        bundle = load_bundle(run["runId"])
        if bundle is None:
            check(f"读取回放包 {run['runId']}.json", False, "文件缺失")
            continue
        bundles[run["runId"]] = bundle
    usable = [r for r in usable if r["runId"] in bundles]
    if not usable:
        print("\n模型算例浏览器验收 通过 0 / 0（回放包全部缺失，退出码 2）")
        return 2

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        page = browser.new_page(viewport={"width": 1440, "height": 960})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)

        try:
            page.goto(BASE, wait_until="networkidle")
            page.wait_for_selector("canvas", timeout=20000)
            enter_console(page)
            check("进入指挥台（可访问算例入口）", page.locator("[data-testid=provenance-panel]").count() == 1)

            check_entry_panel(page, [r for r in usable])

            for run in usable:
                label = DISASTER_LABEL.get(run["disaster"], run["disaster"])
                print(f"\n──── {label}算例：{run['runId']} ────")
                bundle = bundles[run["runId"]]
                try:
                    if not start_model_run(page, run):
                        continue
                    shot(page, f"01-{run['disaster']}-badge")
                    evd = check_traceability(page, run, bundle)
                    shot(page, f"02-{run['disaster']}-evidence")
                    check_layers(page, evd)
                    check_events_into_flow(page, run, bundle)
                    check_confirm_and_delivery(page, run)
                    check_provenance_switch(page, run)
                except Exception as exc:  # 单算例异常不影响其余断言与汇总
                    check(f"{label}：算例检查未中断", False, f"{type(exc).__name__}: {exc}")
                    shot(page, f"99-{run['disaster']}-error")

            check("运行期无未捕获 JS 错误", len(errors) == 0, "; ".join(errors[:3]))
        except Exception as exc:
            check("浏览器验收流程执行完成", False, f"{type(exc).__name__}: {exc}")
            shot(page, "99-fatal")
        finally:
            browser.close()

    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"\n{'═' * 68}")
    print(f"模型算例浏览器验收 通过 {passed} / {total}")
    if limitations:
        print("\n限制与记录：")
        for item in limitations:
            print(f"  · {item}")
    if passed != total:
        print("\n失败项：")
        for name, ok, detail in results:
            if not ok:
                print(f"  ✗ {name} {detail}")
    print(f"截图目录：{SHOTS}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
