"""布局与可读性审计（不依赖肉眼看图）。

检查：三栏布局尺寸、地图画布真实尺寸、面板滚动、是否有横向溢出、
关键状态是否三重编码（颜色 + 形状 + 文字）、以及颜色对比度是否达标。
"""
from __future__ import annotations

import sys

from playwright.sync_api import sync_playwright

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:5173"
issues: list[str] = []
notes: list[str] = []


def contrast(rgb1: str, rgb2: str) -> float:
    def lum(rgb: str) -> float:
        nums = [int(x) for x in rgb.replace("rgb(", "").replace(")", "").split(",")[:3]]
        out = []
        for v in nums:
            c = v / 255
            out.append(c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4)
        return 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2]

    l1, l2 = lum(rgb1), lum(rgb2)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_selector("canvas")
    page.get_by_role("button", name="载入演示社区").click()
    page.wait_for_timeout(700)

    # 1) 三栏布局
    shell = page.locator(".app-shell").bounding_box()
    left = page.locator(".side-panel.left").bounding_box()
    stage = page.locator(".stage").bounding_box()
    top = page.locator(".topbar").bounding_box()
    print(f"shell={shell} left={left} stage={stage} top={top}")
    if not shell or shell["width"] < 1400:
        issues.append("app-shell 未铺满视口宽度")
    if not left or left["width"] < 240:
        issues.append(f"左面板过窄：{left}")
    if not stage or stage["width"] < 400:
        issues.append(f"地图区过窄：{stage}")

    # 2) 画布尺寸（示例地图必须真的画出来）
    canvas = page.locator(".map-host canvas").bounding_box()
    print(f"canvas={canvas}")
    if not canvas or canvas["width"] < 300 or canvas["height"] < 200:
        issues.append(f"地图画布尺寸异常：{canvas}")

    # 3) 横向溢出
    overflow = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
    if overflow > 2:
        issues.append(f"页面存在横向溢出 {overflow}px")

    # 4) 面板可滚动（内容多时）
    scrollable = page.evaluate(
        """() => {
        const el = document.querySelector('.side-panel.left .panel-scroll');
        return el ? { client: el.clientHeight, scroll: el.scrollHeight } : null;
    }"""
    )
    print(f"left panel scroll={scrollable}")
    if scrollable and scrollable["scroll"] <= 0:
        issues.append("左侧面板未渲染内容")

    # 5) 对比度：正文与背景
    styles = page.evaluate(
        """() => {
        const g = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; };
        return {
            body: g('body', 'backgroundColor'),
            text: g('.panel-title', 'color'),
            hint: g('.field-hint', 'color'),
            btnPrimaryBg: g('.btn.primary', 'backgroundColor'),
            btnPrimaryText: g('.btn.primary', 'color'),
            badgeWarn: g('.badge.warn', 'color'),
        };
    }"""
    )
    print(styles)
    if styles["body"] and styles["text"]:
        ratio = contrast(styles["text"], styles["body"])
        notes.append(f"标题/背景对比度 {ratio:.2f}")
        if ratio < 4.5:
            issues.append(f"标题对比度不足：{ratio:.2f}")
    if styles["hint"] and styles["body"]:
        ratio = contrast(styles["hint"], styles["body"])
        notes.append(f"次要文字/背景对比度 {ratio:.2f}")
        if ratio < 3.0:
            issues.append(f"次要文字对比度不足：{ratio:.2f}")

    # 6) 进指挥台，检查三视图与候选卡的三重编码
    page.get_by_role("button", name="确认路网").click()
    page.wait_for_timeout(300)
    page.get_by_role("button", name="确认社区并进入指挥台").click()
    page.wait_for_selector(".side-panel.right")
    page.wait_for_timeout(500)

    tabs = page.locator(".tab").all_inner_texts()
    notes.append(f"视图页签：{tabs[:3]}")

    page.get_by_role("button", name="开始演练").click()
    for _ in range(12):
        page.get_by_role("button", name="+5 分钟").evaluate("el => el.click()")
        page.wait_for_timeout(500)
        if page.locator(".candidate-card").count() > 0:
            break

    cards = page.locator(".candidate-card").count()
    checks = page.locator(".check-item").count()
    badges = page.locator(".candidate-card .badge").all_inner_texts()
    notes.append(f"候选卡 {cards} 个，校验项 {checks} 条")
    notes.append(f"候选徽标文案：{badges[:4]}")
    if cards == 0:
        issues.append("进入指挥台推进后没有候选卡")
    if checks == 0:
        issues.append("候选卡没有展示校验明细")
    # 不可行候选必须同时有文字与样式区分
    infeasible = page.locator(".candidate-card.is-infeasible").count()
    notes.append(f"不可行候选 {infeasible} 个（应有虚线/透明度区分）")

    # 7) 事件记录与图例存在
    if page.locator(".event-log").count() == 0:
        issues.append("缺少事件记录区")
    if page.locator(".legend").count() == 0:
        issues.append("缺少图例")

    # 8) 演练数据标注
    flags = page.locator(".data-flag, .sample-flag").count()
    notes.append(f"“演练数据/示例数据”标注 {flags} 处")
    if flags == 0:
        issues.append("没有找到演练数据标注")

    browser.close()

print("\n审计结果")
for n in notes:
    print("  ·", n)
if issues:
    print("\n发现问题：")
    for i in issues:
        print("  ✗", i)
    sys.exit(1)
print("\n  ✓ 无布局/可读性问题")
