import { expect, test } from "@playwright/test";

test("creates, persists, renames, edits, and deletes a custom oval", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".track-card")).toHaveCount(6);

  await page.locator("#new-track-button").click();
  await expect(page.locator(".track-card")).toHaveCount(7);
  await expect(page.locator("#track-name")).toHaveText("Custom #1");
  await expect(page.locator("#track-editor")).toBeVisible();
  await expect(page.locator("#track-canvas")).toHaveClass(/editing/);

  await page.locator("#track-editor-name").fill("Test Oval");
  await page.locator("#track-editor-name").press("Tab");
  await expect(page.locator("#track-name")).toHaveText("Test Oval");
  await expect(page.locator(".track-card", { hasText: "Test Oval" })).toHaveCount(1);

  // Move the rightmost oval node; pointer-up compiles and persists a new revision.
  const box = await page.locator("#track-canvas").boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.86, box!.y + box!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.89, box!.y + box!.height * 0.46, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("#track-editor")).toBeVisible();

  await expect(page.locator("#engine-status")).toContainText("Certified", { timeout: 30_000 });
  await page.locator("#save-button").click();
  await expect(page.locator("#saved-count")).toHaveText("1");
  await page.locator("#track-editor-done").click();
  await expect(page.locator("#track-editor")).toBeHidden();

  // Editing a custom track with a saved profile must fork a new instance.
  await page.locator(".track-row", { hasText: "Test Oval" }).locator(".track-action:not(.delete)").click();
  await expect(page.locator(".track-card")).toHaveCount(8);
  await expect(page.locator("#track-name")).toHaveText("Custom #1");
  await expect(page.locator("#saved-count")).toHaveText("0");
  await expect(page.locator(".track-card", { hasText: "Test Oval" })).toHaveCount(1);
  await page.locator("#track-editor-done").click();

  await page.reload();
  await expect(page.locator(".track-card")).toHaveCount(8);
  await expect(page.locator(".track-card", { hasText: "Test Oval" })).toHaveCount(1);

  page.once("dialog", dialog => dialog.accept());
  await page.locator(".track-row", { hasText: "Custom #1" }).locator(".track-action.delete").click();
  await expect(page.locator(".track-card")).toHaveCount(7);
  page.once("dialog", dialog => dialog.accept());
  await page.locator(".track-row", { hasText: "Test Oval" }).locator(".track-action.delete").click();
  await expect(page.locator(".track-card")).toHaveCount(6);
});
