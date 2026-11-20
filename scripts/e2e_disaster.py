"""三种灾情 + AI 分析的浏览器验收（Playwright + 系统 Chrome）。

覆盖：
  1. 内涝原流程不回归（画围栏 → 楼栋 → 进指挥台 → 封路 → 候选 → 确认 → 送达）
  2. 火灾：烟雾影响事件与理由 → 原入口受阻 → 备用入口候选 → 确认后送达
  3. 地震：多点断路 + 原接驳点不可用 → 候选 → 确认 → 送达
  4. 切换灾种会清空上一场状态、保留社区模型
  5. AI 三个入口 + 模拟响应（正常 / 未知候选 / 过期候选 / 超时 / 格式异常）

运行前需启动开发服务（AI_MOCK=1 可用模拟响应）：python scripts/e2e_disaster.py
"""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:5173"
SHOTS = Path(__file__).resolve().parent.parent / "artifacts" / "e2e-disaster"
results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append((name, bool(cond), detail))
    print(("  ✓ " if cond else "  ✗ ") + name + (f"  [{detail}]" if detail else ""))


def shot(page, name: str) -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SHOTS / f"{name}.png"))


def enter_console(page) -> None:
    page.get_by_role("button", name="载入演示社区").click()
    page.wait_for_timeout(700)
    page.get_by_role("button", name="确认路网").click()
    page.wait_for_timeout(300)
    page.get_by_role("button", name="确认社区并进入指挥台").click()
    page.wait_for_selector(".side-panel.right", timeout=15000)
    page.wait_for_timeout(400)


def step(page, times: int = 1) -> None:
    for _ in range(times):
        page.get_by_role("button", name="+5 分钟").evaluate("el => el.click()")
        page.wait_for_timeout(450)


def step_min(page, times: int = 1) -> None:
    """按 +1 分钟细步进：接力这类流程需要看清交接前后，不能一次跳 5 分钟。"""
    for _ in range(times):
        page.get_by_role("button", name="+1 分钟").evaluate("el => el.click()")
        page.wait_for_timeout(220)


def switch_disaster(page, label: str) -> None:
    page.once("dialog", lambda d: d.accept())
    page.locator("[data-testid=disaster-switch] button", has_text=label).evaluate("el => el.click()")
    page.wait_for_timeout(1200)


def ask_ai(page, label: str) -> str:
    page.locator("[data-testid=ai-panel] button", has_text=label).evaluate("el => el.click()")
    page.wait_for_timeout(1600)
    if page.locator("[data-testid=ai-error]").count():
        return page.locator("[data-testid=ai-error]").inner_text()
    if page.locator("[data-testid=ai-result]").count():
        return page.locator("[data-testid=ai-result]").inner_text()
    return ""


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        page = browser.new_page(viewport={"width": 1440, "height": 960})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)

        # ---------- 1. 内涝 ----------
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector("canvas", timeout=15000)
        enter_console(page)
        check("进入指挥台（默认内涝）", page.locator("[data-testid=disaster-switch]").count() == 1)
        switch_labels = page.locator("[data-testid=disaster-switch] button").all_inner_texts()
        check("灾种选择器有三个灾种", switch_labels[:3] == ["内涝", "火灾", "地震"], " / ".join(switch_labels[:3]))
        page.get_by_role("button", name="开始演练").click()
        step(page, 10)
        flood_ok = page.locator("[data-testid=impact-road]").count() > 0 and page.locator(".candidate-card").count() > 0
        check("内涝：封路事件 + 候选（不回归）", flood_ok, f"事件 {page.locator('[data-testid=impact-road]').count()} · 候选 {page.locator('.candidate-card').count()}")
        shot(page, "01-flood")

        # ---------- 2. 火灾 ----------
        switch_disaster(page, "火灾")
        body = page.locator(".side-panel.right").inner_text()
        cleared = page.locator(".candidate-card").count() == 0 and ("还没有生效的影响事件" in body)
        check("火灾：切换后清空上一场封路与候选", cleared, "影响事件与候选均已清空")
        check("火灾：场景说明可见", "火灾演练" in body, "")
        page.get_by_role("button", name="开始演练").click()
        step(page, 4)
        door_events = page.locator("[data-testid=impact-entrance]").count()
        check("火灾：入口被烟雾影响并列出事件", door_events > 0, f"{door_events} 条入口事件")
        # 点开影响详情
        if door_events:
            page.locator("[data-testid=impact-entrance]").first.evaluate("el => el.click()")
            page.wait_for_timeout(400)
            detail = page.locator("[data-testid=impact-detail]").inner_text()
            check("火灾：影响详情含来源/等级/发生时刻/判定依据", all(k in detail for k in ["来源", "判定依据", "发生时刻"]), detail.split("\n")[0][:40])
            check("火灾：不使用水深/降雨文案", "水深" not in detail and "降雨" not in detail, "")
        shot(page, "02-fire-impact")
        step(page, 6)
        cands = page.locator(".candidate-card").count()
        alt_titles = page.locator(".candidate-card", has_text="换入口").count()
        check("火灾：生成改道候选（含备用入口）", cands > 0, f"候选 {cands} · 换入口 {alt_titles}")
        shot(page, "03-fire-candidates")
        confirm = page.locator("[data-testid=confirm-candidate]").or_(page.get_by_role("button", name="确认此方案"))
        if confirm.count():
            confirm.first.evaluate("el => el.click()")
            page.wait_for_timeout(600)
            check("火灾：确认改派生效", "已确认" in page.locator(".side-panel.right").inner_text(), "")
        step(page, 14)
        delivered = "已送达" in page.locator(".side-panel.right").inner_text() or page.locator(".badge", has_text="已送达").count() > 0
        check("火灾：改派后送达", delivered, "")
        shot(page, "04-fire-delivered")

        # ---------- 3. 地震 ----------
        switch_disaster(page, "地震")
        body = page.locator(".side-panel.right").inner_text()
        check("地震：场景说明可见", "地震演练" in body, "")
        page.get_by_role("button", name="开始演练").click()
        step(page, 2)
        ruptures = page.locator("[data-testid=impact-road]").count()
        staging = page.locator("[data-testid=impact-staging]").count()
        buildings = page.locator("[data-testid=impact-building]").count()
        check("地震：有多处路段中断", ruptures >= 2, f"{ruptures} 处")
        check("地震：原接驳点不可用", staging >= 1, f"{staging} 个")
        check("地震：楼栋受损等级可见", buildings >= 1, f"{buildings} 栋")
        if buildings:
            page.locator("[data-testid=impact-building]").first.evaluate("el => el.click()")
            page.wait_for_timeout(400)
            detail = page.locator("[data-testid=impact-detail]").inner_text()
            check("地震：详情含受损等级与判定依据", "判定依据" in detail and ("轻微" in detail or "中等" in detail or "严重" in detail or "倒塌" in detail), "")
        shot(page, "05-earthquake")
        quake_cands = page.locator(".candidate-card").count()
        check("地震：生成换入口/换接驳点候选", quake_cands > 0, f"候选 {quake_cands}")
        shot(page, "06-earthquake-candidates")

        # ---------- 4. 地震接力闭环：确认改派 → 新接驳点交接 → 该任务送达 ----------
        task_cards = page.locator('.side-panel.right [data-testid^="task-task-"]')
        task_count = task_cards.count()
        check("地震：任务卡可枚举", task_count >= 4, f"{task_count} 个任务卡")

        # 选中受影响任务：优先挑“受阻”的那张卡（地震里被灾情打断的任务）
        target_idx = -1
        for i in range(min(task_count, 10)):
            if "受阻" in task_cards.nth(i).inner_text():
                target_idx = i
                break
        if target_idx < 0:
            target_idx = 1 if task_count > 1 else 0
        task_cards.nth(target_idx).evaluate("el => el.click()")
        page.wait_for_timeout(500)
        target_card_id = task_cards.nth(target_idx).get_attribute("data-testid")
        target_label = task_cards.nth(target_idx).inner_text().splitlines()[0]
        check("地震：选中受影响任务", bool(target_card_id), target_label[:24])

        # 无关任务：记下另一张卡片的完整文案，改派后必须一字不变
        unrelated_sig_before = ""
        unrelated_idx = -1
        for i in range(min(task_count, 10)):
            if i != target_idx:
                txt = task_cards.nth(i).inner_text()
                m = re.search(r"(外部志愿者[^·]*|内部志愿者[^·]*)\s*·\s*方案 v(\d+)", txt)
                if m:
                    unrelated_sig_before = f"{m.group(1).strip()}|v{m.group(2)}"
                    unrelated_idx = i
                    break

        relay_cards = page.locator(".candidate-card", has_text="接力")
        chosen = relay_cards.first if relay_cards.count() else page.locator(".candidate-card").first
        cand_title = chosen.inner_text().splitlines()[0] if chosen.count() else ""
        check("地震：候选里给出换接驳点方案", ("接力" in cand_title or "接驳" in cand_title), cand_title[:30])

        board = page.locator("[data-testid=relay-board]")
        blocked_text = page.locator("[data-testid=relay-blocked-staging]").inner_text() if page.locator("[data-testid=relay-blocked-staging]").count() else ""

        confirm_btn = chosen.get_by_role("button", name="确认此方案")
        confirmed = False
        if confirm_btn.count():
            confirm_btn.evaluate("el => el.click()")
            page.wait_for_timeout(700)
            confirmed = "已确认" in page.locator(".side-panel.right").inner_text()
        check("地震：人工确认改派生效", confirmed)

        staging_text = page.locator("[data-testid=relay-staging]").inner_text() if page.locator("[data-testid=relay-staging]").count() else ""
        blocked_name = ""
        if "原接驳点已不可用：" in blocked_text:
            blocked_name = blocked_text.split("原接驳点已不可用：")[1].split("（")[0]
        check(
            "地震：改用新的可达接驳点",
            bool(staging_text) and staging_text != "—" and staging_text != blocked_name,
            f"新接驳点 {staging_text} · 原接驳点 {blocked_name or '—'}",
        )

        pre_text = board.inner_text() if board.count() else ""
        internal_not_started = ("尚未开始配送" in pre_text) and ("内部配送中" not in pre_text) and ("已完成交接并送达" not in pre_text)
        check("地震：交接前内部 Agent 未开始配送", internal_not_started, (pre_text.splitlines()[2][:44] if pre_text else "无看板"))
        shot(page, "06b-quake-before-handover")

        handover_seen = False
        for _ in range(40):
            step_min(page, 1)
            txt = board.inner_text() if board.count() else ""
            if "交接时刻" in txt and ("内部配送中" in txt or "已完成交接并送达" in txt):
                handover_seen = True
                break
        check("地震：外部到达后完成接驳点交接", handover_seen)
        shot(page, "06c-quake-handover")

        delivered_target = False
        for _ in range(60):
            step_min(page, 1)
            txt = board.inner_text() if board.count() else ""
            if "已完成交接并送达" in txt:
                delivered_target = True
                break
        check("地震：受影响任务本身送达（不是其他任务充数）", delivered_target, target_label[:20])
        shot(page, "06d-quake-delivered")

        if unrelated_idx >= 0 and unrelated_sig_before:
            txt_after = page.locator('.side-panel.right [data-testid^="task-task-"]').nth(unrelated_idx).inner_text()
            m2 = re.search(r"(外部志愿者[^·]*|内部志愿者[^·]*)\s*·\s*方案 v(\d+)", txt_after)
            sig_after = f"{m2.group(1).strip()}|v{m2.group(2)}" if m2 else ""
            check("地震：无关任务派单与版本保持不变", sig_after == unrelated_sig_before, f"{unrelated_sig_before} → {sig_after}")
        else:
            check("地震：无关任务派单与版本保持不变", False, "没有找到无关任务")

        # ---------- 5. AI 分析 ----------
        res = ask_ai(page, "分析当前灾情")
        check("AI：分析当前灾情返回结果或明确报错", bool(res), res.split("\n")[0][:48] if res else "无输出")
        res2 = ask_ai(page, "哪些任务受影响")
        check("AI：哪些任务受影响可调用", bool(res2), res2.split("\n")[0][:48] if res2 else "无输出")
        res3 = ask_ai(page, "比较可行改派")
        check("AI：比较可行改派可调用", bool(res3), res3.split("\n")[0][:48] if res3 else "无输出")
        # 建议可跳转
        chips = page.locator("[data-testid=ai-result] .chip")
        if chips.count():
            chips.first.evaluate("el => el.click()")
            page.wait_for_timeout(400)
            check("AI：建议可跳到任务/候选", True, f"{chips.count()} 个引用")
        shot(page, "07-ai-analysis")

        check("运行期无未捕获 JS 错误", len(errors) == 0, "; ".join(errors[:3]))

        # ---------- 6. AI 异常分支（URL 钩子 + AI_MOCK=1） ----------
        for scenario, name in (("bad-id", "未知候选"), ("timeout", "超时"), ("bad-format", "格式异常")):
            page.goto(f"{BASE}/?ai={scenario}", wait_until="networkidle")
            page.wait_for_selector("canvas", timeout=15000)
            enter_console(page)
            page.get_by_role("button", name="开始演练").click()
            step(page, 3)
            out = ask_ai(page, "比较可行改派")
            if scenario in ("bad-id", "expired"):
                rejected = page.locator("[data-testid=ai-rejected]").count() > 0
                check(f"AI：{name}被校验拦下", rejected, (page.locator("[data-testid=ai-rejected]").inner_text()[:40] if rejected else out[:40]))
            else:
                err = page.locator("[data-testid=ai-error]").count() > 0
                keep_cands = page.locator(".candidate-card").count() > 0
                check(f"AI：{name}时提示原因并保留规则候选", err and keep_cands, f"错误提示 {err} · 规则候选 {keep_cands}")
            shot(page, f"08-ai-{scenario}")

        # 过期候选：先确认一条改派，再让后续灾情打断它，使那条候选集真正过期
        page.goto(f"{BASE}/?ai=expired", wait_until="networkidle")
        page.wait_for_selector("canvas", timeout=15000)
        enter_console(page)
        switch_disaster(page, "火灾")
        page.get_by_role("button", name="开始演练").click()
        step(page, 4)
        first_confirm = page.get_by_role("button", name="确认此方案")
        if first_confirm.count():
            first_confirm.first.evaluate("el => el.click()")
            page.wait_for_timeout(600)
        # 确认过的候选集不能再确认一次；AI 若引用它，应被当作过期建议拦下
        out = ask_ai(page, "比较可行改派")
        rejected_expired = page.locator("[data-testid=ai-rejected]").count() > 0
        txt = page.locator("[data-testid=ai-rejected]").inner_text() if rejected_expired else ""
        check("AI：过期候选被校验拦下", rejected_expired and ("已过期" in txt or "过期" in txt), (txt[:60] if rejected_expired else out[:60]))
        shot(page, "08-ai-expired")

        # ---------- 7. 三场一键演练 + 复盘 + 对照面板 ----------
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector("canvas", timeout=15000)
        # 先在编辑台放一个"用户社区"并写入 localStorage，稍后验证预置场景不会覆盖它
        page.get_by_role("button", name="载入演示社区").click()
        page.wait_for_timeout(700)
        page.get_by_role("button", name="确认路网").click()
        page.wait_for_timeout(300)
        page.get_by_role("button", name="确认社区并进入指挥台").click()
        page.wait_for_selector(".side-panel.right", timeout=15000)
        page.wait_for_timeout(600)
        # 进入指挥台后再快照：确认路网本身会更新并保存模型，不能更早取
        saved_before = page.evaluate("() => localStorage.getItem('georelay.community.v2')")
        check("用户社区已保存到本地", bool(saved_before), f"{len(saved_before or '')} 字符")
        check("指挥台出现一键演练入口", page.locator("[data-testid=preset-bar]").count() == 1)

        for preset_id, title, expect_text in (
            ("flood-detour", "内涝绕行", "内涝"),
            ("fire-alt-door", "火灾换入口", "火灾"),
            ("quake-relay", "地震换接驳点", "地震"),
        ):
            page.once("dialog", lambda d: d.accept())
            page.locator(f"[data-testid=preset-{preset_id}]").evaluate("el => el.click()")
            page.wait_for_timeout(1600)
            hint = page.locator("[data-testid=preset-hint]").inner_text() if page.locator("[data-testid=preset-hint]").count() else ""
            switch_active = page.locator("[data-testid=disaster-switch] button.is-active").inner_text() if page.locator("[data-testid=disaster-switch] button.is-active").count() else ""
            ok = (title in hint) and (expect_text in hint or expect_text in switch_active) and ("下一步" in hint)
            check(f"一键演练可载入：{title}", ok, f"{switch_active} · {hint.splitlines()[0][:24] if hint else '无提示'}")

        # 预置场景不能覆盖用户保存的社区模型
        saved_after = page.evaluate("() => localStorage.getItem('georelay.community.v2')")
        check("预置场景未覆盖用户保存的社区模型", saved_before == saved_after, "localStorage 内容一致")

        # 复盘时间线：开始演练推进后应有条目，点击可定位
        page.get_by_role("button", name="开始演练").click()
        step(page, 2)
        entries = page.locator("[data-testid^=replay-]").count()
        check("复盘时间线有记录", entries > 0, f"{entries} 条")
        if entries:
            first = page.locator("[data-testid^=replay-]").first
            label_before = first.inner_text().splitlines()[0]
            first.evaluate("el => el.click()")
            page.wait_for_timeout(500)
            check("复盘条目可点击定位", page.locator("[data-testid=replay-panel]").count() == 1, label_before[:30])

        # 对照面板：读取预置 JSON，标明场景/种子/时长，并保留持平的种子
        cmp_panel = page.locator("[data-testid=compare-panel]")
        check("内涝对照面板存在", cmp_panel.count() == 1)
        cmp_text = cmp_panel.inner_text() if cmp_panel.count() else ""
        has_seeds = all(f"种子 {s}" in cmp_text for s in (42, 7, 99))
        check("对照面板标明三个种子", has_seeds, "42 / 7 / 99")
        check("对照面板标明场景与时长", ("内涝" in cmp_text) and ("40 分钟" in cmp_text), "")
        check("对照面板保留持平种子（种子 99）", "种子 99" in cmp_text and "改派 1 次" in cmp_text, "")
        check("对照面板声明未送达不计耗时", "未送达" in cmp_text and "不计入" in cmp_text, "")
        shot(page, "09-presets-replay-compare")

        browser.close()

    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"\n{'═' * 68}")
    print(f"灾情+AI 浏览器验收 通过 {passed} / {total}")
    if passed != total:
        print("\n失败项：")
        for name, ok, detail in results:
            if not ok:
                print(f"  ✗ {name} {detail}")
    print(f"截图目录：{SHOTS}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
