import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "播放/暂停", exact: true })).toBeEnabled();
}

test("home follows the system theme and opens files from the logo and transport", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await ready(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".video-canvas")).toHaveCSS("visibility", "hidden");
  await expect(page.getByRole("contentinfo", { name: "播放控制" })).toBeVisible();
  for (const label of ["打开文件", "播放/暂停"]) {
    const choosing = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: label, exact: true }).click();
    await (await choosing).setFiles([]);
  }
  await page.locator(".video-frame").focus();
  const choosing = page.waitForEvent("filechooser");
  await page.keyboard.press("Control+o");
  await (await choosing).setFiles([]);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("nested menus support keyboard navigation and persist an explicit theme", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "主题", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("menuitemradio", { name: "跟随系统", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "主题", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("menuitemradio", { name: "深色", exact: true }).click();
  await expect(page.locator(".player-menu")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "更多", exact: true })).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // Preference writes are debounced by the controller. Wait for the durable
  // value before simulating a restart, rather than racing its save timer.
  await expect.poll(() => page.evaluate(() => new Promise<string | undefined>((resolve, reject) => {
    const opening = indexedDB.open("wasm-player");
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const reading = db.transaction("state").objectStore("state").get("player");
      reading.onsuccess = () => { resolve(reading.result?.globalSettings?.["app.theme"]); db.close(); };
      reading.onerror = () => { reject(reading.error); db.close(); };
    };
  }))).toBe("dark");
  await page.reload();
  await expect(page.getByRole("button", { name: "播放/暂停", exact: true })).toBeEnabled();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("URL dialog traps focus and dismisses with Escape", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "打开链接…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "打开链接", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("视频地址")).toBeFocused();
  for (let index = 0;index < 6;index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "更多", exact: true })).toBeFocused();
});

test("settings isolate playback shortcuts and the bottom library preserves the video size", async ({ page }) => {
  await ready(page);
  await page.locator('input[type="file"]').first().setInputFiles(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await expect(page.locator(".title")).toHaveText("sample-h264-aac.mp4");
  await expect(page.getByRole("slider", { name: "播放进度" })).toBeVisible();
  const canvas = page.locator(".video-canvas");
  const before = await canvas.boundingBox();
  const progress = await page.getByRole("slider", { name: "播放进度" }).inputValue();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await page.getByRole("tab", { name: "播放", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("tab", { name: "画面", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("tab", { name: "播放", exact: true })).toBeFocused();
  await dialog.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  await page.keyboard.press("f");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("slider", { name: "播放进度" })).toHaveValue(progress);
  expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "媒体库", exact: true }).click();
  const panel = await page.getByRole("complementary", { name: "媒体库" }).boundingBox();
  expect(await canvas.boundingBox()).toEqual(before);
  expect(panel?.width).toBe(before?.width);
  expect(Math.abs((panel!.y + panel!.height) - (before!.y + before!.height))).toBeLessThan(1);
  await page.getByRole("button", { name: "关闭媒体库" }).click();
  await canvas.click({ button: "right", position: { x: 200, y: 100 } });
  await expect(page.getByRole("menuitem", { name: "画面", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".player-menu")).toHaveCount(0);
});

test("narrow windows keep the timeline, tools and settings within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await ready(page);
  await page.locator('input[type="file"]').first().setInputFiles(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await expect(page.getByRole("slider", { name: "播放进度" })).toBeVisible();
  const timeline = await page.locator(".playback-timeline").boundingBox();
  const tools = await page.locator(".controls-right").boundingBox();
  expect(timeline!.y + timeline!.height).toBeLessThanOrEqual(tools!.y);
  expect(tools!.x + tools!.width).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "画面", exact: true }).click();
  await expect(page.getByRole("slider", { name: "亮度", exact: true })).toBeVisible();
  expect(await page.locator(".settings-dialog").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.locator(".settings-scroll").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
