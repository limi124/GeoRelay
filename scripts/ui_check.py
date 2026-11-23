"""GeoRelay UI regression against a running development server.

Run: .venv/bin/python scripts/ui_check.py
Requires playwright and a system Chrome installation. Uses an isolated browser
context, never the user's profile. Screenshots and the report go to artifacts/ui.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

BASE = os.environ.get("GEORELAY_BASE_URL", "http://127.0.0.1:5173")
ARTIFACTS = Path(__file__).resolve().parent.parent / "artifacts" / "ui"
RESULTS: list[str] = []


def passed(name: str) -> None:
    RESULTS.append(name)
    print(f"  ✓ {name}", flush=True)


def screenshot(page: Page, name: str) -> None:
    expect(page.locator(".scene-transition")).to_have_count(0, timeout=15000)
    page.wait_for_timeout(650)  # the map adapter's fit-bounds animation lasts 520 ms
    page.screenshot(path=str(ARTIFACTS / f"{name}.png"), full_page=True)


def model(page: Page) -> dict:
    return page.evaluate("JSON.parse(localStorage.getItem('georelay.community.v2'))")


def step(page: Page, name: str) -> None:
    heading = page.get_by_test_id(f"rail-step-{name}")
    if heading.get_attribute("aria-expanded") != "true":
        heading.click()


def dismiss_notice(page: Page) -> None:
    for button in page.locator(".workspace-feedback").get_by_role("button", name="关闭通知", exact=True).all():
        button.click()


def assert_no_horizontal_overflow(page: Page, label: str) -> None:
    dimensions = page.evaluate("({width:document.documentElement.clientWidth, scroll:document.documentElement.scrollWidth})")
    assert dimensions["scroll"] <= dimensions["width"] + 1, f"{label}: {dimensions}"
    passed(f"{label} 无页面横向溢出")


def workspace(page: Page, name: str) -> None:
    if page.viewport_size["width"] <= 900:
        button = page.get_by_test_id(f"mobile-workspace-{name}")
        expect(button).to_be_visible()
        button.click()
        expect(button).to_have_attribute("aria-pressed", "true")


def within_viewport(page: Page, locator, label: str) -> None:
    bounds = locator.bounding_box()
    viewport = page.viewport_size
    assert bounds and bounds["x"] >= 0 and bounds["y"] >= 0 and bounds["x"] + bounds["width"] <= viewport["width"] + 1 and bounds["y"] + bounds["height"] <= viewport["height"] + 1, f"{label} 需要滚动到其他页面区域: {bounds}"
    assert locator.evaluate("el => {const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!hit&&(hit===el||el.contains(hit))}"), f"{label} 被其他元素遮挡"


def assert_modal_focus(page: Page) -> None:
    drawer = page.get_by_test_id("console-drawer")
    expect(drawer).to_have_attribute("open", "")
    assert drawer.evaluate("el => el.matches(':modal') && el.contains(document.activeElement)"), "抽屉必须为模态且焦点进入其中"
    page.keyboard.press("Shift+Tab")
    # Chrome permits visiting browser chrome when cycling a native modal. That
    # is outside the document, not an escape into the inert application behind.
    if not page.evaluate("document.hasFocus()"):
        page.keyboard.press("Shift+Tab")
    assert drawer.evaluate("el => el.contains(document.activeElement)"), "反向Tab不能离开模态抽屉"
    page.keyboard.press("Tab")
    assert drawer.evaluate("el => el.contains(document.activeElement)"), "Tab不能离开模态抽屉"


def advance(page: Page, minutes: int = 5) -> None:
    clock = page.get_by_test_id("console-clock")
    parts = [int(v) for v in clock.inner_text().split(":")]
    target = parts[0] * 3600 + parts[1] * 60 + parts[2] + minutes * 60
    page.get_by_test_id(f"step-{minutes}min").click()
    expected = f"{target // 3600:02}:{target % 3600 // 60:02}:{target % 60:02}"
    expect(clock).to_have_text(expected, timeout=60000)
    expect(page.get_by_test_id(f"step-{minutes}min")).to_be_enabled(timeout=60000)


def run(page: Page) -> None:
    page.goto(BASE, wait_until="networkidle")
    page.locator(".map-host canvas").wait_for()
    expect(page.get_by_test_id("editor-rail")).to_be_visible()
    screenshot(page, "01-empty")
    passed("空白社区正常加载")

    # Native controls must be keyboard-operable and must not add fence vertices.
    cta = page.get_by_test_id("confirm-community")
    expect(cta).to_have_attribute("data-action", "draw-fence")
    cta.click()
    live_count = page.get_by_test_id("fence-live").locator("b").first
    expect(live_count).to_have_text("0")
    canvas = page.locator(".map-host canvas")
    page.get_by_role("button", name="地图放大", exact=True).press("Enter")
    page.get_by_role("button", name="地图缩小", exact=True).press("Space")
    page.get_by_role("button", name="地图复位", exact=True).click()
    expect(live_count).to_have_text("0")
    passed("地图控件支持键盘且不会误加围栏顶点")

    bounds = page.locator(".map-host").bounding_box()
    assert bounds
    cx, cy = bounds["x"] + bounds["width"] / 2, bounds["y"] + bounds["height"] / 2
    for dx, dy in [(-160, -100), (100, -100), (100, 50), (-30, 10), (-160, 60)]:
        page.mouse.click(cx + dx, cy + dy)
        page.wait_for_timeout(180)
    expect(live_count).to_have_text("5")
    expect(cta).to_have_attribute("data-action", "resume-fence")
    cta.click()
    expect(live_count).to_have_text("5")
    page.wait_for_function("document.querySelector('[data-testid=fence-toolbar]')?.contains(document.activeElement)", timeout=5000)
    page.get_by_role("button", name="完成围栏", exact=True).click()
    assert len(model(page)["fence"]["polygon"]) == 5
    page.get_by_test_id("fence-toolbar").get_by_role("button", name="退出", exact=True).click()
    expect(page.get_by_test_id("fence-toolbar")).to_have_count(0)
    passed("凹形围栏绘制和确认")
    expect(cta).to_have_attribute("data-action", "add-buildings")
    cta.click()
    expect(page.get_by_test_id("rail-step-buildings")).to_have_attribute("aria-expanded", "true")
    page.wait_for_function("document.querySelector('#editor-step-buildings')?.contains(document.activeElement)", timeout=5000)
    page.get_by_role("button", name="批量生成楼栋", exact=True).click()
    expect(cta).to_have_attribute("data-action", "review-network")
    cta.click()
    expect(page.get_by_test_id("rail-step-network")).to_have_attribute("aria-expanded", "true")
    expect(page.get_by_test_id("console-clock")).to_have_count(0)
    passed("建模主按钮按前置条件导航且保留围栏草稿")

    page.get_by_role("button", name="载入演示社区", exact=True).click()
    expect(page.get_by_test_id("rail-step-buildings")).to_contain_text("12")
    assert len(model(page)["buildings"]) == 12
    page.wait_for_timeout(650)  # finish the map's fit-bounds transition
    before = canvas.evaluate("el => el.toDataURL()")
    page.get_by_role("button", name="地图放大", exact=True).press("Enter")
    assert before != canvas.evaluate("el => el.toDataURL()"), "地图放大没有改变画布"
    page.get_by_role("button", name="地图缩小", exact=True).press("Space")
    dismiss_notice(page)
    screenshot(page, "02-demo")
    passed("载入演示社区保留十二栋楼和路网")

    # Verify edits belong to the selected building, including switching selection.
    step(page, "buildings")
    building_rows = page.locator(".editor-building-list button")
    first_id = model(page)["buildings"][0]["id"]
    second_floors = model(page)["buildings"][1]["floors"]
    building_rows.nth(0).click()
    selected = page.get_by_test_id("selected-building")
    unchanged = model(page)
    selected.get_by_role("spinbutton", name="层数", exact=True).fill("-1")
    selected.get_by_role("button", name="应用", exact=True).click()
    expect(page.locator(".workspace-feedback .notice.error")).to_be_visible()
    assert model(page) == unchanged, "非法楼栋输入不应改变社区"
    screenshot(page, "02-error")
    dismiss_notice(page)
    passed("楼栋输入错误可见且不破坏已有社区")
    selected.get_by_role("spinbutton", name="层数", exact=True).fill("16")
    selected.get_by_role("button", name="应用", exact=True).click()
    assert next(b for b in model(page)["buildings"] if b["id"] == first_id)["floors"] == 16
    building_rows.nth(1).click()
    expect(selected.get_by_role("spinbutton", name="层数", exact=True)).to_have_value(str(second_floors))
    page.reload(wait_until="networkidle")
    assert next(b for b in model(page)["buildings"] if b["id"] == first_id)["floors"] == 16
    passed("楼栋编辑、切换表单与刷新持久化")

    page.get_by_text("地图图层", exact=True).click()
    basemap = page.get_by_role("switch", name="背景楼块", exact=True)
    checked = basemap.get_attribute("aria-checked")
    basemap.click()
    expect(basemap).to_have_attribute("aria-checked", "false" if checked == "true" else "true")
    basemap.click()
    passed("折叠后的地图设置仍可操作")

    step(page, "network")
    page.get_by_role("button", name="确认路网", exact=True).click()
    assert all(r["status"] == "user" for r in model(page)["net"]["roads"])
    saved_model = model(page)
    expect(cta).to_have_attribute("data-action", "enter")
    page.get_by_test_id("confirm-community").click()
    expect(page.get_by_test_id("console-clock")).to_have_text("08:00:00")
    screenshot(page, "03-console")
    passed("确认路网并进入指挥台")
    expect(page.get_by_test_id("hud-relay")).to_have_count(0)
    expect(page.get_by_test_id("hud-legend")).not_to_be_visible()
    analysis_toggle = page.get_by_test_id("toggle-analysis")
    expect(analysis_toggle).to_have_attribute("aria-expanded", "false")
    analysis_toggle.click()
    expect(analysis_toggle).to_have_attribute("aria-expanded", "true")
    expect(page.get_by_test_id("hud-legend")).to_be_visible()
    analysis_toggle.click()
    expect(page.get_by_test_id("hud-legend")).not_to_be_visible()
    expect(page.get_by_test_id("open-candidates")).to_have_count(1)
    expect(page.get_by_test_id("open-judgement")).to_have_count(0)
    passed("准备态收起分析与确认栏，仅保留一个候选判据入口")

    page.once("dialog", lambda dialog: dialog.dismiss())
    page.get_by_test_id("disaster-fire").click()
    expect(page.get_by_test_id("disaster-flood")).to_have_attribute("aria-pressed", "true")
    for disaster in ["fire", "earthquake", "flood"]:
        tab = page.get_by_test_id(f"disaster-{disaster}")
        page.once("dialog", lambda dialog: dialog.accept())
        tab.click()
        expect(tab).to_have_attribute("aria-pressed", "true", timeout=30000)
        expect(page.get_by_test_id("step-1min")).to_be_enabled(timeout=30000)
    passed("灾种切换可取消，确认后内涝、火灾、地震可切换")

    maps = page.get_by_role("group", name="指挥地图底图")
    maps.get_by_role("button", name="地理示意图", exact=True).click()
    expect(maps.get_by_role("button", name="地理示意图", exact=True)).to_have_attribute("aria-pressed", "true")
    page.get_by_test_id("toggle-external").click()
    expect(page.get_by_test_id("toggle-external")).to_contain_text("返回")
    page.get_by_test_id("toggle-external").click()
    maps.get_by_role("button", name="白模沙盘", exact=True).click()
    for layer in ["物资", "撤离", "灾情", "态势"]:
        button = page.get_by_role("group", name="沙盘视图").get_by_role("button", name=layer, exact=True)
        button.click()
        expect(button).to_have_attribute("aria-pressed", "true")
    passed("地图、外部支援与四个沙盘图层可切换")

    objects = page.get_by_test_id("map-object-browser")
    objects.locator(":scope > summary").press("Enter")
    buildings = objects.locator(".map-object-list button")
    expect(buildings).to_have_count(12)
    buildings.nth(1).press("Enter")
    expect(buildings.nth(1)).to_have_attribute("aria-pressed", "true")
    selected_building_id = buildings.nth(1).get_attribute("data-testid")
    expect(page.get_by_test_id("map-building-detail")).to_contain_text("楼内")
    expect(page.get_by_test_id("map-building-detail")).to_contain_text("紧急度")
    maps.get_by_role("button", name="地理示意图", exact=True).click()
    expect(page.get_by_test_id(selected_building_id)).to_have_attribute("aria-pressed", "true")
    maps.get_by_role("button", name="白模沙盘", exact=True).click()
    expect(page.get_by_test_id(selected_building_id)).to_have_attribute("aria-pressed", "true")
    if objects.get_attribute("open") is None:
        objects.locator(":scope > summary").press("Enter")
    page.get_by_test_id("map-building-detail").get_by_role("button", name="取消定位", exact=True).press("Enter")
    expect(page.get_by_test_id("map-building-detail")).to_have_count(0)
    objects.locator(":scope > summary").click()
    passed("共享地图对象列表支持键盘定位、详情和跨底图保持选择")

    settings = page.get_by_test_id("rescue-settings")
    settings.locator("summary").click()
    settings.get_by_role("combobox", name="救援优先级").select_option("vulnerable")
    settings.get_by_role("combobox", name="消防组数").select_option("2")
    settings.locator("summary").click()
    passed("折叠后的救援策略和消防组数可修改")

    # Clock runs autonomously, can pause, and deterministic stepping still works.
    page.get_by_role("button", name="开始演练", exact=True).click()
    expect(page.get_by_test_id("console-clock")).not_to_have_text("08:00:00")
    screenshot(page, "03-running")
    page.get_by_role("button", name="暂停", exact=True).click()
    paused = page.get_by_test_id("console-clock").inner_text()
    page.wait_for_timeout(400)
    expect(page.get_by_test_id("console-clock")).to_have_text(paused)
    page.get_by_role("button", name="重置演练", exact=True).click()
    expect(page.get_by_test_id("console-clock")).to_have_text("08:00:00")
    advance(page, 1)
    passed("演练开始、暂停、重置与单步推进")

    # Trigger the deterministic flood event and choose an affected task.
    for _ in range(5):
        advance(page)
        if int(page.get_by_test_id("hud-task").get_attribute("data-plan-sets") or "0") > 0:
            break
    assert int(page.get_by_test_id("hud-task").get_attribute("data-impacts") or "0") > 0
    screenshot(page, "03-blocked")
    blocked_task = page.get_by_role("region", name="物资调度任务").get_by_role("button").filter(has_text="受阻").first
    blocked_task.click()
    page.get_by_test_id("open-candidates").click()
    drawer = page.get_by_test_id("console-drawer")
    assert_modal_focus(page)
    expect(drawer.locator(".candidate-card").first).to_be_visible(timeout=30000)
    assert drawer.locator(".check-item").count() > 0
    screenshot(page, "04-candidates")
    candidates = drawer.locator(".candidate-card")
    feasible = drawer.locator(".candidate-card:not(.is-infeasible)")
    assert feasible.count() >= 2, "固定内涝场景应有至少两个可行方案用于对比"
    for card in feasible.all()[:2]:
        card.get_by_role("button", name=re.compile("预览方案")).press("Enter")
        expect(card).to_have_class(re.compile("is-selected"))
        expect(card.get_by_role("button", name=re.compile("预览方案"))).to_have_attribute("aria-pressed", "true")
        candidate_id = card.get_attribute("data-candidate-id")
        assert candidate_id
        expect(page.get_by_test_id("hud-relay")).to_have_attribute("data-candidate-id", candidate_id)
        expect(page.get_by_test_id("confirm-viewed-candidate")).to_be_enabled()
    for card in drawer.locator(".candidate-card.is-infeasible").all():
        expect(card).to_contain_text("不可行")
        card.get_by_role("button", name=re.compile("预览方案")).press("Enter")
        expect(page.get_by_test_id("confirm-viewed-candidate")).to_have_count(0)
        expect(drawer).to_contain_text("未通过校验")
        expect(page.get_by_test_id("hud-relay")).to_have_count(0)
    selected = feasible.nth(1)
    selected.get_by_role("button", name=re.compile("预览方案")).press("Enter")
    candidate_id = selected.get_attribute("data-candidate-id")
    page.keyboard.press("Escape")
    expect(drawer).to_have_count(0)
    expect(page.get_by_test_id("open-candidates")).to_be_focused()
    expect(page.get_by_test_id("hud-relay")).to_have_attribute("data-candidate-id", candidate_id)
    screenshot(page, "04-pending")
    passed("候选预览绑定当前方案，模态抽屉键盘循环与Escape返回焦点")

    # Changing a narrow-screen workspace must not reset the selected task/plan.
    page.set_viewport_size({"width": 390, "height": 844})
    stable_clock = page.get_by_test_id("console-clock").inner_text()
    for pane in ["map", "tasks", "analysis", "map"]:
        workspace(page, pane)
        expect(page.get_by_test_id("console-clock")).to_have_text(stable_clock)
        expect(page.get_by_test_id("hud-relay")).to_have_attribute("data-candidate-id", candidate_id)
        within_viewport(page, page.get_by_test_id("open-candidates"), f"手机{pane}候选入口")
        within_viewport(page, page.get_by_test_id("confirm-reroute"), f"手机{pane}改派确认")
        dimensions = page.evaluate("({height:innerHeight,scroll:document.documentElement.scrollHeight})")
        assert dimensions["scroll"] <= dimensions["height"] + 1, f"手机{pane}仍需要长页面滚动: {dimensions}"
        screenshot(page, f"pending-mobile-{pane}")
    page.set_viewport_size({"width": 1440, "height": 900})
    page.locator(".relay-selection").click()
    assert_modal_focus(page)
    page.keyboard.press("Escape")
    expect(page.locator(".relay-selection")).to_be_focused()
    page.locator(".relay-selection").click()
    expect(drawer.locator(".candidate-card.is-selected")).to_have_attribute("data-candidate-id", candidate_id)
    page.get_by_test_id("confirm-viewed-candidate").click()
    expect(drawer).to_have_count(0)
    expect(page.get_by_test_id("hud-relay")).to_have_count(0)
    expect(page.get_by_test_id("open-candidates")).to_be_focused()
    page.get_by_test_id("open-candidates").click()
    expect(drawer.locator(".candidate-card.is-selected")).to_contain_text("已确认生效")
    feasible.first.get_by_role("button", name=re.compile("预览方案")).click()
    expect(drawer).to_contain_text("本轮已确认其他方案")
    expect(page.get_by_test_id("confirm-viewed-candidate")).to_have_count(0)
    expect(page.get_by_test_id("hud-relay")).to_have_count(0)
    screenshot(page, "04-confirmed-other")
    page.get_by_test_id("close-drawer").click()
    expect(page.get_by_test_id("open-candidates")).to_be_focused()
    screenshot(page, "04-confirmed")
    passed("手机三个工作区保持候选和时钟，统一确认后撤下操作栏")
    passed("底部触发器卸载后焦点回到全局入口，已确认后查看其他方案不可重复确认")
    passed("灾害触发候选、键盘预览、校验明细与确认改派")

    # Keep the original delivery regression: a confirmed drill must still
    # execute real plans. Read each task's phase, never the static count label.
    delivered = page.get_by_role("region", name="物资调度任务").locator('[data-phase="delivered"]')
    for _ in range(18):
        advance(page)
        if delivered.count():
            break
    expect(delivered.first).to_have_text("已送达")
    expect(delivered.first.locator("..").get_by_role("progressbar")).to_have_attribute("value", "1")
    screenshot(page, "04-delivered")
    passed("确认改派后继续执行，实际物资任务进入已送达阶段")

    # Reset while reading older real events, so the presentation state must
    # reset along with the engine instead of leaving a dead return-latest link.
    activity = page.get_by_role("list", name="调度事件列表")
    activity.focus()
    activity.press("PageDown")
    expect(page.get_by_role("button", name="返回最新", exact=True)).to_be_visible()
    assert activity.evaluate("el => el.scrollTop") > 0
    page.get_by_role("button", name="重置演练", exact=True).click()
    expect(page.get_by_test_id("console-clock")).to_have_text("08:00:00")
    expect(activity).to_have_count(0)
    expect(page.get_by_role("region", name="调度动态").get_by_text("暂无调度事件", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="返回最新", exact=True)).to_have_count(0)
    passed("阅读调度历史后重置，清空事件并恢复最新阅读状态")

    # Use real inventory controls to create a genuinely infeasible plan set.
    page.get_by_test_id("open-candidates").click()
    inventory = page.get_by_test_id("console-inventory")
    inventory.locator("summary").click()
    stock_inputs = inventory.get_by_role("spinbutton")
    assert stock_inputs.count() > 0
    for field in stock_inputs.all():
        field.fill("0")
        field.press("Tab")
        expect(field).to_have_value("0")
    page.get_by_test_id("close-drawer").click()
    advance(page)
    blocked_task.click()
    page.get_by_test_id("open-candidates").click()
    infeasible = drawer.locator(".candidate-card.is-infeasible")
    expect(infeasible.first).to_be_visible(timeout=60000)
    assert drawer.locator(".candidate-card:not(.is-infeasible)").count() == 0
    infeasible.first.get_by_role("button", name=re.compile("预览方案")).press("Enter")
    expect(page.get_by_test_id("confirm-viewed-candidate")).to_have_count(0)
    expect(drawer).to_contain_text("未通过校验")
    expect(page.get_by_test_id("hud-relay")).to_have_count(0)
    expect(infeasible.first).to_contain_text("不可行")
    screenshot(page, "04-infeasible")
    page.get_by_test_id("close-drawer").click()
    passed("库存不足的真实不可行候选无法确认且无底部动作条")

    page.get_by_test_id("open-evacuation").click()
    assert_modal_focus(page)
    evacuation = page.get_by_test_id("evacuation-panel")
    expect(evacuation.locator("input[type=checkbox]")).to_have_count(12)
    evacuation.locator("input[type=checkbox]").first.check()
    page.get_by_test_id("order-evacuation").click()
    expect(page.get_by_test_id("console-drawer")).to_have_count(0)
    page.get_by_test_id("open-evacuation").click()
    expect(page.get_by_test_id("evacuation-panel").locator("input[type=checkbox]").first).to_be_disabled()
    page.get_by_test_id("close-drawer").click()
    page.get_by_test_id("order-all-rescue").click()
    expect(page.get_by_test_id("order-all-rescue")).to_have_count(0)
    passed("指定楼栋撤离和全社区救援")

    for width, height in [(1024, 768), (390, 844)]:
        page.set_viewport_size({"width": width, "height": height})
        page.wait_for_timeout(150)
        workspace(page, "map")
        assert_no_horizontal_overflow(page, f"指挥台 {width}px")
        screenshot(page, f"console-{width}")
        workspace(page, "tasks")
        if width <= 900:
            within_viewport(page, page.get_by_test_id("open-evacuation"), "手机楼栋撤离入口")
        page.get_by_test_id("open-evacuation").click()
        expect(page.get_by_test_id("evacuation-panel")).to_be_visible()
        assert_no_horizontal_overflow(page, f"撤离抽屉 {width}px")
        page.get_by_test_id("close-drawer").click()
        expect(page.get_by_test_id("open-evacuation")).to_be_focused()

    page.get_by_test_id("back-to-edit").click()
    assert model(page) == saved_model, "演练不应改写已保存的社区"
    expect(page.get_by_test_id("confirm-community")).to_be_visible()
    assert_no_horizontal_overflow(page, "建模页 390px")
    screenshot(page, "editor-390")
    page.get_by_test_id("confirm-community").click()
    expect(page.get_by_test_id("console-clock")).to_be_visible()
    passed("窄屏编辑、返回与进入指挥台，社区模型不变")

    # Legacy valid communities did not require a staging point for admission.
    page.get_by_test_id("back-to-edit").click()
    legacy_model = model(page)
    legacy_model["net"]["staging"] = []
    page.evaluate("data => localStorage.setItem('georelay.community.v2', JSON.stringify(data))", legacy_model)
    page.reload(wait_until="networkidle")
    expect(page.get_by_test_id("confirm-community")).to_have_attribute("data-action", "enter")
    page.get_by_test_id("confirm-community").click()
    expect(page.get_by_test_id("console-clock")).to_be_visible()
    assert model(page)["net"]["staging"] == []
    passed("无接驳点的既有有效路网仍可进入演练")


def main() -> int:
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    failure = None
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome")
        page = browser.new_page(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
        page.set_default_timeout(15000)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(f"console.error: {message.text}") if message.type == "error" else None)
        try:
            run(page)
            assert not errors, "\n".join(errors)
            passed("无浏览器运行错误")
        except Exception as exc:
            failure = str(exc)
            screenshot(page, "failure")
            (ARTIFACTS / "failure-page.txt").write_text(page.locator("body").inner_text())
            print(f"  ✗ {failure}", flush=True)
        finally:
            (ARTIFACTS / "report.json").write_text(json.dumps({"passed": RESULTS, "failure": failure, "browser_errors": errors}, ensure_ascii=False, indent=2))
            page.close(run_before_unload=False)
            browser.close()
    print(f"{len(RESULTS)} checks passed. Report: {ARTIFACTS / 'report.json'}", flush=True)
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
