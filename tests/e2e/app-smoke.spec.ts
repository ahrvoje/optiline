import { expect, test } from "@playwright/test";

test("loads the catalog and keeps primary actions coherent", async ({ page }) => {
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
  await expect(page.locator("#setting-run-mode")).toBeVisible();
  await expect(page.locator("#setting-run-mode")).toHaveValue("random");
  await expect(page.locator("#setting-vMaxMps")).toHaveValue("330");
  await expect(page.locator("#setting-vMaxMps")).toHaveAttribute("min", "3.6");
  await expect(page.locator("#setting-vMaxMps")).toHaveAttribute("step", "1");
  await expect(page.locator("#setting-safetyMarginM")).toHaveCount(0);
  await expect(page.locator("#setting-vMaxMps + span")).toHaveText("km/h");
  const unitStyle = await page.locator("#setting-vMaxMps + span").evaluate(unit => ({
    color: getComputedStyle(unit).color,
    fontSizePx: Number.parseFloat(getComputedStyle(unit).fontSize),
  }));
  expect(unitStyle.color).toBe("rgb(245, 247, 250)");
  expect(unitStyle.fontSizePx).toBeGreaterThanOrEqual(11);
  await page.locator("#setting-vMaxMps").hover();
  await page.mouse.wheel(0, -100);
  await expect(page.locator("#setting-vMaxMps")).toHaveValue("331");
  await page.locator("#setting-vMaxMps").fill("330");
  await page.locator("#setting-vMaxMps").press("Tab");
  await expect(page.locator("#engine-status")).toContainText("Certified", { timeout: 30_000 });
  await page.locator("#setting-airDensity").hover();
  await page.mouse.wheel(0, -100);
  await expect(page.locator("#setting-airDensity")).toHaveValue("1.23");
  await page.mouse.wheel(0, 100);
  await expect(page.locator("#setting-airDensity")).toHaveValue("1.225");
  await expect(page.locator("#settings-grid .setting")).toHaveCount(13);
  await expect(page.locator("#setting-background-execution")).toHaveCount(0);
  await expect(page.locator(".chart-panel h2")).toHaveCount(0);
  await expect(page.locator(".chart-axis-label")).toHaveCount(5);
  await expect(page.locator(".chart-series-label")).toHaveCount(5);
  await expect(page.locator("#profile-labels")).not.toContainText("Lim");
  const chartGeometry = await page.locator(".chart-panel").evaluate(panel => ({
    headerHeight: panel.querySelector(".chart-head")!.getBoundingClientRect().height,
    canvasHeight: panel.querySelector("canvas")!.getBoundingClientRect().height,
  }));
  expect(chartGeometry.headerHeight).toBe(28);
  expect(chartGeometry.canvasHeight).toBeGreaterThan(250);
  const settingLayout = await page.locator("#settings-grid .setting").first().evaluate(row => {
    const equation = row.querySelector<HTMLElement>(".setting-equation")!;
    const description = row.querySelector<HTMLElement>(".setting-description")!;
    const equationBox = equation.getBoundingClientRect();
    const descriptionBox = description.getBoundingClientRect();
    return {
      equationFontPx: Number.parseFloat(getComputedStyle(equation.querySelector(".formula")!).fontSize),
      descriptionFontPx: Number.parseFloat(getComputedStyle(description).fontSize),
      equationRight: equationBox.right,
      descriptionLeft: descriptionBox.left,
    };
  });
  expect(settingLayout.equationFontPx).toBeGreaterThanOrEqual(16);
  expect(settingLayout.descriptionFontPx).toBeGreaterThanOrEqual(11);
  expect(settingLayout.descriptionLeft).toBeGreaterThan(settingLayout.equationRight);
  const formulaAlignment = await page.locator("#settings-grid .setting").first().evaluate(row => {
    const editor = row.querySelector<HTMLElement>(".input-wrap")!.getBoundingClientRect();
    const formula = row.querySelector<HTMLElement>(".formula")!.getBoundingClientRect();
    return (formula.top + formula.height / 2) - (editor.top + editor.height / 2);
  });
  expect(Math.abs(formulaAlignment)).toBeLessThanOrEqual(2);
  const formulaRows = await page.locator("#settings-grid .setting").evaluateAll(rows => rows.map(row => {
    const equation = row.querySelector<HTMLElement>(".setting-equation")!;
    const formula = row.querySelector<HTMLElement>(".formula")!;
    return {
      whiteSpace: getComputedStyle(formula).whiteSpace,
      fitsColumn: formula.scrollWidth <= equation.clientWidth + 1,
    };
  }));
  expect(formulaRows.every(row => row.whiteSpace === "nowrap" && row.fitsColumn)).toBe(true);
  const brakingDescriptionLines = await page.locator("#setting-axMinus0").evaluate(input => {
    const description = input.closest(".setting")!.querySelector<HTMLElement>(".setting-description")!;
    const style = getComputedStyle(description);
    return description.getBoundingClientRect().height / Number.parseFloat(style.lineHeight);
  });
  expect(brakingDescriptionLines).toBeGreaterThan(1.5);
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
  const statusBeforeMark = await page.locator("#engine-status").textContent();
  await page.mouse.down();
  await page.mouse.move(chartBox!.x + chartBox!.width * 0.72, chartBox!.y + 100, { steps: 8 });
  await page.mouse.move(chartBox!.x + chartBox!.width * 0.82, chartBox!.y + 100, { steps: 8 });
  await page.mouse.up();
  expect(await page.locator("#engine-status").textContent()).toBe(statusBeforeMark);

  await play.click();
  await expect(play).toContainText("PAUSE");
  await page.locator("#zoom-button").click();
  await expect(page.locator("#zoom-button")).toHaveAttribute("aria-pressed", "true");

  await save.click();
  await expect(page.locator("#saved-count")).toHaveText("1");
  await expect(page.locator("#saved-list .saved-item")).toHaveCount(1);
  const savedFocus = await page.locator("#focus-select option").nth(1).getAttribute("value");
  expect(savedFocus).not.toBeNull();
  await page.locator("#focus-select").selectOption(savedFocus!);
  await expect(page.locator("#profile-canvas")).toHaveAttribute("data-focus-trajectory", savedFocus!);
  await page.locator("#saved-list .delete-profile").click();
  await expect(page.locator("#saved-count")).toHaveText("0");

  await page.locator("#setting-massKg").fill("500");
  await page.locator("#setting-massKg").press("Tab");
  await expect(page.locator("#optimize-button")).toBeEnabled();
  await page.locator("#optimize-button").click();
  await expect(page.locator("#optimize-button")).toHaveText("STOP");
  await expect(page.locator("#setting-massKg")).toBeDisabled();
  await expect(page.locator("#setting-run-mode")).toBeDisabled();
  await expect(page.locator("#reset-button")).toBeDisabled();
  const guardedMass = await page.locator("#setting-massKg").evaluate(input => {
    (input as HTMLInputElement).value = "700";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return (input as HTMLInputElement).value;
  });
  expect(guardedMass).toBe("500");
  await expect(page.locator("#optimize-button")).toHaveText("STOP");
  await expect(page.locator("#work-overlay")).toContainText("OPTIMIZING");
  await expect(page.locator("#work-overlay")).toBeVisible();
  await expect(page.locator(".validation-progress")).toBeHidden();
  const metricsBox = await page.locator(".viewer-footer > .metrics").boundingBox();
  const workBox = await page.locator("#work-overlay").boundingBox();
  expect(metricsBox).not.toBeNull();
  expect(workBox).not.toBeNull();
  expect(workBox!.x).toBeGreaterThan(metricsBox!.x + metricsBox!.width);
  expect(workBox!.width).toBeGreaterThanOrEqual(160);
  await expect(play).toBeEnabled();
  // Wait for one complete GPU/CPU island generation. This validates the
  // optimizer shader and its storage-buffer contract, not only worker startup.
  await expect(page.locator("#candidate-rate")).not.toHaveText("—", { timeout: 30_000 });
  await expect(page.locator("#station-rate")).not.toHaveText("—");
  await expect(page.locator("#full-rate")).not.toHaveText("—");
  await expect(page.locator("#engine-status")).toContainText("GPU");
  await expect(page.locator("#optimization-time")).not.toHaveText("—");
  const candidatesBeforeBackground = Number(
    await page.locator("#candidate-rate").getAttribute("data-total-candidates"),
  );
  const foreground = await page.context().newPage();
  await foreground.goto("about:blank");
  await foreground.bringToFront();
  await expect.poll(async () => Number(
    await page.locator("#candidate-rate").getAttribute("data-total-candidates"),
  ), { timeout: 15_000 }).toBeGreaterThan(candidatesBeforeBackground);
  await foreground.close();
  await page.bringToFront();
  const stoppedUi = await page.locator("#optimize-button").evaluate(button => {
    (button as HTMLButtonElement).click();
    const overlay = document.querySelector<HTMLElement>("#work-overlay")!;
    return {
      hidden: overlay.hidden,
      text: overlay.querySelector("span")?.textContent,
      validating: overlay.classList.contains("validating"),
    };
  });
  expect(stoppedUi).toEqual({ hidden: false, text: "VALIDATING", validating: true });
  await expect(page.locator(".validation-progress")).toBeVisible();
  await expect(page.locator("#engine-status")).toContainText("Validating final candidates");
  await expect(page.locator("#engine-status")).toContainText("Stopped", { timeout: 30_000 });
  await expect(page.locator("#work-overlay")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator("#setting-massKg")).toBeEnabled();
  await expect(page.locator("#setting-run-mode")).toBeEnabled();
  await expect(page.locator("#reset-button")).toBeEnabled();

  // A completed run must never poison the next worker initialization.
  await page.locator("#optimize-button").click();
  await expect(page.locator("#optimize-button")).toHaveText("STOP");
  await expect(play).toBeEnabled();
  await expect(page.locator("#engine-status")).not.toContainText("undefined");
  await page.locator("#optimize-button").click();
  await expect(page.locator("#engine-status")).toContainText("Stopped", { timeout: 30_000 });

  await page.locator("#reset-button").click();
  await expect(page.locator("#setting-massKg")).toHaveValue("900");
  await expect(page.locator("#setting-safetyMarginM")).toHaveCount(0);
  await expect(page.locator("#setting-run-mode")).toHaveValue("random");
  await page.locator("#setting-massKg").hover();
  await page.mouse.wheel(0, -100);
  await expect(page.locator("#setting-massKg")).toHaveValue("910");
});
