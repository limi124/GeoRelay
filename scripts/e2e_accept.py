"""本轮验收：A→C 一致性 / 地震改派接力 / 复盘 / 预置演练不覆盖自建社区。

跑两档分辨率（1440x900、1280x800），带断言与截图。
用法：python scripts/e2e_accept.py [--only 1440]
"""

import json
import pathlib
import re
import sys

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

OUT = pathlib.Path("artifacts/accept")
OUT.mkdir(parents=True, exist_ok=True)
URL = "http://127.0.0.1:5173/"
STORAGE = "georelay.community.v2"

results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


def read_model(page):
    return page.evaluate(
        f"""() => {{
          try {{ return JSON.parse(localStorage.getItem('{STORAGE}') || 'null') }} catch (e) {{ return null }}
        }}"""
    )


def gr(page, expr: str):
    """读取演练调试状态（仅 DEV 构建暴露 window.__gr）。"""
    return page.evaluate(f"() => {{ const g = window.__gr; if (!g) return null; return ({expr}) }}")


def fence_state(page):
    """建模页围栏步骤的可见状态：步骤头摘要、步骤体提示、顶栏提示、按钮态、已存围栏。"""
    return page.evaluate(
        """() => {
          const sections = [...document.querySelectorAll('section.rail-step')]
          const fenceSection = sections.find((s) => ((s.querySelector('.rail-step-head') || {}).innerText || '').includes('围栏'))
          const model = JSON.parse(localStorage.getItem('georelay.community.v2') || 'null')
          const fence = (model || {}).fence || {}
          const btn = (label) => {
            const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === label)
            return b ? b.className.includes('is-active') : false
          }
          return {
            fence_head: fenceSection ? fenceSection.querySelector('.rail-step-head').innerText.replace(/\\n/g, ' ') : '',
            step_notice: fenceSection && fenceSection.querySelector('.rail-step-body') ? fenceSection.querySelector('.rail-step-body').innerText.replace(/\\n/g, ' ') : '',
            top_notice: [...document.querySelectorAll('.map-notice-stack .notice')].map((n) => n.innerText.replace(/\\n/g, ' ')).join(' | '),
            draw_active: btn('绘制'),
            edit_active: btn('编辑顶点'),
            saved_verts: (fence.polygon || []).length,
            saved_area: Math.round(fence.areaM2 || 0),
            zoom: window.__geoMap.getZoom(),
            alive: window.__no_reload || 'gone',
          }
        }"""
    )


def map_screen_points(page, ratios):
    """把画布比例坐标换算成屏幕像素：两档分辨率下都落在地图可视区内，避开浮层。"""
    return page.evaluate(
        """(rs) => {
          const box = document.querySelector('.map-host').getBoundingClientRect()
          return rs.map(([fx, fy]) => ({ x: Math.round(box.left + box.width * fx), y: Math.round(box.top + box.height * fy) }))
        }""",
        ratios,
    )


def open_fence_step(page) -> None:
    """围栏步骤完成后会自动收起，点之前重新展开。"""
    head = page.locator('[data-testid="rail-step-fence"]')
    if head.first.get_attribute("aria-expanded") != "true":
        head.first.click()
        page.wait_for_timeout(300)


def click_fence_step_button(page, label: str) -> None:
    """点围栏步骤里的按钮（绘制/重画等）：模型异步收敛会把步骤体收起来，收到就重开再点。"""
    btn = page.get_by_role("button", name=label, exact=True).first
    for _ in range(4):
        open_fence_step(page)
        try:
            btn.click(timeout=2500)
            return
        except PlaywrightTimeoutError:
            page.wait_for_timeout(400)
    btn.click(timeout=5000)



def load_preset(page, preset_id: str) -> None:
    page.locator('[data-testid="open-judgement"]').click()
    page.wait_for_timeout(700)
    page.locator('[data-testid="preset-' + preset_id + '"]').first.click()
    page.wait_for_timeout(2600)
    if page.locator('[data-testid="close-drawer"]').count() and page.locator('[data-testid="close-drawer"]').is_visible():
        page.locator('[data-testid="close-drawer"]').click()
        page.wait_for_timeout(400)


def drive_drill(page, max_rounds: int = 14) -> dict:
    confirms = 0
    first_candidate = None
    for _ in range(max_rounds):
        btn = page.locator('[data-testid="confirm-reroute"]')
        if not btn.is_disabled():
            if first_candidate is None:
                first_candidate = gr(
                    page,
                    '(() => { const ps = g.planSet; if (!ps) return null;'
                    ' const c = ps.candidates.filter(x => x.feasible)[0];'
                    ' return { title: c ? c.title : null, kind: c ? c.kind : null,'
                    ' targetDoor: c && c.legs && c.legs.internal ? c.legs.internal.targetDoor : null,'
                    ' roads: c && c.legs && c.legs.internal ? c.legs.internal.roadIds : [],'
                    ' eventId: ps.eventId, confirmed: ps.confirmedCandidateId } })()',
                )
            btn.click()
            confirms += 1
            page.wait_for_timeout(800)
        page.locator('[data-testid="step-5min"]').click()
        page.wait_for_timeout(1100)
        if page.locator('[data-testid="hud-task"]').get_attribute("data-plan-phase") == "delivered":
            break
    return {"confirms": confirms, "candidate": first_candidate}


def run(width: int, height: int, tag: str) -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        page = browser.new_page(viewport={"width": width, "height": height})
        dialog_messages: list[str] = []

        def on_dialog(d):
            dialog_messages.append(d.message)
            d.accept()

        page.on("dialog", on_dialog)
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        # 双击结束绘制必须是同一次页面会话：任何 framenavigated（含整页刷新）都会记在这里
        frame_events: list[str] = []
        page.on("framenavigated", lambda f: frame_events.append(f.url))
        page.goto(URL, wait_until="domcontentloaded")
        page.evaluate(f"() => localStorage.removeItem('{STORAGE}')")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector('[data-testid="editor-rail"]', timeout=20000)
        page.wait_for_timeout(2500)

        # ---------------- A：建模，拖动一栋楼 + 改层高 ----------------
        page.get_by_test_id('rail-locate').get_by_role("button", name="载入演示社区").click()
        page.wait_for_timeout(900)
        head = page.locator('[data-testid="rail-step-buildings"]')
        if head.first.get_attribute("aria-expanded") != "true":
            head.first.click()
            page.wait_for_timeout(250)
        page.get_by_role("button", name=re.compile("批量生成楼栋")).first.click()
        page.wait_for_timeout(1000)

        model_a0 = read_model(page)
        # 选一栋投影后确实落在画布可视区域内的楼栋（小屏时避免落到侧栏/边缘）
        picks = page.evaluate(
            """() => {
              const map = window.__geoMap
              const host = document.querySelector('.map-host')
              if (!map || !map.debugProject || !host) return []
              const box = host.getBoundingClientRect()
              const model = JSON.parse(localStorage.getItem('georelay.community.v2') || '{}')
              return (model.buildings || []).map((b, i) => {
                const p = map.debugProject(b.center)
                return { i, name: b.name, id: b.id, x: box.left + p[0], y: box.top + p[1], w: box.width, h: box.height, left: box.left, top: box.top }
              })
            }"""
        )
        visible = [
            q for q in picks
            if q["left"] + 50 < q["x"] < q["left"] + q["w"] - 50 and q["top"] + 80 < q["y"] < q["top"] + q["h"] - 90
        ]
        pick = (visible or picks)[0]
        page.locator(".rail-list-row").filter(has_text=pick["name"]).first.click()
        page.wait_for_timeout(300)
        b0 = next(b for b in model_a0["buildings"] if b["id"] == pick["id"])
        target_id = b0["id"]
        screen = [pick["x"], pick["y"]]
        drag_delta_m = 0.0
        if screen:
            page.mouse.move(screen[0], screen[1])
            page.mouse.down()
            for k in range(1, 7):
                page.mouse.move(screen[0] + 6 * k, screen[1] + 4 * k)
                page.wait_for_timeout(40)
            page.mouse.up()
            page.wait_for_timeout(600)
        model_a1 = read_model(page)
        b1 = next((b for b in model_a1["buildings"] if b["id"] == target_id), None)
        moved = b1 is not None and b1["center"] != b0["center"]
        if moved:
            drag_delta_m = page.evaluate(
                """([a, b]) => {
                  const R = 6378137, rad = Math.PI / 180
                  const dx = (b[0] - a[0]) * rad * R * Math.cos(a[1] * rad)
                  const dy = (b[1] - a[1]) * rad * R
                  return Math.hypot(dx, dy)
                }""",
                [b0["center"], b1["center"]],
            )
        check("A：同一楼栋被真实鼠标拖动（ID 不变）", moved, f"{target_id} 位移 {drag_delta_m:.1f} m")
        page.screenshot(path=str(OUT / f"{tag}-01-a-drag.png"))

        panel = page.locator('[data-testid="selected-building"]')
        panel.locator('input[type="number"]').first.fill("14")
        panel.get_by_role("button", name="应用").click()
        page.wait_for_timeout(600)

        head = page.locator('[data-testid="rail-step-network"]')
        if head.first.get_attribute("aria-expanded") != "true":
            head.first.click()
            page.wait_for_timeout(250)
        page.get_by_role("button", name=re.compile("生成示例路网")).first.click()
        page.wait_for_timeout(700)
        page.get_by_role("button", name=re.compile("确认路网")).first.click()
        page.wait_for_timeout(700)

        model_a = read_model(page)
        a_b = next((b for b in model_a["buildings"] if b["id"] == target_id), {})
        check("A：同一楼栋层高改为 14", a_b.get("floors") == 14, f"floors={a_b.get('floors')}")
        a_snapshot = {
            "updatedAt": model_a.get("updatedAt"),
            "ids": sorted(b["id"] for b in model_a["buildings"]),
            "centers": {b["id"]: b["center"] for b in model_a["buildings"]},
            "gates": sorted(g["id"] for g in model_a["net"]["gates"]),
            "staging": sorted(s["id"] for s in model_a["net"]["staging"]),
            "roadIds": sorted(r["id"] for r in model_a["net"]["roads"]),
        }
        page.screenshot(path=str(OUT / f"{tag}-02-a-modeling.png"))

        # ---------------- A → C：同一份模型 ----------------
        page.locator('[data-testid="confirm-community"]').click()
        page.wait_for_timeout(2600)
        sandbox = page.locator('[data-testid="sandbox"]')
        check("C：白模沙盘出现", sandbox.count() == 1)
        check(
            "C：沙盘楼栋数与 A 一致",
            int(sandbox.get_attribute("data-buildings")) == len(model_a["buildings"]),
            f"{sandbox.get_attribute('data-buildings')} / {len(model_a['buildings'])}",
        )
        check(
            "C：沙盘最高楼 = 14 层 × 2.9m",
            abs(float(sandbox.get_attribute("data-max-height")) - 14 * 2.9) < 0.05,
            sandbox.get_attribute("data-max-height"),
        )
        c_model = gr(page, "g.engine.view.model")
        c_b = next((b for b in c_model["buildings"] if b["id"] == target_id), None)
        check(
            "C：同一楼栋 ID 的位置/层高/入口都来自刚确认的社区",
            c_b is not None
            and c_b["center"] == a_b["center"]
            and c_b["floors"] == 14
            and c_b["entrance"] == a_b["entrance"],
            f"center={c_b['center'] if c_b else None} floors={c_b['floors'] if c_b else None}",
        )
        check(
            "C：围栏/大门/接驳点/路网同版本",
            c_model["updatedAt"] == a_snapshot["updatedAt"]
            and sorted(g["id"] for g in c_model["net"]["gates"]) == a_snapshot["gates"]
            and sorted(s["id"] for s in c_model["net"]["staging"]) == a_snapshot["staging"]
            and sorted(r["id"] for r in c_model["net"]["roads"]) == a_snapshot["roadIds"],
            f"updatedAt={c_model['updatedAt']}",
        )
        check("C：用户社区不套用模型算例映射", gr(page, "Boolean(g.engine.modelRun)") is False)

        # 布局：沙盘是主角，确认按钮与任务卡都在视口内
        sb = sandbox.bounding_box()
        confirm_btn = page.locator('[data-testid="confirm-reroute"]').bounding_box()
        hud = page.locator('[data-testid="hud-task"]').bounding_box()
        inside = lambda box: box and box["x"] >= 0 and box["y"] >= 0 and box["x"] + box["width"] <= width and box["y"] + box["height"] <= height
        check(
            "布局：沙盘占宽 > 70% 且无裁切",
            sb is not None and sb["width"] > width * 0.7 and sb["height"] > height * 0.6,
            f"{int(sb['width'])}x{int(sb['height'])} @ {width}x{height}",
        )
        check("布局：确认改派按钮在视口内且可点", bool(inside(confirm_btn)), str(confirm_btn and [int(confirm_btn['x']), int(confirm_btn['y'])]))

        # 外部地图往返不丢进度（自有社区）
        clock_before = page.locator('[data-testid="console-clock"]').inner_text()
        page.locator('[data-testid="toggle-external"]').click()
        page.wait_for_timeout(1200)
        page.locator('[data-testid="toggle-external"]').click()
        page.wait_for_timeout(1000)
        check("外部地图往返后时钟不变", page.locator('[data-testid="console-clock"]').inner_text() == clock_before, clock_before)

        # ---------------- 地震预置演练：改派 + 接力 ----------------
        page.locator('[data-testid="open-judgement"]').click()
        page.wait_for_timeout(700)
        page.locator('[data-testid="preset-quake-relay"]').first.click()
        page.wait_for_timeout(2600)
        page.locator('[data-testid="close-drawer"]').click()
        page.wait_for_timeout(500)
        check("预置演练：顶栏标记为独立副本", "独立副本" in page.locator('[data-testid="map-source-badge"]').count().__str__() or page.get_by_text("预置演练（独立副本）").count() > 0)
        stored_during_preset = read_model(page)
        check(
            "预置演练：用户社区存储未被覆盖",
            stored_during_preset is not None and sorted(b["id"] for b in stored_during_preset["buildings"]) == a_snapshot["ids"],
            f"{len(stored_during_preset['buildings']) if stored_during_preset else 0} 栋",
        )

        preset_model = gr(page, "g.engine.view.model")
        preset_ids = sorted(b["id"] for b in preset_model["buildings"])
        check("预置演练：用的是预置社区而不是用户社区", preset_ids != a_snapshot["ids"])

        # 记录无关任务派单，用于确认前/后对比
        others_before = gr(
            page,
            """(() => { const s = g.engine.state; const t0 = s.tasks[0].id
                 return Object.fromEntries(s.tasks.filter(t => t.id !== t0).map(t => [t.id, s.assignments[t.id]])) })()""",
        )
        task_id = gr(page, "g.engine.state.tasks[0].id")
        plan_version_before = gr(page, f"(() => {{ const s = g.engine.state; return s.plans[s.assignments['{task_id}']]?.version }})()")

        # 推进到「原接驳点失效 + 候选可确认」
        confirmed = 0
        pending_seen = False
        candidate_report = None
        for _ in range(20):
            btn = page.locator('[data-testid="confirm-reroute"]')
            if not btn.is_disabled():
                if not pending_seen:
                    pending_seen = True
                    # 确认前的断言：不改派、候选不穿越封闭对象
                    candidate_report = gr(
                        page,
                        """(() => {
                          const s = g.engine.state
                          const ps = g.planSet
                          if (!ps) return null
                          const cand = ps.candidates.find(c => c.feasible)
                          const closed = Object.keys(s.closures)
                          const blockedStaging = Object.keys(s.blockedStaging)
                          const roads = cand ? (cand.legs.internal?.roadIds ?? []) : []
                          const stagingKey = cand?.legs?.internal?.stops?.find(st => st.kind === 'staging')?.nodeKey ?? ''
                          const stagingId = stagingKey.includes(':') ? stagingKey.slice(stagingKey.indexOf(':') + 1) : ''
                          const plan = s.plans[s.assignments[s.tasks[0].id]]
                          return {
                            planVersion: plan?.version, phase: plan?.phase,
                            planRoadsBeforeConfirm: plan?.legs?.internal?.roadIds ?? [],
                            candRoads: roads,
                            hitsClosed: roads.filter(r => closed.includes(r)),
                            hitsBlockedStaging: blockedStaging.includes(stagingId),
                            confirmed: ps.confirmedCandidateId,
                            candTitle: cand?.title,
                          }
                        })()""",
                    )
                    page.screenshot(path=str(OUT / f"{tag}-03-c-pending.png"))
                btn.click()
                confirmed += 1
                page.wait_for_timeout(900)
                break
            page.locator('[data-testid="step-1min"]').click()
            page.wait_for_timeout(420)

        check("C：原接驳点失效后出现可确认候选", pending_seen, str(candidate_report and candidate_report["candTitle"]))
        if candidate_report:
            check("确认之前方案没有被自动改派", candidate_report["confirmed"] is None and candidate_report["planVersion"] == plan_version_before, f"v{candidate_report['planVersion']}")
            check("候选不穿越已封闭路段", candidate_report["hitsClosed"] == [], str(candidate_report["hitsClosed"]))
            check("候选不使用已作废接驳点", candidate_report["hitsBlockedStaging"] is False, str(candidate_report["hitsBlockedStaging"]))
            check("受阻方案此刻仍未开始内部配送", candidate_report["phase"] != "delivering", str(candidate_report["phase"]))
        page.locator('[data-testid="open-judgement"]').click()
        page.wait_for_timeout(700)
        check("判据抽屉：模型层与规则层分开呈现", page.locator('[data-testid="model-runs-panel"]').count() == 1)
        page.screenshot(path=str(OUT / f"{tag}-04-c-evidence.png"))
        page.locator('[data-testid="close-drawer"]').click()
        page.wait_for_timeout(400)

        # 确认后：外部到新接驳点 → 内部接力 → 送达
        handover_shot = False
        for _ in range(40):
            # 先消化掉新出现的中断（多点断裂），再小步推进，确保拍到「真的在交接/配送」的一帧
            btn = page.locator('[data-testid="confirm-reroute"]')
            if not btn.is_disabled():
                btn.click()
                confirmed += 1
                page.wait_for_timeout(900)
            page.locator('[data-testid="step-1min"]').click()
            page.wait_for_timeout(700)
            phase = page.locator('[data-testid="hud-task"]').get_attribute("data-plan-phase")
            pending = not page.locator('[data-testid="confirm-reroute"]').is_disabled()
            if not handover_shot and not pending and phase in ("handover_wait", "delivering", "internal_ready"):
                page.screenshot(path=str(OUT / f"{tag}-05-c-handover.png"))
                handover_shot = True
            if phase == "delivered":
                break

        delivered = gr(
            page,
            f"""(() => {{ const s = g.engine.state; const pid = s.assignments['{task_id}']; const p = s.plans[pid]
                 const closed = Object.keys(s.closures)
                 return {{ phase: p?.phase, version: p?.version, deliveredAt: p?.deliveredAt,
                          taskSame: pid?.includes('{task_id}') || p?.taskId === '{task_id}',
                          legsRoads: p?.legs?.internal?.roadIds ?? [],
                          closed, relayAt: p?.relayAt,
                          record: s.record.events.filter(e => e.kind === 'plan_confirmed').length,
                          lastConfirmAt: Math.max(0, ...s.record.events.filter(e => e.kind === 'plan_confirmed').map(e => e.at)),
                          blockedEvents: s.record.events.filter(e => e.kind === 'agent_blocked').length,
                          assignments: Object.fromEntries(s.tasks.filter(t => t.id !== '{task_id}').map(t => [t.id, s.assignments[t.id]])) }} }})()""",
        )
        check("C：同一任务送达", delivered and delivered["phase"] == "delivered", str(delivered and delivered["phase"]))
        check("C：方案版本已升级（确认后改派）", delivered and delivered["version"] > (plan_version_before or 0), f"v{delivered and delivered['version']}")
        check("C：新方案不经过封闭路段", delivered and [r for r in delivered["legsRoads"] if r in delivered["closed"]] == [], str(delivered and delivered["legsRoads"]))
        check("C：确认记录已写入复盘", delivered and delivered["record"] >= 1, f"{delivered and delivered['record']} 次确认")
        check(
            "C：送达发生在最后一次人工确认之后（没有沿失效路线送完）",
            bool(delivered) and delivered["deliveredAt"] >= delivered["lastConfirmAt"],
            f"deliveredAt={delivered and delivered['deliveredAt']} lastConfirm={delivered and delivered['lastConfirmAt']}",
        )
        check(
            "C：确认后确实被后续断裂打断过（不是一路畅通）",
            bool(delivered) and delivered["blockedEvents"] >= 1,
            f"{delivered and delivered['blockedEvents']} 次受阻",
        )
        check("C：无关任务派单未被改动", delivered and delivered["assignments"] == others_before, "assignments 一致")

        # 外部地图往返（演练中）不丢选择与进度
        sel_before = gr(page, "g.planSet && g.planSet.id")
        clock_before = page.locator('[data-testid="console-clock"]').inner_text()
        page.locator('[data-testid="toggle-external"]').click()
        page.wait_for_timeout(1300)
        page.locator('[data-testid="toggle-external"]').click()
        page.wait_for_timeout(1100)
        check(
            "外部地图往返后演练进度与选择保持",
            page.locator('[data-testid="console-clock"]').inner_text() == clock_before
            and gr(page, "g.planSet && g.planSet.id") == sel_before,
            clock_before,
        )

        # 复盘：只读，不推进时钟、不改派
        clock_prev = gr(page, "g.engine.state.clock.t")
        versions_prev = gr(page, "g.engine.state.record.plans.length")
        page.locator('[data-testid="open-judgement"]').click()
        page.wait_for_timeout(800)
        replay_count = page.locator('[data-testid="replay-panel"]').count()
        page.locator('[data-testid="replay-panel"]').scroll_into_view_if_needed()
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / f"{tag}-06-replay.png"))
        check("复盘面板可见", replay_count == 1)
        check("复盘只读：时钟与方案记录未变", gr(page, "g.engine.state.clock.t") == clock_prev and gr(page, "g.engine.state.record.plans.length") == versions_prev, f"t={clock_prev}")
        total_cards = page.locator('[data-testid="replay-panel"] .task-card').count()
        if page.locator('[data-testid="replay-task-filter"]').count():
            page.locator('[data-testid="replay-task-filter"]').select_option(index=1)
            page.wait_for_timeout(400)
            filtered_cards = page.locator('[data-testid="replay-panel"] .task-card').count()
            check("复盘：可按任务筛选且记录变少", 0 < filtered_cards < total_cards, f"{filtered_cards}/{total_cards}")
            page.locator('[data-testid="replay-task-filter"]').select_option("all")
            page.wait_for_timeout(300)
            check("复盘：切回全部任务恢复完整记录", page.locator('[data-testid="replay-panel"] .task-card').count() == total_cards, f"{total_cards}")
        else:
            check("复盘：可按任务筛选", False, "缺少 replay-task-filter")
        page.locator('[data-testid="close-drawer"]').click()
        page.wait_for_timeout(400)

        # ---------------- 内涝绕行：封路 → 候选 → 确认 → 送达 ----------------
        load_preset(page, "flood-detour")
        flood_task = gr(page, "g.engine.state.tasks[0].id")
        flood = drive_drill(page)
        flood_state = gr(page, "(() => { const s = g.engine.state; const pid = s.assignments[TASKID]; const p = s.plans[pid]; const r = s.record.events; return { phase: p ? p.phase : null, version: p ? p.version : null, taskId: p ? p.taskId : null, targetDoor: p && p.legs && p.legs.internal ? p.legs.internal.targetDoor : null, agentBlocked: r.filter(e => e.kind === 'agent_blocked').length, roadClosed: r.filter(e => e.kind === 'road_closed').length } })()".replace("TASKID", repr(flood_task)))
        check("内涝演练：出现封路事件与改派候选", bool(flood["candidate"]), str(flood["candidate"] and flood["candidate"]["title"]))
        check(
            "内涝演练：人工确认后同一任务送达",
            bool(flood_state) and flood_state["phase"] == "delivered" and flood_state["taskId"] == flood_task,
            str(flood_state and flood_state["phase"]),
        )
        check("内涝演练：改派由用户确认（>=1 次）", flood["confirms"] >= 1, str(flood["confirms"]) + " 次")
        check("内涝演练：确实发生过封路事件", bool(flood_state) and flood_state["roadClosed"] > 0, str(flood_state and flood_state["roadClosed"]))
        page.screenshot(path=str(OUT / (tag + "-10-flood.png")))

        # ---------------- 火灾换入口：正门受阻 → 备用入口 ----------------
        load_preset(page, "fire-alt-door")
        fire_task = gr(page, "g.engine.state.tasks[0].id")
        fire = drive_drill(page)
        fire_state = gr(page, "(() => { const s = g.engine.state; const pid = s.assignments[TASKID]; const p = s.plans[pid]; const r = s.record.events; return { phase: p ? p.phase : null, version: p ? p.version : null, taskId: p ? p.taskId : null, targetDoor: p && p.legs && p.legs.internal ? p.legs.internal.targetDoor : null, agentBlocked: r.filter(e => e.kind === 'agent_blocked').length, roadClosed: r.filter(e => e.kind === 'road_closed').length } })()".replace("TASKID", repr(fire_task)))
        cand_door = (fire["candidate"] or {}).get("targetDoor") or ""
        plan_door = (fire_state or {}).get("targetDoor") or ""
        check("火灾演练：出现换入口候选", bool(fire["candidate"]), str(fire["candidate"] and fire["candidate"]["title"]))
        check("火灾演练：改走备用入口（entranceAlt）", cand_door.startswith("entranceAlt:") or plan_door.startswith("entranceAlt:"), cand_door or plan_door)
        check(
            "火灾演练：同一任务送达",
            bool(fire_state) and fire_state["phase"] == "delivered" and fire_state["taskId"] == fire_task,
            str(fire_state and fire_state["phase"]),
        )
        page.screenshot(path=str(OUT / (tag + "-11-fire.png")))

        # ---------------- OpenQuake 模型算例回放（只用于预置社区） ----------------
        page.locator('[data-testid="open-judgement"]').click()
        page.wait_for_timeout(700)
        case = page.locator('button[data-testid^="model-run-"]').filter(has_text=re.compile("quake|地震|OpenQuake")).first
        case_name = case.inner_text().replace("\n", " ")[:40]
        case.click()
        page.wait_for_timeout(2600)
        # 算例是从抽屉里点开的，抽屉会盖住右侧 HUD：先关掉再继续推进
        if page.locator('[data-testid="close-drawer"]').count() and page.locator('[data-testid="close-drawer"]').is_visible():
            page.locator('[data-testid="close-drawer"]').click()
            page.wait_for_timeout(500)
        check("模型算例：载入 OpenQuake 地震回放", gr(page, "g.engine.modelRun?.provenance?.model ?? null") == "openquake", str(gr(page, "g.engine.modelRun?.provenance?.caseId")))
        check(
            "模型算例：仍是预置社区（不套到用户社区）",
            sorted(b["id"] for b in gr(page, "g.engine.view.model")["buildings"]) == preset_ids,
            case_name,
        )
        for _ in range(3):
            page.locator('[data-testid="step-1min"]').click()
            page.wait_for_timeout(450)
        page.locator('[data-testid="open-judgement"]').click()
        page.wait_for_timeout(700)
        check("模型算例：判据里模型层有样例/判据行", page.locator('[data-testid="model-layer"]').count() == 1)
        # 内涝对照（Web 面板）与 npm run compare 用同一套纯函数，这里确认面板有种子/改派次数
        page.locator('[data-testid="compare-panel"]').scroll_into_view_if_needed()
        page.wait_for_timeout(400)
        compare_text = page.locator('[data-testid="compare-panel"]').inner_text()
        check(
            "对照面板：展示种子、按时完成、改派次数",
            all(k in compare_text for k in ("种子", "按时完成", "改派")),
            compare_text.replace("\n", " ")[:70],
        )
        page.screenshot(path=str(OUT / f"{tag}-07-model-evidence.png"))
        page.locator('[data-testid="close-drawer"]').click()
        page.wait_for_timeout(400)

        # ---------------- 返回我的社区 + 刷新仍是 A ----------------
        page.locator('[data-testid="back-to-my-community"]').click()
        page.wait_for_timeout(1500)
        back_model = gr(page, "null")
        a_after = read_model(page)
        check(
            "返回我的社区：恢复的仍是自建社区 A",
            a_after is not None and sorted(b["id"] for b in a_after["buildings"]) == a_snapshot["ids"],
            f"{len(a_after['buildings']) if a_after else 0} 栋",
        )
        state_after = page.evaluate(
            """() => {
              const raw = document.querySelector('[data-testid="editor-rail"]')
              return { edit: Boolean(raw) }
            }"""
        )
        check("返回我的社区：回到建模页", state_after["edit"] is True)
        page.screenshot(path=str(OUT / f"{tag}-08-back-to-my-community.png"))

        # 返回后再改一栋楼并保存，刷新必须还在（预置副本没有把 A 顶掉）
        page.locator('[data-testid="rail-step-buildings"]').first.click()
        page.wait_for_timeout(300)
        page.locator(".rail-list-row").first.click()
        page.wait_for_timeout(300)
        panel = page.locator('[data-testid="selected-building"]')
        panel.locator('input[type="number"]').first.fill("17")
        panel.get_by_role("button", name="应用").click()
        page.wait_for_timeout(700)
        edited_id = read_model(page)["buildings"][0]["id"]
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector('[data-testid="editor-rail"]', timeout=20000)
        page.wait_for_timeout(1500)
        after_reload = read_model(page)
        check(
            "返回后修改并保存：刷新仍保留这次修改",
            after_reload is not None and after_reload["buildings"][0]["floors"] == 17 and after_reload["buildings"][0]["id"] == edited_id,
            f"floors={after_reload['buildings'][0]['floors'] if after_reload else None}",
        )
        check(
            "刷新后仍是自建社区 A（楼栋与路网未变）",
            after_reload is not None
            and sorted(b["id"] for b in after_reload["buildings"]) == a_snapshot["ids"]
            and sorted(r["id"] for r in after_reload["net"]["roads"]) == a_snapshot["roadIds"],
            f"{len(after_reload['buildings']) if after_reload else 0} 栋 / {len(after_reload['net']['roads']) if after_reload else 0} 路段",
        )

        # 自有社区再次进入指挥台：社区版本变了，必须先提示「将开始新演练」
        dialog_messages.clear()
        page.get_by_role("button", name=re.compile("确认社区并进入指挥台")).first.click()
        page.wait_for_timeout(2400)
        check("首次进入 C：不弹「新演练」提示", not any("新演练" in m for m in dialog_messages), str(len(dialog_messages)))

        # 从 C 返回编辑 → 改楼栋 → 重新确认：社区版本变了，必须提示将开始新演练
        page.locator('[data-testid="back-to-edit"]').first.click()
        page.wait_for_timeout(1000)
        page.locator('[data-testid="rail-step-buildings"]').first.click()
        page.wait_for_timeout(300)
        page.locator(".rail-list-row").first.click()
        page.wait_for_timeout(300)
        panel = page.locator('[data-testid="selected-building"]')
        panel.locator('input[type="number"]').first.fill("19")
        panel.get_by_role("button", name="应用").click()
        page.wait_for_timeout(700)
        new_updated_at = read_model(page)["updatedAt"]
        dialog_messages.clear()
        page.get_by_role("button", name=re.compile("确认社区并进入指挥台")).first.click()
        page.wait_for_timeout(2400)
        check(
            "返回编辑改社区后重新确认：明确提示将开始新演练",
            any("新演练" in m for m in dialog_messages),
            (dialog_messages[-1][:70] if dialog_messages else "没有弹窗"),
        )
        check(
            "重新确认后：C 用刚保存的新版本且时钟归零",
            gr(page, "g.engine.view.model.updatedAt") == new_updated_at and gr(page, "g.engine.state.clock.t") == 0,
            f"updatedAt={new_updated_at}",
        )
        check("再次进入 C：用户社区不继承算例映射", gr(page, "Boolean(g.engine.modelRun)") is False)
        page.screenshot(path=str(OUT / f"{tag}-09-c-own-community.png"))

        # ---------------- 只有明确确认才允许用预置副本替换已有社区 ----------------
        page.locator('[data-testid="open-judgement"]').click()
        page.wait_for_timeout(700)
        page.locator('[data-testid="preset-quake-relay"]').first.click()
        page.wait_for_timeout(2600)
        page.locator('[data-testid="close-drawer"]').click()
        page.wait_for_timeout(500)
        before_adopt = read_model(page)
        page.locator('[data-testid="adopt-preset-community"]').click()
        page.wait_for_timeout(1400)
        after_adopt = read_model(page)
        check(
            "复制为我的社区：确认后才替换存储",
            after_adopt is not None
            and sorted(b["id"] for b in after_adopt["buildings"]) != sorted(b["id"] for b in before_adopt["buildings"]),
            f"{len(after_adopt['buildings']) if after_adopt else 0} 栋",
        )
        check("复制为我的社区：回到建模页", page.locator('[data-testid="editor-rail"]').count() == 1)

        # ---------------- A：双击结束并保存围栏 ----------------
        # 回归点：双击曾被高德当成缩放手势（页面像被刷新），并且两下 click 会多塞顶点。
        # 相机固定到 16 级：比例坐标对应的地理尺寸可控，两档分辨率都能画出合法面积
        page.evaluate("() => window.__geoMap.flyTo(window.__geoMap.getCenter(), 16)")
        page.wait_for_timeout(1600)
        click_fence_step_button(page, "绘制")
        page.wait_for_timeout(500)
        tri = map_screen_points(page, [[0.42, 0.62], [0.58, 0.62], [0.5, 0.42], [0.5, 0.55]])
        for q in tri[:3]:
            page.mouse.click(q["x"], q["y"])
            page.wait_for_timeout(600)
        drawn = fence_state(page)
        page.evaluate("() => { window.__no_reload = 'alive' }")
        frame_events.clear()
        err_before = len(errors)
        page.mouse.click(tri[3]["x"], tri[3]["y"], click_count=2, delay=50)
        page.wait_for_timeout(2200)
        # 保存后步骤会自动收起，重新展开才能读到「编辑顶点」态
        open_fence_step(page)
        saved = fence_state(page)
        check(
            "A：双击结束绘制不刷新页面",
            page.url == URL and saved["alive"] == "alive" and frame_events == [] and len(errors) == err_before,
            f"url={page.url} navs={frame_events[:1]} errs={errors[err_before:err_before + 1]}",
        )
        check("A：双击保存的围栏正好 3 个顶点（不会变 5）", saved["saved_verts"] == 3, f"{saved['saved_verts']} 个顶点")
        check(
            "A：双击后围栏面积正常显示且步骤打勾",
            saved["saved_area"] > 0 and saved["fence_head"].startswith("✓") and "m²" in saved["fence_head"],
            saved["fence_head"],
        )
        # 步骤头折叠态不同（▸/▾），只比面积数字：一致才说明双击没追加顶点
        drawn_area = re.search(r"([\d,]+) m²", drawn["fence_head"])
        saved_head_area = re.search(r"([\d,]+) m²", saved["fence_head"])
        check(
            "A：双击没有改动三个单击顶点的几何",
            drawn_area is not None and saved_head_area is not None and drawn_area.group(1) == saved_head_area.group(1),
            f"{drawn['fence_head']} vs {saved['fence_head']}",
        )
        check("A：保存成功后进入编辑顶点态", saved["edit_active"] and "保存围栏" in saved["step_notice"], saved["step_notice"][:60])
        zoom_before = page.evaluate("() => window.__geoMap.getZoom()")
        page.mouse.click(tri[3]["x"], tri[3]["y"], click_count=2, delay=50)
        page.wait_for_timeout(1500)
        zoom_after = page.evaluate("() => window.__geoMap.getZoom()")
        check("A：双击不会缩放地图（双击缩放已关闭）", zoom_before == zoom_after, f"zoom {zoom_before} → {zoom_after}")
        page.screenshot(path=str(OUT / f"{tag}-10-fence-dblclick.png"))

        # 顶点不足 3 个：双击只报错，草稿与绘制态都不动
        click_fence_step_button(page, "重画")
        page.wait_for_timeout(600)
        for q in tri[:2]:
            page.mouse.click(q["x"], q["y"])
            page.wait_for_timeout(600)
        page.mouse.click(tri[2]["x"], tri[2]["y"], click_count=2, delay=50)
        page.wait_for_timeout(1500)
        bad = fence_state(page)
        check(
            "A：不足 3 顶点时双击只报错不保存",
            "至少需要 3 个顶点" in bad["top_notice"] and bad["saved_verts"] == 0,
            bad["top_notice"][:70],
        )
        check(
            "A：不足 3 顶点时双击不追加顶点且仍在绘制态",
            "已放置 2 个顶点" in bad["step_notice"] and bad["draw_active"] is True,
            bad["step_notice"][:70],
        )

        check("全流程无 JS 运行时错误", errors == [], " / ".join(errors[:3]))
        browser.close()


def main() -> int:
    only = None
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1]
    targets = [(1440, 900, "1440x900"), (1280, 800, "1280x800")]
    for w, h, tag in targets:
        if only and only not in tag:
            continue
        print(f"\n=== {tag} ===")
        run(w, h, tag)
    passed = sum(1 for _, ok, _ in results if ok)
    failed = [(n, d) for n, ok, d in results if not ok]
    print(f"\n通过 {passed} · 失败 {len(failed)}")
    for n, d in failed:
        print(f"  FAIL {n}  [{d}]")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
