"""GeoRelay 浏览器端到端验证（Playwright + Chromium）。

覆盖验收主线：凹形围栏 → 生成 12 栋楼 → 改层数 → 刷新恢复 → 确认路网 → 进入指挥台
→ 时钟推进 → 内涝封路 → 候选比较 → 确认改派 → Agent 送达 → 重置。

运行：python scripts/e2e_check.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

# Windows 控制台默认 GBK，强制 UTF-8 输出，避免中文与符号乱码
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:5173"
SHOTS = Path(__file__).resolve().parent.parent / "artifacts" / "e2e"
results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append((name, bool(cond), detail))
    print(("  ✓ " if cond else "  ✗ ") + name + (f"  [{detail}]" if detail else ""))


def shot(page, name: str) -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=False)


def read_model(page):
    raw = page.evaluate("() => localStorage.getItem('georelay.community.v2')")
    return json.loads(raw) if raw else None


def main() -> int:
    with sync_playwright() as p:
        # 复用系统已安装的 Chrome/Edge，避免额外下载浏览器
        browser = None
        for kwargs in (
            {"channel": "chrome"},
            {"channel": "msedge"},
            {"executable_path": r"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"},
            {"executable_path": r"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"},
        ):
            try:
                browser = p.chromium.launch(**kwargs)
                print(f"  使用浏览器：{kwargs}")
                break
            except Exception as exc:  # noqa: BLE001
                last = exc
        if browser is None:
            raise SystemExit(f"无法启动浏览器：{last}")
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)

        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector("canvas", timeout=15000)
        check("页面加载并创建地图画布", True)
        shot(page, "01-load")

        # 1) 手绘围栏：进入绘制模式后点击若干点（含凹口），再完成
        page.get_by_role("button", name="绘制").click()
        box = page.locator(".map-host").bounding_box()
        assert box, "找不到地图容器"
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        pts = [(-160, -120), (80, -120), (80, -20), (-40, 40), (-160, 60)]
        for dx, dy in pts:
            page.mouse.click(cx + dx, cy + dy)
            time.sleep(0.08)
        page.get_by_role("button", name="完成围栏").click()
        time.sleep(0.5)
        model = read_model(page)
        fence_ok = bool(model and len(model["fence"]["polygon"]) >= 5)
        check("手绘围栏（含凹顶点）并确认", fence_ok, f"顶点 {len(model['fence']['polygon']) if model else 0} 个")
        area_badge = page.locator(".side-panel.left .badge").all_inner_texts()
        check("围栏面积已显示", any("m²" in t for t in area_badge), " / ".join(area_badge[:4]))
        shot(page, "02-fence")

        # 2) 载入演示社区（稳定包含 12 栋楼 + 路网），并核对几何校验
        page.get_by_role("button", name="载入演示社区").click()
        time.sleep(0.8)
        model = read_model(page)
        bcount = len(model["buildings"]) if model else 0
        check("批量生成 12 栋楼", bcount == 12, f"实际 {bcount} 栋")
        inside = page.locator(".notice.error").count()
        check("楼栋不越界/不重叠（无错误提示）", inside == 0)
        shot(page, "03-buildings")

        # 3) 通过楼栋列表选中并修改层数（列表比地图点击稳定，也更方便实际操作）
        # 直接派发 DOM 点击：楼栋列表在滚动容器内，避免被地图浮层遮挡导致 hit-test 失败
        page.locator(".side-panel.left .task-card").first.evaluate("el => el.click()")
        time.sleep(0.4)
        edited = False
        selected_panel = page.locator("[data-testid=selected-building]")
        if selected_panel.count() > 0:
            floors_input = selected_panel.locator("input[type=number]").first
            floors_input.fill("16")
            floors_input.dispatch_event("change")
            time.sleep(0.2)
            selected_panel.get_by_role("button", name="应用").first.evaluate("el => el.click()")
            time.sleep(0.6)
            model2 = read_model(page)
            edited = any(b["floors"] == 16 for b in model2["buildings"])
        check("选中楼栋并修改层数", edited, "改为 16 层" if edited else "未生效")
        shot(page, "04-edit-floor")

        # 4) 刷新恢复
        page.reload(wait_until="networkidle")
        page.wait_for_selector("canvas", timeout=15000)
        time.sleep(0.4)
        model3 = read_model(page)
        check("刷新后社区模型恢复", bool(model3) and len(model3["buildings"]) == 12, f"楼栋 {len(model3['buildings']) if model3 else 0}")

        # 5) 确认路网并进入指挥台
        page.get_by_role("button", name="确认路网").click()
        time.sleep(0.4)
        page.get_by_role("button", name="确认社区并进入指挥台").click()
        page.wait_for_selector(".side-panel.right", timeout=10000)
        check("进入指挥台（三栏布局）", page.locator(".side-panel.right").count() == 1)
        tabs = page.locator(".tab").all_inner_texts()
        check("三个视图可切换", tabs[:3] == ["全局", "社区内部", "外部支援"], " / ".join(tabs))
        shot(page, "05-console")

        # 6) 视图切换不丢进度：切到社区内部再回全局，任务选中保持
        first_task = page.locator(".side-panel.right .task-card").first.inner_text()
        page.get_by_role("button", name="社区内部").click()
        time.sleep(0.2)
        page.get_by_role("button", name="全局").click()
        time.sleep(0.2)
        same_task = page.locator(".side-panel.right .task-card").first.inner_text()
        check("切换视图不丢进度", first_task[:12] == same_task[:12], "任务卡一致")

        # 7) 开始演练，推进到封路
        page.get_by_role("button", name="开始演练").click()
        closure_seen = False
        # 用「+5 分钟」确定性推进演练时钟（比按真实时间等待更稳、更快）
        for _ in range(12):
            page.get_by_role("button", name="+5 分钟").evaluate("el => el.click()")
            time.sleep(0.6)
            body = page.locator(".side-panel.right").inner_text()
            if "road_closed" in body or "封路事件" in body:
                closure_seen = True
                break
        check("内涝达到阈值触发封路事件", closure_seen)
        shot(page, "06-closure")

        # 8) 候选出现并有校验项
        candidates = page.locator(".candidate-card").count()
        check("封路后生成可比较候选", candidates > 0, f"{candidates} 个候选")
        checks_visible = page.locator(".check-item").count()
        check("候选展示规则校验明细", checks_visible > 0, f"{checks_visible} 条校验")
        shot(page, "07-candidates")

        # 9) 确认改派（选第一个可行候选）
        confirm_btns = page.get_by_role("button", name="确认此方案")
        if confirm_btns.count() > 0:
            confirm_btns.first.click()
            time.sleep(0.6)
            panel = page.locator(".side-panel.right").inner_text()
            check("确认后改派生效应", "已确认" in panel or "确认改派" in panel)
        else:
            check("确认后改派生效应", False, "没有可行候选的确认按钮")
        shot(page, "08-confirmed")

        # 10) 继续推进，观察送达
        delivered = False
        for _ in range(18):
            page.get_by_role("button", name="+5 分钟").evaluate("el => el.click()")
            time.sleep(0.6)
            body = page.locator(".side-panel.right").inner_text()
            if "已送达" in body or "agent_delivered" in body:
                delivered = True
                break
        check("Agent 模拟执行并送达", delivered)
        shot(page, "09-delivered")

        # 11) 重置演练
        page.get_by_role("button", name="重置演练").first.click()
        time.sleep(0.6)
        reset_ok = page.locator(".side-panel.right").inner_text()
        check("重置演练回到初始状态", "08:00" in reset_ok or "演练已重置" in reset_ok)
        shot(page, "10-reset")

        check("运行期间无未捕获 JS 错误", len(errors) == 0, "; ".join(errors[:3]))
        if errors:
            print("\n  JS 错误：")
            for e in errors[:6]:
                print("   -", e)

        browser.close()

    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"\n{'═' * 64}")
    print(f"E2E 通过 {passed} / {total}")
    if passed != total:
        print("\n失败项：")
        for name, ok, detail in results:
            if not ok:
                print(f"  ✗ {name} {detail}")
    print(f"截图目录：{SHOTS}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
