import json
import pathlib
import re

from playwright.sync_api import sync_playwright

OUT = pathlib.Path("artifacts/redesign")
OUT.mkdir(parents=True, exist_ok=True)
URL = "http://127.0.0.1:5173/"


def run(width: int, height: int, tag: str, keep: bool) -> dict:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        page = browser.new_page(viewport={"width": width, "height": height})
        page.on("dialog", lambda d: d.accept())
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_timeout(700)

        # ---------- A：定位 → 围栏 → 楼栋（改一栋高度）→ 入口与路网 ----------
        page.get_by_role("button", name=re.compile("载入演示社区")).first.click()
        page.wait_for_timeout(900)
        head = page.locator('[data-testid="rail-step-buildings"]')
        if head.first.get_attribute("aria-expanded") != "true":
            head.first.click()
        page.get_by_role("button", name=re.compile("批量生成楼栋")).first.click()
        page.wait_for_timeout(1000)

        rows = page.locator(".rail-list-row")
        rows.first.click()
        page.wait_for_timeout(300)
        panel = page.locator('[data-testid="selected-building"]')
        panel.locator('input[type="number"]').first.fill("18")
        panel.get_by_role("button", name="应用").click()
        page.wait_for_timeout(600)
        if keep:
            page.screenshot(path=str(OUT / f"{tag}-a-modeling.png"))

        head = page.locator('[data-testid="rail-step-network"]')
        if head.first.get_attribute("aria-expanded") != "true":
            head.first.click()
        page.get_by_role("button", name=re.compile("生成示例路网")).first.click()
        page.wait_for_timeout(700)
        page.get_by_role("button", name=re.compile("确认路网")).first.click()
        page.wait_for_timeout(700)

        model_info = page.evaluate("""() => {
          const m = JSON.parse(localStorage.getItem('georelay.community.v2') || '{}')
          const bs = m.buildings || []
          return {
            buildings: bs.length,
            maxHeight: Math.max(...bs.map(b => b.floors * b.floorHeightM)),
            gates: (m.net?.gates || []).length,
            staging: (m.net?.staging || []).length,
            roads: (m.net?.roads || []).length,
            markers: (m.net?.roads || []).length,
          }
        }""")

        # A → C
        page.locator('[data-testid="confirm-community"]').click()
        page.wait_for_timeout(2600)
        stage_info = page.evaluate("""() => {
          const sb = document.querySelector('[data-testid="sandbox"]')
          return sb ? {
            buildings: Number(sb.getAttribute('data-buildings')),
            roads: Number(sb.getAttribute('data-roads')),
            maxHeight: Number(sb.getAttribute('data-max-height')),
            minHeight: Number(sb.getAttribute('data-min-height')),
          } : null
        }""")
        if keep:
            page.screenshot(path=str(OUT / f"{tag}-c-sandbox.png"))

        # ---------- C：一键演练「地震换接驳点」 ----------
        page.locator('[data-testid="open-judgement"]').click()
        page.wait_for_timeout(700)
        page.get_by_role("button", name=re.compile("地震换接驳点")).first.click()
        page.wait_for_timeout(2600)
        page.locator('[data-testid="close-drawer"]').click()
        page.wait_for_timeout(600)

        # 推进到「原接驳点失效 + 候选待确认」
        for _ in range(14):
            btn = page.locator('[data-testid="confirm-reroute"]')
            if not btn.is_disabled():
                break
            page.locator('[data-testid="step-1min"]').click()
            page.wait_for_timeout(450)
        pending = {
            "clock": page.locator('[data-testid="console-clock"]').inner_text(),
            "blocked": page.locator('[data-testid="hud-blocked"]').inner_text(),
            "confirm_disabled": page.locator('[data-testid="confirm-reroute"]').is_disabled(),
            "candidates": page.locator('[data-testid="open-candidates"]').inner_text(),
            "relay": page.locator('[data-testid="hud-relay"]').inner_text(),
        }
        if keep:
            page.screenshot(path=str(OUT / f"{tag}-c-pending.png"))

        # 确认改派 → 接力执行中
        if not pending["confirm_disabled"]:
            page.locator('[data-testid="confirm-reroute"]').click()
            page.wait_for_timeout(1200)
        relay_shot_taken = False
        confirms = 0
        for _ in range(14):
            # 地震是「多点中断」：每出现新的中断/新候选，指挥员都要再确认一次
            for _ in range(2):
                btn = page.locator('[data-testid="confirm-reroute"]')
                if not btn.is_disabled():
                    btn.click()
                    confirms += 1
                    page.wait_for_timeout(1000)
            page.locator('[data-testid="step-5min"]').click()
            page.wait_for_timeout(1300)
            phase = page.locator('[data-testid="hud-task"]').get_attribute("data-plan-phase")
            if keep and not relay_shot_taken and phase in ("handover_wait", "delivering", "internal_ready"):
                page.screenshot(path=str(OUT / f"{tag}-c-relay.png"))
                relay_shot_taken = True
            if phase == "delivered":
                break
        final = {
            "clock": page.locator('[data-testid="console-clock"]').inner_text(),
            "blocked": page.locator('[data-testid="hud-blocked"]').inner_text(),
            "phase": page.locator('[data-testid="hud-task"]').get_attribute("data-plan-phase"),
            "confirms": confirms,
            "task_card": page.locator('[data-testid="hud-task"]').inner_text(),
            "relay": page.locator('[data-testid="hud-relay"]').inner_text(),
        }
        if keep and not relay_shot_taken:
            page.screenshot(path=str(OUT / f"{tag}-c-relay.png"))

        # 外部地图往返：状态不丢
        page.locator('[data-testid="toggle-external"]').click()
        page.wait_for_timeout(1400)
        if keep:
            page.screenshot(path=str(OUT / f"{tag}-external-map.png"))
        page.locator('[data-testid="toggle-external"]').click()
        page.wait_for_timeout(1200)
        after_return = page.locator('[data-testid="console-clock"]').inner_text()
        if keep:
            page.screenshot(path=str(OUT / f"{tag}-c-back.png"))

        # 判据抽屉
        page.locator('[data-testid="open-judgement"]').click()
        page.wait_for_timeout(800)
        if keep:
            page.screenshot(path=str(OUT / f"{tag}-drawer.png"))

        browser.close()
        return {
            "tag": tag,
            "viewport": [width, height],
            "model_info": model_info,
            "sandbox_info": stage_info,
            "pending": pending,
            "final": final,
            "clock_after_return": after_return,
            "js_errors": errors,
        }


if __name__ == "__main__":
    results = [run(1440, 900, "1440x900", True), run(1280, 800, "1280x800", True)]
    print(json.dumps(results, ensure_ascii=False, indent=2))
