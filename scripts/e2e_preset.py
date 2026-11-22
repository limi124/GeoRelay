"""Desktop editor-to-console and preset persistence regression."""

import os

from playwright.sync_api import expect, sync_playwright

from e2e_check import read_model


def enter_console(page):
    page.get_by_test_id("confirm-community").click()
    expect(page.get_by_test_id("open-judgement")).to_be_visible()


def load_preset(page):
    page.get_by_test_id("open-judgement").click()
    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_test_id("preset-flood-detour").click()
    expect(page.get_by_text("预置演练（独立副本）", exact=True)).to_be_visible()
    page.get_by_test_id("close-drawer").click()


def main():
    with sync_playwright() as playwright:
        channel = os.getenv("GEORELAY_CHROMIUM_CHANNEL", "chromium")
        browser = playwright.chromium.launch(channel=channel)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(os.getenv("GEORELAY_BASE_URL", "http://127.0.0.1:8791"))
        page.get_by_role("button", name="载入演示社区").click()
        expect(page.get_by_text("已载入演示社区", exact=False)).to_be_visible()
        page.get_by_role("button", name="增加每层户数").click()
        enter_console(page)
        original = read_model(page)
        assert original and original["buildings"] and original["net"]["roads"]
        assert original["unitsPerFloor"] == 5

        load_preset(page)
        assert read_model(page) == original
        page.once("dialog", lambda dialog: dialog.dismiss())
        page.get_by_test_id("adopt-preset-community").click()
        assert read_model(page) == original
        page.get_by_test_id("back-to-my-community").click()
        expect(page.get_by_test_id("confirm-community")).to_be_visible()
        assert read_model(page) == original
        page.reload()
        enter_console(page)
        assert read_model(page) == original

        load_preset(page)
        page.get_by_test_id("open-judgement").click()
        page.get_by_role("button", name="返回编辑", exact=True).click()
        expect(page.get_by_text("已回到「", exact=False)).to_be_visible()
        expect(page.get_by_role("group", name="每层户数")).to_contain_text("5")
        assert read_model(page) == original
        page.reload()
        enter_console(page)

        load_preset(page)
        assert read_model(page) == original
        page.once("dialog", lambda dialog: dialog.accept())
        page.get_by_test_id("adopt-preset-community").click()
        expect(page.get_by_test_id("confirm-community")).to_be_visible()
        adopted = read_model(page)
        assert adopted and adopted["buildings"][0]["id"].startswith("bld-preset")
        assert adopted["buildings"] != original["buildings"]
        page.reload()
        enter_console(page)
        assert read_model(page) == adopted
        assert not errors, errors
        print("Desktop preset persistence: cancel, return, reload and confirmed adoption passed")


if __name__ == "__main__":
    main()
