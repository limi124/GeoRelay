"""Check dispatch motion against real UI actions and the simulation clock.

Run in the existing Python venv with the dev server running. No simulation
state is injected; only model/demo controls and the clock advance the drill.
"""
from __future__ import annotations

import json
import os
import re
import traceback
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright
from ui_check import advance, dismiss_notice, within_viewport, workspace

BASE = os.environ.get("GEORELAY_BASE_URL", "http://127.0.0.1:5173")
OUT = Path(__file__).resolve().parent.parent / "artifacts" / "motion"
RESULTS: list[str] = []


def passed(message: str) -> None:
    RESULTS.append(message)
    print(f"  ✓ {message}", flush=True)


def positions(page: Page) -> dict[str, str]:
    return page.locator("[data-actor-id]").evaluate_all(
        "els => Object.fromEntries(els.map(el => [el.dataset.actorId, el.dataset.position]))"
    )


def offsets(page: Page) -> list[str]:
    return page.locator(".sandbox-route-flow").evaluate_all(
        "els => els.map(el => getComputedStyle(el).strokeDashoffset)"
    )


def pause(page: Page) -> None:
    button = page.get_by_role("button", name="暂停", exact=True)
    if button.count():
        button.click()
    page.wait_for_timeout(100)


def start(page: Page) -> None:
    page.get_by_role("button", name=re.compile("^(开始演练|继续)$")).click()


def snapshot(page: Page, name: str) -> None:
    expect(page.locator(".scene-transition")).to_have_count(0, timeout=15000)
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=True)


def labels_clear_actors(page: Page) -> None:
    intersections = page.evaluate("""() => {
      const actors = [...document.querySelectorAll('[data-actor-id] > polygon')];
      const labels = [...document.querySelectorAll('[data-testid=sandbox-labels] rect')];
      const collisions = [];
      for (const actor of actors) {
        const a = actor.getBoundingClientRect();
        for (const label of labels) {
          const b = label.getBoundingClientRect();
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > .5 &&
              Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .5) {
            collisions.push({actor:actor.parentElement.dataset.actorId, label:label.parentElement.textContent});
          }
        }
      }
      return {actors: actors.length, labels: labels.length, collisions};
    }""")
    assert intersections["actors"] > 2 and intersections["labels"] > 0, "应采样实际人员和地图标签"
    assert not intersections["collisions"], f"地图标签覆盖人员标记：{intersections['collisions']}"


def run(page: Page) -> None:
    page.goto(BASE, wait_until="networkidle")
    page.get_by_role("button", name="载入演示社区", exact=True).click()
    page.get_by_test_id("confirm-community").click()
    expect(page.get_by_test_id("console-clock")).to_have_text("08:00:00")
    page.get_by_role("group", name="沙盘视图").get_by_role("button", name="物资", exact=True).click()
    assert page.locator("[data-route-state=waiting][data-flow=true]").count() == 0
    assert page.locator("[data-actor-id][data-motion-state=moving]").count() == 0
    passed("准备态没有虚假的行进人员或等待路线流动")

    # Evacuation groups give a short, genuinely moving journey on the community
    # map without waiting for an external supply journey to arrive.
    page.get_by_test_id("order-all-rescue").click()
    expect(page.get_by_test_id("order-all-rescue")).to_have_count(0)
    page.get_by_role("group", name="沙盘视图").get_by_role("button", name="撤离", exact=True).click()
    start(page)
    moving = page.locator("[data-actor-id][data-motion-state=moving]")
    expect(moving.first).to_be_visible(timeout=30000)
    before = positions(page)
    flow_before = offsets(page)
    assert flow_before, "真实撤离行进阶段应有方向流线"
    page.wait_for_timeout(500)
    after = positions(page)
    assert any(actor in after and value != after[actor] for actor, value in before.items()), "时钟运行时人员真实位置未推进"
    assert offsets(page) != flow_before, "时钟运行时流线没有推进"
    snapshot(page, "running-desktop")
    passed("真实撤离人员位置与路线流向随演练时钟推进")

    pause(page)
    frozen_positions, frozen_offsets = positions(page), offsets(page)
    frozen_clock = page.get_by_test_id("console-clock").inner_text()
    page.wait_for_timeout(600)
    assert positions(page) == frozen_positions, "暂停后人员仍移动"
    assert offsets(page) == frozen_offsets, "暂停后路线仍流动"
    expect(page.get_by_test_id("console-clock")).to_have_text(frozen_clock)
    assert page.locator("[data-actor-id][data-motion-state=moving]").count() == 0
    passed("暂停立即冻结人员、路线和时钟")

    page.emulate_media(reduced_motion="reduce")
    start(page)
    expect(moving.first).to_be_visible()
    page.wait_for_timeout(250)
    reduced_offsets = offsets(page)
    assert reduced_offsets and all(float(value.removesuffix("px")) == 0 for value in reduced_offsets), f"减少动态效果后流线仍有偏移：{reduced_offsets}"
    page.wait_for_timeout(300)
    # More actual groups may depart while the clock runs; compare their
    # rendered offsets, not the changing number of route elements.
    assert all(float(value.removesuffix("px")) == 0 for value in offsets(page)), "减少动态效果后新增路线仍在流动"
    assert page.locator(".sandbox-svg").evaluate("el => el.getAnimations({subtree:true}).every(animation => animation.playState !== 'running')"), "减少动态效果后SVG仍有装饰性动画"
    pause(page)
    page.emulate_media(reduced_motion="no-preference")
    passed("减少动态效果时取消流线装饰，保留真实位置和业务推进")

    # Inspect a denser real evacuation, including small screens. Label boxes
    # must leave the actual person marker/heading visible; leader lines do not
    # count as occlusion.
    advance(page, 1)
    for width, height in [(1440, 900), (1024, 768), (390, 844)]:
        page.set_viewport_size({"width": width, "height": height})
        workspace(page, "map")
        page.wait_for_timeout(150)
        labels_clear_actors(page)
        snapshot(page, f"evacuation-{width}")
        passed(f"{width}×{height} 真实撤离标签不遮挡人员箭头")
    page.set_viewport_size({"width": 1440, "height": 900})

    # Deterministic flood, blocked route and pending candidate use the same
    # original business callbacks as the full UI regression.
    page.get_by_role("button", name="重置演练", exact=True).click()
    expect(page.get_by_test_id("console-clock")).to_have_text("08:00:00")
    advance(page)
    # Wait for actual pickup/arrival events to make history scrollable; the
    # first flood interruption alone can produce only two rows.
    for _ in range(10):
        if page.get_by_role("list", name="调度事件列表").locator("li").count() >= 4:
            break
        advance(page, 1)
    assert page.get_by_role("list", name="调度事件列表").locator("li").count() >= 4, "演练应产生可阅读的调度历史"
    blocked_task = page.get_by_role("region", name="物资调度任务").get_by_role("button").filter(has_text="受阻").first
    expect(blocked_task).to_be_visible(timeout=30000)
    blocked_task.click()
    if page.get_by_test_id("toggle-external").inner_text().startswith("返回"):
        page.get_by_test_id("toggle-external").click()
    page.get_by_role("group", name="指挥地图底图").get_by_role("button", name="白模沙盘", exact=True).click()
    expect(page.locator("[data-route-state=blocked]").first).to_be_attached()
    assert page.locator("[data-route-state=blocked][data-flow=true]").count() == 0
    blocked = page.locator("[data-actor-id][data-motion-state=blocked]")
    assert blocked.count() > 0, "受阻人员需要可见的停顿标记"
    passed("真实内涝受阻后保留静态原路和人员停顿标记")

    page.get_by_test_id("open-candidates").click()
    drawer = page.get_by_test_id("console-drawer")
    feasible = drawer.locator(".candidate-card:not(.is-infeasible)")
    expect(feasible.first).to_be_visible(timeout=30000)
    chosen = feasible.nth(1) if feasible.count() > 1 else feasible.first
    chosen.get_by_role("button", name=re.compile("预览方案")).press("Enter")
    candidate_id = chosen.get_attribute("data-candidate-id")
    expect(page.get_by_test_id("hud-relay")).to_have_attribute("data-candidate-id", candidate_id)
    expect(page.locator("[data-route-state=candidate]").first).to_be_attached()
    assert page.locator("[data-route-state=candidate][data-flow=true]").count() == 0
    page.keyboard.press("Escape")
    expect(page.get_by_test_id("open-candidates")).to_be_focused()
    passed("预览候选保持静态，选中身份与待确认操作一致")

    activity = page.get_by_role("list", name="调度事件列表")
    activity.focus()
    activity.press("PageDown")
    page.wait_for_timeout(200)
    assert activity.evaluate("el => el.scrollTop") > 0, "调度历史应可键盘滚动"
    anchor = activity.evaluate("""el => {
      const bounds = el.getBoundingClientRect();
      const row = [...el.children].find(item => item.getBoundingClientRect().bottom > bounds.top + 1);
      return {id: row.dataset.eventId, offset: row.getBoundingClientRect().top - bounds.top};
    }""")
    latest_before = activity.locator("li").first.get_attribute("data-event-id")
    page.get_by_test_id("open-candidates").click()
    expect(drawer.locator(".candidate-card.is-selected")).to_have_attribute("data-candidate-id", candidate_id)
    page.get_by_test_id("confirm-viewed-candidate").click()
    expect(drawer).to_have_count(0)
    expect(page.get_by_test_id("hud-relay")).to_have_count(0)
    expect(activity.locator("li").first).not_to_have_attribute("data-event-id", latest_before)
    expect(activity.locator(".dispatch-activity-new").first).to_be_attached()
    anchored = activity.locator(f'[data-event-id="{anchor["id"]}"]')
    assert anchored.count(), "当前历史行不应在一次确认事件后丢失"
    offset = anchored.evaluate("el => el.getBoundingClientRect().top - el.parentElement.getBoundingClientRect().top")
    assert abs(offset - anchor["offset"]) <= 2, f"新事件抢走历史阅读位置：{anchor} -> {offset}"
    page.get_by_role("button", name="返回最新", exact=True).press("Enter")
    expect(activity).to_be_focused()
    assert activity.evaluate("el => el.scrollTop") == 0
    passed("确认当前方案产生真实新事件；历史阅读位置保留且可键盘返回最新")

    page.get_by_test_id("open-candidates").click()
    expect(drawer.locator(f'.candidate-card[data-candidate-id="{candidate_id}"]')).to_contain_text("已确认生效")
    page.keyboard.press("Escape")
    dismiss_notice(page)
    for width, height in [(1440, 900), (1024, 768), (390, 844)]:
        page.set_viewport_size({"width": width, "height": height})
        workspace(page, "map")
        clock = page.get_by_test_id("console-clock").inner_text()
        within_viewport(page, page.get_by_test_id("open-candidates"), f"{width}px 候选入口")
        dimensions = page.evaluate("({w:innerWidth,h:innerHeight,sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight})")
        assert dimensions["sw"] <= dimensions["w"] + 1 and dimensions["sh"] <= dimensions["h"] + 1, dimensions
        snapshot(page, f"confirmed-{width}")
        if width == 390:
            for pane in ["tasks", "analysis", "map"]:
                workspace(page, pane)
                expect(page.get_by_test_id("console-clock")).to_have_text(clock)
        passed(f"{width}×{height} 操作可达、无长页面，切换保留演练上下文")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    failure = None
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome")
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(15000)
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            run(page)
            assert not errors, "\n".join(errors)
            passed("无浏览器运行错误")
        except Exception as error:
            failure = f"{type(error).__name__}: {error}"
            traceback.print_exc()
            page.screenshot(path=str(OUT / "failure.png"), full_page=True)
            print(f"  ✗ {failure}", flush=True)
        finally:
            (OUT / "report.json").write_text(json.dumps({"base": BASE, "passed": RESULTS, "errors": errors, "failure": failure}, ensure_ascii=False, indent=2))
            browser.close()
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
