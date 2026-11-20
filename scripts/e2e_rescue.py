import json
import pathlib
import re
import sys
from playwright.sync_api import sync_playwright, expect

URL = 'http://127.0.0.1:5173/'
STORAGE = 'georelay.community.v2'
OUT = pathlib.Path('artifacts')
passed = 0


def check(label, condition):
    global passed
    assert condition, label
    passed += 1
    print(f'PASS {label}', flush=True)


def model(page):
    return page.evaluate(f'JSON.parse(localStorage.getItem("{STORAGE}"))')


def state(page, expression):
    return page.evaluate(f'() => {{ const s = window.__gr.engine.state; return {expression}; }}')


def step(page, name):
    head = page.get_by_test_id(f'rail-step-{name}')
    if head.get_attribute('aria-expanded') != 'true':
        head.click()
    return head.locator('..')


def map_points(page):
    return page.evaluate('''() => {
      const r = document.querySelector('.map-host').getBoundingClientRect();
      return [[.4,.4],[.6,.4],[.6,.6],[.4,.6]].map(([x,y]) => [r.x+r.width*x,r.y+r.height*y]);
    }''')


def run(browser, width, height, fallback):
    context = browser.new_context(viewport={'width': width, 'height': height}, permissions=['geolocation'], geolocation={'latitude': 31.2304, 'longitude': 121.4737, 'accuracy': 15})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    if fallback:
        page.route('**/api/amap/config', lambda r: r.fulfill(json={'ok': False, 'webKey': None}))
    page.goto(URL, wait_until='domcontentloaded')
    page.wait_for_function('window.__geoMap !== undefined')
    map_kind = page.evaluate('window.__geoMap.kind')
    print(f'{width}: map adapter = {map_kind}', flush=True)
    page.wait_for_timeout(500)
    rail = page.get_by_test_id('rail-locate')
    expect(rail).to_be_visible()
    rail.get_by_role('button', name='定位到我', exact=True).click()
    page.wait_for_function(f'JSON.parse(localStorage.getItem("{STORAGE}")).address === "浏览器定位"')
    check(f'{width}: locate updates saved readiness', '1/4' in page.locator('.rail-dash-progress').inner_text())
    check(f'{width}: locating advances to fence step', page.get_by_test_id('rail-step-fence').get_attribute('aria-expanded') == 'true')

    page.route('**/api/amap/geocode', lambda r: r.fulfill(json={'ok': True, 'lngLat': [121.47,31.23], 'formatted': '浏览器测试社区'}))
    rail.get_by_role('textbox').fill('浏览器测试社区')
    rail.get_by_role('textbox').press('Enter')
    page.wait_for_function(f'JSON.parse(localStorage.getItem("{STORAGE}")).address.includes("浏览器测试社区")')
    check(f'{width}: address search saves location', '浏览器测试社区' in model(page)['address'])
    page.reload(wait_until='domcontentloaded')
    page.wait_for_function('window.__geoMap !== undefined')
    check(f'{width}: location survives reload', '浏览器测试社区' in model(page)['address'])
    saved_location = model(page)['center']
    page.route('**/api/amap/geocode', lambda r: r.fulfill(json={'ok': False}))
    rail.get_by_role('textbox').fill('不存在的测试地址')
    rail.get_by_role('textbox').press('Enter')
    expect(page.locator('.map-notice-stack .notice')).to_contain_text('没有找到')
    check(f'{width}: failed search preserves saved location', model(page)['center'] == saved_location)
    page.evaluate('''() => {
      window.savedGeo = navigator.geolocation.getCurrentPosition;
      navigator.geolocation.getCurrentPosition = (_, fail) => fail({code:1, PERMISSION_DENIED:1});
    }''')
    rail.get_by_role('button', name='定位到我', exact=True).click()
    expect(page.locator('.map-notice-stack .notice')).to_contain_text('定位权限被拒绝')
    check(f'{width}: denied location remains recoverable', model(page)['center'] == saved_location)
    page.evaluate('() => { navigator.geolocation.getCurrentPosition = window.savedGeo; }')

    fence = step(page, 'fence')
    fence.get_by_role('button', name='绘制', exact=True).click()
    points = map_points(page)
    for p in points:
        page.mouse.click(*p)
        page.wait_for_timeout(80)
    expect(page.get_by_test_id('fence-live').locator('b').first).to_have_text('4')
    check(f'{width}: valid draft is not confirmed progress', '1/4' in page.locator('.rail-dash-progress').inner_text())
    page.get_by_role('button', name='撤销顶点', exact=True).click()
    expect(page.get_by_test_id('fence-live').locator('b').first).to_have_text('3')
    check(f'{width}: undo updates both point displays', '3 顶点' in page.get_by_test_id('fence-toolbar').inner_text())
    for _ in range(3):
        page.get_by_role('button', name='撤销顶点', exact=True).click()
    expect(page.get_by_test_id('fence-live').locator('b').first).to_have_text('0')
    check(f'{width}: removing all points clears draft area', page.get_by_test_id('fence-live').locator('b').nth(2).inner_text() == '—')
    page.mouse.click(*points[0])
    page.keyboard.press('Backspace')
    page.wait_for_timeout(400)
    expect(page.get_by_test_id('fence-live').locator('b').first).to_have_text('0')
    check(f'{width}: cancelled pending click does not return', True)
    for p in points:
        page.mouse.click(*p)
        page.wait_for_timeout(320)
    page.get_by_test_id('fence-toolbar').get_by_role('button', name=re.compile('^完成')).click()
    page.wait_for_function(f'JSON.parse(localStorage.getItem("{STORAGE}")).fence.polygon.length === 4')
    check(f'{width}: saving advances to buildings', page.get_by_test_id('rail-step-buildings').get_attribute('aria-expanded') == 'true')
    expect(page.get_by_role('button', name='批量生成楼栋', exact=True)).to_be_enabled()
    page.get_by_role('button', name='批量生成楼栋', exact=True).click()
    page.wait_for_function(f'JSON.parse(localStorage.getItem("{STORAGE}")).buildings.length > 0')
    check(f'{width}: next step is usable after undo and save', True)

    page.get_by_test_id('rail-locate').get_by_role('button', name='载入演示社区').click()
    saved = model(page)['fence']
    fence = step(page, 'fence')
    fence.get_by_role('button', name='绘制', exact=True).click()
    expect(page.get_by_test_id('fence-live').locator('b').first).to_have_text('0')
    check(f'{width}: redraw does not inherit saved area', page.get_by_test_id('fence-live').locator('b').nth(2).inner_text() == '—')
    page.get_by_test_id('fence-toolbar').get_by_role('button', name=re.compile('^退出')).click()
    check(f'{width}: exiting draft preserves confirmed fence', model(page)['fence'] == saved)

    network = step(page, 'network')
    network.get_by_role('button', name='画路段', exact=True).click()
    points = map_points(page)
    page.mouse.move(*points[0])
    page.mouse.down()
    page.mouse.move(*points[1], steps=4)
    page.mouse.up()
    expect(page.get_by_test_id('road-live').locator('b')).to_have_text('0')
    check(f'{width}: panning does not add a road point', True)
    for p in points[:2]:
        page.mouse.click(*p)
    expect(page.get_by_test_id('road-live').locator('b')).to_have_text('2')
    network.get_by_role('button', name='取消点', exact=True).click()
    expect(page.get_by_test_id('road-live').locator('b')).to_have_text('1')
    expect(network.get_by_role('button', name='完成路段')).to_be_disabled()
    check(f'{width}: road undo updates progress and disables finish', '1 个端点' in page.get_by_test_id('rail-step-network').inner_text())
    network.get_by_role('button', name='取消', exact=True).click()
    check(f'{width}: cancelling road restores readiness', '4/4' in page.locator('.rail-dash-progress').inner_text())
    expect(page.get_by_test_id('resilience-panel')).to_have_count(0)
    expect(page.get_by_test_id('agent-planning')).to_have_count(0)
    layers = page.get_by_role('complementary', name='地图图层')
    expect(layers).to_contain_text('已就绪')
    layer_toggle = layers.get_by_role('button', name='背景楼块')
    layer_state = layer_toggle.get_attribute('aria-pressed')
    layer_toggle.click()
    expect(layer_toggle).to_have_attribute('aria-pressed', 'false' if layer_state == 'true' else 'true')
    layer_toggle.click()
    map_box = page.locator('.map-host').bounding_box()
    tools_box = page.get_by_test_id('editor-rail').bounding_box()
    layers_box = layers.bounding_box()
    check(f'{width}: editor map sits between the two panels', tools_box['x'] + tools_box['width'] <= map_box['x'] and map_box['x'] + map_box['width'] <= layers_box['x'])
    check(f'{width}: locate controls remain onscreen while scrolling', rail.bounding_box()['y'] > 0 and rail.bounding_box()['y'] + rail.bounding_box()['height'] < height)
    check(f'{width}: rail sections do not collapse to clipped rows', page.locator('.rail-step').evaluate_all('(xs) => xs.every(x => x.getBoundingClientRect().height >= 30)'))
    page.screenshot(path=str(OUT / f'rescue-{width}-editor.png'))

    page.get_by_test_id('confirm-community').click()
    page.wait_for_selector('[data-testid="sandbox"]', timeout=30000)
    expect(page.locator('.scene-transition')).to_have_count(0)
    if page.get_by_role('button', name='暂停', exact=True).count():
        page.get_by_role('button', name='暂停', exact=True).click()
    for selector in ['.dispatch-decision-state', '#rescue-live-heading', '.rescue-weakness-heading', '.rescue-actions-heading', '[data-testid="responder-status"]']:
        rect = page.locator(selector).bounding_box()
        check(f'{width}: {selector} is on the first screen', rect and rect['y'] >= 0 and rect['y'] + rect['height'] < height)
    page.screenshot(path=str(OUT / f'rescue-{width}-dashboard.png'))
    expect(page.get_by_test_id('hud-legend')).to_contain_text('社区内部志愿者')
    expect(page.get_by_test_id('hud-legend')).to_contain_text('外部志愿者')
    expect(page.get_by_test_id('hud-legend')).to_contain_text('消防员')
    check(f'{width}: roles have visible legend descriptions', True)
    expect(page.locator('.sandbox-svg [data-layer="occupancy"]')).to_have_count(12)
    check(f'{width}: sandbox shows each building population', True)
    for _ in range(15):
        if state(page, 's.responders.length'):
            break
        before = state(page, 's.clock.t')
        page.get_by_test_id('step-1min').click()
        page.wait_for_function(f'window.__gr.engine.state.clock.t >= {before + 60}')
        page.wait_for_timeout(150)
    check(f'{width}: actual hazard dispatches firefighter', state(page, 's.responders.length') == 1)
    expect(page.get_by_test_id('toggle-external')).to_have_text('回到白模沙盘')
    check(f'{width}: dispatch switches to external view', True)
    r = state(page, 's.responders[0]')
    check(f'{width}: speed is assumed 80km/h', abs(r['speedMps'] * 3.6 - 80) < 0.0001)
    if map_kind == 'amap':
        expect(page.locator('.map-marker.agent-firefighter')).to_be_visible()
        expect(page.locator('.map-marker.agent-firefighter .marker-dot')).to_have_css('background-color', 'rgb(255, 148, 120)')
        check(f'{width}: map firefighter label and distinct color', True)
        expect(page.locator('.map-marker.agent-external .marker-dot').first).to_have_css('background-color', 'rgb(117, 191, 255)')
        check(f'{width}: external and internal colors are distinct', True)
    page.get_by_test_id('follow-response').click()
    expect(page.get_by_test_id('follow-response')).to_have_attribute('aria-pressed', 'true')
    paused = state(page, 's.responders[0].position')
    page.wait_for_timeout(500)
    check(f'{width}: paused clock freezes firefighter position', state(page, 's.responders[0].position') == paused)
    page.screenshot(path=str(OUT / f'rescue-{width}-dispatch.png'))
    before = state(page, 's.clock.t')
    page.get_by_test_id('step-1min').click()
    page.wait_for_function(f'window.__gr.engine.state.clock.t >= {before + 60}')
    r2 = state(page, 's.responders[0]')
    check(f'{width}: stepping moves firefighter with clock', r2['progress'] > r['progress'])
    for _ in range(15):
        if state(page, 's.responders[0].status') == 'arrived':
            break
        before = state(page, 's.clock.t')
        page.get_by_test_id('step-1min').click()
        page.wait_for_function(f'window.__gr.engine.state.clock.t >= {before + 60}')
    check(f'{width}: firefighter reaches the assembly point', state(page, 's.responders[0].status') == 'arrived')
    check(f'{width}: arrival preserves hazard evidence', state(page, 'Object.keys(s.impacts).length') > 0)
    expect(page.get_by_test_id('sandbox')).to_be_visible()
    check(f'{width}: firefighter arrival returns to the sandbox', page.get_by_test_id('toggle-external').inner_text().strip() == '外部支援地图')
    check(f'{width}: arrived firefighter appears with sandbox label', page.locator('.sandbox-svg text').filter(has_text='消防已到场').count() == 1)
    page.screenshot(path=str(OUT / f'rescue-{width}-arrived.png'))
    panel = page.get_by_test_id('resilience-panel')
    expect(panel.get_by_text('救援建议', exact=True)).to_be_visible()
    focus = panel.get_by_role('button', name=re.compile('^定位 ')).first
    if focus.count():
        focus.click()
        expect(focus).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('.sandbox-svg [data-layer="risk"]').first).to_be_visible()
        focus.click()
    page.route('**/api/ai/analyze', lambda route: route.fulfill(json={
        'ok': True, 'mode': 'mock', 'items': [], 'summary': '优先核对受阻楼栋的备用通道。',
    }))
    page.get_by_test_id('open-analysis').click()
    expect(page.get_by_test_id('rescue-analysis-progress')).to_be_visible()
    expect(panel.get_by_text('优先核对受阻楼栋的备用通道。')).to_be_visible(timeout=15000)
    expect(page.get_by_test_id('rescue-analysis-progress')).to_have_count(0, timeout=6000)
    expect(panel.get_by_text('优先核对受阻楼栋的备用通道。')).to_be_visible()
    page.unroute('**/api/ai/analyze')
    page.route('**/api/ai/analyze', lambda route: route.fulfill(status=503, json={'ok': False}))
    rules = panel.locator('.rescue-actions-heading span').inner_text()
    page.get_by_test_id('open-analysis').click()
    expect(panel.get_by_text('AI 暂不可用，请查看规则建议')).to_be_visible()
    expect(panel.locator('.rescue-actions-heading span')).to_have_text(rules)
    page.unroute('**/api/ai/analyze')
    page.get_by_text('评估指标与口径', exact=True).click()
    expect(page.get_by_test_id('resilience-panel')).to_contain_text('随当前封路')
    check(f'{width}: console analysis includes live hazard state', True)
    page.screenshot(path=str(OUT / f'rescue-{width}-analysis.png'))
    if page.get_by_test_id('confirm-reroute').is_enabled():
        page.get_by_test_id('open-judgement').click()
        page.get_by_test_id('confirm-reroute').click(trial=True)
        page.get_by_test_id('close-drawer').click()
        check(f'{width}: judgement drawer does not cover reroute confirmation', True)
    page.get_by_role('button', name='重置演练', exact=True).click()
    page.wait_for_function('window.__gr.engine.state.responders.length === 0')
    expect(page.get_by_test_id('responder-status')).to_contain_text('待命')
    check(f'{width}: reset clears firefighter state and status', True)
    page.get_by_test_id('toggle-external').click()
    page.get_by_test_id('open-judgement').click()
    page.once('dialog', lambda dialog: dialog.accept())
    page.get_by_test_id('preset-quake-relay').click()
    expect(page.get_by_test_id('preset-hint')).to_contain_text('地震')
    check(f'{width}: preset controls remain usable in the external view', True)
    await_map = page.get_by_role('group', name='指挥地图底图')
    expect(page.locator('.scene-transition')).to_have_count(0)
    sandbox_button = await_map.get_by_role('button', name='白模沙盘', exact=True)
    geo_button = await_map.get_by_role('button', name='高德白模' if map_kind == 'amap' else '地理示意图', exact=True)
    sandbox_button.click()
    clock_controls = page.get_by_test_id('agent-planning').get_by_role('group', name='演练时钟')
    expect(clock_controls.get_by_test_id('step-1min')).to_be_visible()
    expect(page.locator('.topbar').get_by_test_id('step-1min')).to_have_count(0)
    expect(page.get_by_role('region', name='调度动态')).to_be_visible()

    # Close the fixture road network while paused to exercise isolated-building overlays on both adapters.
    page.evaluate("""() => {
        const { state, view } = window.__gr.engine;
        state.clock.running = false;
        for (const road of view.model.net.roads) state.closures[road.id] = { roadId: road.id };
    }""")
    clock_controls.get_by_role('combobox', name='演练速度').select_option('2')
    expect(page.locator('.sandbox-svg polygon[data-layer="risk"]').first).to_be_visible()
    expect(page.locator('.sandbox-svg text').filter(has_text='图上孤岛').first).to_be_visible()
    focus_controls = page.get_by_role('group', name='沙盘视图')
    map_scene = page.locator('.sandbox-svg')
    expect(map_scene.locator('polygon[data-layer="urgency"]').first).to_be_visible()
    expect(map_scene.locator('polyline[data-layer="dispatch"]').first).to_be_visible()
    for label in ['物资', '撤离', '灾情', '态势']:
        focus_controls.get_by_role('button', name=label, exact=True).click()
        expect(map_scene.locator('polygon[data-layer="risk"]').first).to_be_visible()
        expect(map_scene.locator('polyline[data-layer="dispatch"]').first).to_be_visible()
    timestamp = page.get_by_test_id('console-clock').inner_text()
    page.screenshot(path=str(OUT / f'rescue-{width}-sandbox-risk.png'), animations='disabled')
    geo_button.click()
    expect(geo_button).to_have_attribute('aria-pressed', 'true')
    expect(page.get_by_test_id('sandbox')).to_have_count(0)
    expect(page.get_by_test_id('console-clock')).to_have_text(timestamp)
    expect(focus_controls.get_by_role('button', name='物资', exact=True)).to_be_visible()
    if map_kind == 'amap':
        expect(page.locator('.map-host').get_by_text(re.compile('图上孤岛')).first).to_be_visible()
        page.wait_for_timeout(650)
        page.screenshot(path=str(OUT / f'rescue-{width}-amap-risk.png'), animations='disabled')
    sandbox_button.click()
    expect(page.locator('.sandbox-svg polygon[data-layer="risk"]').first).to_be_visible()
    expect(page.get_by_test_id('console-clock')).to_have_text(timestamp)
    check(f'{width}: live weaknesses persist when switching map views', True)

    page.get_by_test_id('close-drawer').click()
    page.get_by_role('button', name='查看防灾建设评估').click()
    prevention = page.get_by_test_id('prevention-panel')
    expect(prevention).to_contain_text('无灾基线')
    first_location = prevention.get_by_role('button', name=re.compile('图上定位')).first
    first_location.click()
    expect(page.locator('.sandbox-svg [data-layer="closure"], .sandbox-svg [data-layer="risk"]').first).to_be_visible()
    page.screenshot(path=str(OUT / f'rescue-{width}-prevention.png'), animations='disabled')
    page.get_by_role('button', name='返回实时救援研判').click()
    page.get_by_role('combobox', name='专业救援策略').select_option('vulnerable')
    page.get_by_role('combobox', name='消防力量配置').select_option('2')
    page.evaluate("""() => {
        const { state, view } = window.__gr.engine;
        view.model.buildings.at(-1).vulnerable = 2;
        for (const building of view.model.buildings) {
            state.blockedDoors['entrance:' + building.id] = {};
        }
    }""")
    page.get_by_test_id('order-all-rescue').click()
    if state(page, 's.responders.length') == 0:
        page.get_by_test_id('step-1min').click()
        page.wait_for_function('window.__gr.engine.state.responders.length === 2')
    check(f'{width}: dual configuration dispatches two units', state(page, 's.responders.length') == 2)
    priority_building = page.evaluate('window.__gr.engine.view.model.buildings.at(-1).id')
    for _ in range(8):
        events = state(page, "s.events.filter(event => event.kind === 'rescue_assigned')")
        if len(events) >= 2:
            break
        page.get_by_test_id('step-1min').click()
        page.wait_for_function("!['impact', 'routes', 'rank'].includes(window.__gr.engine.planning?.stage)")
    check(f'{width}: joint response assigns distinct teams and prioritizes marked households',
          len(events) >= 2 and events[0]['refs']['buildingId'] == priority_building
          and len({event['refs']['responderIds'][0] for event in events[:2]}) == 2
          and len({event['refs']['buildingId'] for event in events[:2]}) == 2)
    check(f'{width}: no browser exceptions', not errors)
    context.close()


with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    for width, height in [(1440,900),(1280,800),(1920,1080)]:
        if len(sys.argv) > 1 and str(width) != sys.argv[1]:
            continue
        try:
            run(browser, width, height, width == 1280)
        except Exception:
            for context in browser.contexts:
                for page in context.pages:
                    page.screenshot(path=str(OUT / f'rescue-{width}-failure.png'))
                    print(page.locator('body').inner_text()[:1800], flush=True)
            raise
    browser.close()
print(f'Rescue browser checks: {passed} passed')
