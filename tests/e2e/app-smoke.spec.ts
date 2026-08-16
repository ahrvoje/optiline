import { expect, test } from "@playwright/test";

test("loads the PH catalog and enables only certified actions", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator(".track-card")).toHaveCount(6);
  await expect(page.locator("#track-name")).not.toHaveText("—");
  await expect(page.locator("#engine-status")).toContainText("Certified", {
    timeout: 30_000,
  });

  const play = page.locator("#play-button");
  const save = page.locator("#save-button");
  await expect(play).toBeEnabled();
  await expect(save).toBeEnabled();
  await expect(page.locator("#optimize-button")).toBeEnabled();
  await expect(page.locator("#settings-grid .setting:last-child select")).toHaveAttribute(
    "id",
    "setting-run-mode",
  );
  await expect(page.locator("#setting-run-mode")).toHaveValue("random");
  await page.locator("#setting-run-mode").selectOption("deterministic");
  await expect(page.locator("#setting-run-mode")).toHaveValue("deterministic");

  const trackBox = await page.locator("#track-canvas").boundingBox();
  const chartBox = await page.locator("#profile-canvas").boundingBox();
  expect(trackBox).not.toBeNull();
  expect(chartBox).not.toBeNull();
  expect(chartBox!.width).toBeGreaterThan(trackBox!.width * 1.5);
  expect(chartBox!.width).toBeGreaterThan(1_300);

  await page.locator("#profile-axis-select").selectOption("distance");
  await page.mouse.move(chartBox!.x + chartBox!.width * 0.55, chartBox!.y + 100);
  await page.mouse.down();
  await page.mouse.move(chartBox!.x + chartBox!.width * 0.72, chartBox!.y + 100, { steps: 8 });
  const firstDraggedMark = await page.locator("#engine-status").textContent();
  await page.mouse.move(chartBox!.x + chartBox!.width * 0.82, chartBox!.y + 100, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#engine-status")).toContainText("Profile mark");
  expect(await page.locator("#engine-status").textContent()).not.toBe(firstDraggedMark);

  await play.click();
  await expect(play).toContainText("PAUSE");
  await page.locator("#zoom-button").click();
  await expect(page.locator("#zoom-button")).toHaveAttribute("aria-pressed", "true");

  await save.click();
  await expect(page.locator("#saved-count")).toHaveText("1");
  await expect(page.locator("#saved-list .saved-item")).toHaveCount(1);
  await page.locator("#saved-list .delete-profile").click();
  await expect(page.locator("#saved-count")).toHaveText("0");

  await page.locator("#setting-massKg").fill("500");
  await page.locator("#setting-massKg").press("Tab");
  await expect(page.locator("#optimize-button")).toBeEnabled();
  await page.locator("#optimize-button").click();
  await expect(page.locator("#optimize-button")).toHaveText("STOP");
  await expect(page.locator("#work-overlay")).toContainText("OPTIMIZING");
  await page.locator("#optimize-button").click();
  await expect(page.locator("#engine-status")).toContainText("Stopped", { timeout: 30_000 });

  await page.locator("#reset-button").click();
  await expect(page.locator("#setting-massKg")).toHaveValue("900");
  await expect(page.locator("#setting-run-mode")).toHaveValue("random");
  await page.locator("#setting-massKg").hover();
  await page.mouse.wheel(0, -100);
  await expect(page.locator("#setting-massKg")).toHaveValue("910");
});
