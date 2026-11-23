"""Audit the current editor and console layout, accessibility, and contrast.

Run: .venv/bin/python scripts/layout_audit.py
Uses system Chrome in an isolated context. A running dev server is required.
Screenshots and machine-readable results are written to artifacts/layout-audit.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright
from ui_check import advance, workspace

BASE = os.environ.get("GEORELAY_BASE_URL", "http://127.0.0.1:5173")
OUT = Path(__file__).resolve().parent.parent / "artifacts" / "layout-audit"
ISSUES: list[str] = []
NOTES: list[str] = []


def check(ok: bool, description: str) -> None:
    (NOTES if ok else ISSUES).append(description)
    print(("  ✓ " if ok else "  ✗ ") + description, flush=True)


# Resolve rendered colors, including transparent surfaces and inherited opacity.
# Read text nodes (not just their containers): nested small/span styles matter.
CONTRAST_JS = r"""() => {
  const rgba = value => {
    const values = value.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 0];
    return [values[0], values[1], values[2], values[3] ?? 1];
  };
  const over = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]));
  const luminance = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  const background = el => {
    if (!el) return [255, 255, 255];
    const parent = background(el.parentElement), style = getComputedStyle(el);
    const own = over(rgba(style.backgroundColor), parent);
    return over([...own, Number(style.opacity)], parent);
  };
  const opacity = el => el ? Number(getComputedStyle(el).opacity) * opacity(el.parentElement) : 1;
  const results = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode, el = node.parentElement, label = node.textContent.trim();
    if (!label || !el || el.closest('svg, script, style, option, button:disabled, input:disabled, select:disabled, [aria-hidden="true"]')) continue;
    if (!el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    if (!range.getClientRects().length) continue;
    const style = getComputedStyle(el), bg = background(el), fg = rgba(style.color);
    fg[3] *= opacity(el);
    results.push({label: label.slice(0, 80), selector: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().replace(/\s+/g, '.') : ''),
      ratio: ratio(over(fg, bg), bg), foreground: style.color, background: bg});
  }
  // Token checks include secondary text on each shared surface, not just body.
  const probe = document.createElement('span'); document.body.append(probe);
  for (const fg of ['--gr-text', '--gr-text-2', '--gr-text-3']) {
    for (const bg of ['--gr-bg', '--gr-bg-soft', '--gr-surface']) {
      probe.style.color = `var(${fg})`; probe.style.backgroundColor = `var(${bg})`;
      const cs = getComputedStyle(probe);
      results.push({label: `${fg} / ${bg}`, selector: 'token', ratio: ratio(rgba(cs.color), rgba(cs.backgroundColor)), foreground: cs.color, background: cs.backgroundColor});
    }
  }
  probe.remove();
  return results;
}"""


def contrast(page: Page, label: str) -> None:
    samples = page.evaluate(CONTRAST_JS)
    failures = [item for item in samples if item["ratio"] < 4.5]
    (OUT / f"contrast-{label}.json").write_text(json.dumps(samples, ensure_ascii=False, indent=2))
    check(len(samples) > 20, f"{label}: sampled actual text and controls ({len(samples)})")
    check(not failures, f"{label}: all text/token contrast >= 4.5:1")
    for item in failures[:12]:
        print(f"    {item['ratio']:.2f}: {item['selector']} {item['label']!r} {item['foreground']} / {item['background']}", flush=True)


def hit_test(page: Page, locator, label: str) -> None:
    locator.scroll_into_view_if_needed()
    result = locator.evaluate("""el => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {ok: !!hit && (hit === el || el.contains(hit)), hit: hit?.outerHTML.slice(0, 160)};
    }""")
    check(result["ok"], f"{label}: reachable without footer/overlay obstruction" + (f" ({result['hit']})" if not result["ok"] else ""))


def overflow(page: Page, label: str) -> None:
    size = page.evaluate("({viewport:document.documentElement.clientWidth, content:document.documentElement.scrollWidth})")
    check(size["content"] <= size["viewport"] + 1, f"{label}: no horizontal overflow ({size['content']}/{size['viewport']})")


def within_viewport(page: Page, locator, label: str) -> None:
    box, viewport = locator.bounding_box(), page.viewport_size
    check(bool(box and box['x'] >= 0 and box['y'] >= 0 and box['x'] + box['width'] <= viewport['width'] + 1 and box['y'] + box['height'] <= viewport['height'] + 1), f'{label}: primary control in viewport without page scrolling ({box})')
    if box:
        hit = locator.evaluate("el => {const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!hit&&(hit===el||el.contains(hit))}")
        check(hit, f'{label}: primary control unobstructed')


def compact_console(page: Page, label: str) -> None:
    dimensions = page.evaluate('({viewport:innerHeight,page:document.documentElement.scrollHeight})')
    check(dimensions['page'] <= dimensions['viewport'] + 1, f'{label}: workspaces fit viewport instead of a long page {dimensions}')
    within_viewport(page, page.get_by_test_id('open-candidates'), f'{label} candidates')


def state_snapshot(page: Page, name: str, console_state: bool = True) -> None:
    for width, height in [(1440, 900), (1024, 768), (390, 844)]:
        page.set_viewport_size({'width': width, 'height': height})
        if console_state:
            workspace(page, 'map')
        page.wait_for_timeout(650)
        overflow(page, f'{name} {width}')
        contrast(page, f'{name}-{width}')
        if console_state and width <= 900:
            compact_console(page, f'{name} {width}')
        page.screenshot(path=str(OUT / f'{name}-{width}.png'), full_page=True)
    page.set_viewport_size({'width': 1440, 'height': 900})


def open_step(page: Page, step: str) -> None:
    button = page.get_by_test_id(f"rail-step-{step}")
    if button.get_attribute("aria-expanded") != "true":
        button.click()


def dismiss_notice(page: Page) -> None:
    for button in page.locator('.workspace-feedback').get_by_role("button", name="关闭通知", exact=True).all():
        button.click()


def editor(page: Page, width: int, height: int) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.wait_for_timeout(200)
    open_step(page, "buildings")
    rail = page.get_by_test_id("editor-rail").bounding_box()
    host = page.locator(".map-host").bounding_box()
    canvas = page.locator(".map-host canvas").evaluate("el => ({width:el.width,height:el.height,cssWidth:el.getBoundingClientRect().width,cssHeight:el.getBoundingClientRect().height})")
    check(bool(rail and rail["width"] >= 240), f"editor {width}: usable editing rail")
    check(bool(host and host["width"] >= 300 and host["height"] >= 280), f"editor {width}: usable map area {host}")
    check(canvas["width"] >= 300 and canvas["height"] >= 280 and abs(canvas["cssWidth"] - host["width"]) < 2 and abs(canvas["cssHeight"] - host["height"]) < 2, f"editor {width}: real canvas matches map container")
    if width >= 901:
        check(rail["x"] + rail["width"] <= host["x"] + 1, f"editor {width}: rail and map occupy separate columns")
        scroll = page.locator(".rail-scroll").evaluate("el => {el.scrollTop = el.scrollHeight; return {client:el.clientHeight,scroll:el.scrollHeight,top:el.scrollTop}}")
        check(scroll["scroll"] > scroll["client"] and scroll["top"] > 0, f"editor {width}: expanded building editor really scrolls {scroll}")
        body = page.locator(".rail-scroll").bounding_box()
        foot = page.locator(".rail-foot").bounding_box()
        check(body["y"] + body["height"] <= foot["y"] + 1, f"editor {width}: scroll area ends before footer")
    hit_test(page, page.locator('.editor-building-list button').last, f"editor {width} last building")
    hit_test(page, page.get_by_test_id('confirm-community'), f"editor {width} enter-console action")
    overflow(page, f"editor {width}")
    contrast(page, f"editor-{width}")
    page.screenshot(path=str(OUT / f"editor-{width}.png"), full_page=True)


def console(page: Page, width: int, height: int) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.wait_for_timeout(200)
    workspace(page, 'map')
    svg = page.locator('.sandbox-svg').bounding_box()
    check(bool(svg and svg['width'] >= 300 and svg['height'] >= 280), f"console {width}: usable scene {svg}")
    check(page.get_by_test_id('hud-relay').count() == 0, f'console {width}: no redundant confirmation footer before a pending plan')
    within_viewport(page, page.get_by_test_id('open-candidates'), f'console {width} candidates')
    if width <= 900:
        compact_console(page, f'console map {width}')
        page.screenshot(path=str(OUT / f'console-map-{width}.png'), full_page=True)
    workspace(page, 'tasks')
    hit_test(page, page.get_by_test_id('open-evacuation'), f"console {width} evacuation action")
    hit_test(page, page.get_by_test_id('open-candidates'), f"console {width} candidate action")
    if width <= 900:
        within_viewport(page, page.get_by_test_id('open-evacuation'), f'console {width} evacuate')
        compact_console(page, f'console tasks {width}')
        page.screenshot(path=str(OUT / f'console-tasks-{width}.png'), full_page=True)
        workspace(page, 'analysis')
    elif page.get_by_test_id('toggle-analysis').get_attribute('aria-expanded') != 'true':
        page.get_by_test_id('toggle-analysis').click()
    legend = page.locator('.dispatch-legend')
    if legend.get_attribute('open') is None:
        legend.locator('summary').click()
    expect(legend.get_by_text('已生效路线', exact=True)).to_be_visible()
    check('待确认候选' in legend.inner_text() and '受阻点' in legend.inner_text(), f"console {width}: meaningful legend accessible")
    hit_test(page, legend.locator('summary'), f"console {width} legend")
    overflow(page, f"console {width}")
    contrast(page, f"console-{width}")
    page.screenshot(path=str(OUT / f"console-{width}.png"), full_page=True)
    if width <= 900:
        compact_console(page, f'console analysis {width}')
        workspace(page, 'map')
    else:
        page.get_by_test_id('toggle-analysis').click()


def run(page: Page) -> None:
    page.goto(BASE, wait_until="networkidle")
    page.locator('.map-host canvas').wait_for()
    state_snapshot(page, 'empty', console_state=False)
    page.get_by_role('button', name='载入演示社区', exact=True).click()
    page.wait_for_timeout(700)
    dismiss_notice(page)
    for size in [(1440, 900), (1024, 768), (390, 844)]:
        editor(page, *size)
    page.set_viewport_size({'width': 1440, 'height': 900})
    page.locator('.editor-building-list button').first.click()
    selected = page.get_by_test_id('selected-building')
    floors = selected.get_by_role('spinbutton', name='层数', exact=True)
    original = floors.input_value()
    floors.fill('-1')
    selected.get_by_role('button', name='应用', exact=True).click()
    expect(page.locator('.workspace-feedback .notice.error')).to_be_visible()
    state_snapshot(page, 'error', console_state=False)
    floors.fill(original)
    selected.get_by_role('button', name='应用', exact=True).click()
    dismiss_notice(page)
    page.set_viewport_size({"width": 1440, "height": 900})
    page.get_by_test_id('confirm-community').click()
    expect(page.get_by_test_id('console-clock')).to_have_text('08:00:00')
    expect(page.locator('.scene-transition')).to_have_count(0)
    for size in [(1440, 900), (1024, 768), (390, 844)]:
        console(page, *size)

    page.set_viewport_size({"width": 1440, "height": 900})
    page.get_by_role('button', name='开始演练', exact=True).click()
    expect(page.get_by_test_id('console-clock')).not_to_have_text('08:00:00')
    state_snapshot(page, 'running')
    page.get_by_role('button', name='暂停', exact=True).click()
    page.get_by_role('button', name='重置演练', exact=True).click()
    for _ in range(6):
        advance(page)
        if int(page.get_by_test_id('hud-task').get_attribute('data-plan-sets') or '0') > 0:
            break
    state_snapshot(page, 'blocked')
    blocked = page.get_by_role('region', name='物资调度任务').get_by_role('button').filter(has_text='受阻').first
    expect(blocked).to_be_visible()
    blocked.click()
    page.get_by_test_id('open-candidates').click()
    cards = page.locator('.candidate-card')
    expect(cards.first).to_be_visible(timeout=30000)
    check(cards.count() > 0, 'candidate drawer contains plans')
    for card in cards.all():
        badge = card.locator('.badge').first.inner_text()
        check('可行' in badge, f'candidate feasibility has text: {badge}')
        check(card.locator('.check-item').count() > 0, 'candidate validation has text and pass/fail symbols')
        if 'is-infeasible' in (card.get_attribute('class') or ''):
            check('不可行' in badge, 'infeasible candidate explicitly says 不可行')
            card.get_by_role('button').first.click()
            expect(page.get_by_test_id('confirm-viewed-candidate')).to_have_count(0)
            expect(page.get_by_test_id('console-drawer')).to_contain_text('未通过校验')
            expect(page.get_by_test_id('hud-relay')).to_have_count(0)
    hit_test(page, cards.first.get_by_role('button').first, 'candidate preview')
    contrast(page, 'candidates')
    overflow(page, 'candidate drawer')
    page.screenshot(path=str(OUT / 'candidates.png'), full_page=True)
    viable = page.locator('.candidate-card:not(.is-infeasible)').first
    viable.get_by_role('button').first.click()
    candidate_id = viable.get_attribute('data-candidate-id')
    page.keyboard.press('Escape')
    expect(page.get_by_test_id('open-candidates')).to_be_focused()
    expect(page.get_by_test_id('hud-relay')).to_have_attribute('data-candidate-id', candidate_id)
    state_snapshot(page, 'pending')
    page.get_by_test_id('open-candidates').click()
    page.get_by_test_id('confirm-viewed-candidate').click()
    expect(page.get_by_test_id('hud-relay')).to_have_count(0)
    expect(page.get_by_test_id('console-drawer')).to_have_count(0)
    expect(page.get_by_test_id('open-candidates')).to_be_focused()
    page.get_by_test_id('open-candidates').click()
    expect(page.locator('.candidate-card.is-selected')).to_contain_text('已确认生效')
    page.get_by_test_id('close-drawer').click()
    state_snapshot(page, 'confirmed')


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome')
        page = browser.new_page(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
        page.set_default_timeout(15000)
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            run(page)
        except Exception as error:
            check(False, f'audit could not complete: {error}')
            page.screenshot(path=str(OUT / 'failure.png'), full_page=True)
        finally:
            check(not errors, f'no uncaught browser errors: {errors}')
            (OUT / 'report.json').write_text(json.dumps({'passed': NOTES, 'failures': ISSUES}, ensure_ascii=False, indent=2))
            page.close(run_before_unload=False)
            browser.close()
    print(f'\n{len(NOTES)} passed, {len(ISSUES)} failed. Report: {OUT / "report.json"}', flush=True)
    return int(bool(ISSUES))


if __name__ == '__main__':
    raise SystemExit(main())
