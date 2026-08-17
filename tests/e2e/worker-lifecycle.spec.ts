import { expect, test } from "@playwright/test";

test("starts a fresh optimizer after completed runs and track changes", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#save-button")).toBeEnabled({ timeout: 30_000 });

  const optimize = page.locator("#optimize-button");
  for (const trackIndex of [1, 2, 3]) {
    await page.locator("#candidate-rate").evaluate(element =>
      delete (element as HTMLElement).dataset.totalCandidates);
    await optimize.click();
    await expect(optimize).toHaveText("STOP");
    await expect(page.locator("#candidate-rate")).toHaveAttribute(
      "data-total-candidates",
      /\d+/,
      { timeout: 30_000 },
    );
    await optimize.click();
    await expect(page.locator("#engine-status")).toContainText("Stopped", {
      timeout: 30_000,
    });

    const nextTrack = page.locator(".track-card").nth(trackIndex);
    const nextName = await nextTrack.locator("strong").textContent();
    await nextTrack.click();
    await expect(page.locator("#track-name")).toHaveText(nextName!);
    await expect(page.locator("#engine-status")).not.toContainText("Optimizer error");
  }

  await page.locator("#candidate-rate").evaluate(element =>
    delete (element as HTMLElement).dataset.totalCandidates);
  await optimize.click();
  await expect(optimize).toHaveText("STOP");
  await expect(page.locator("#candidate-rate")).toHaveAttribute(
    "data-total-candidates",
    /\d+/,
    { timeout: 30_000 },
  );
  await expect(page.locator("#engine-status")).not.toContainText("Optimizer error");
  expect(pageErrors).toEqual([]);
  await optimize.click();
  await expect(page.locator("#engine-status")).toContainText("Stopped", {
    timeout: 30_000,
  });
});
