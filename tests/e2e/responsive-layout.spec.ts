import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1080, height: 778 } });

test("uses narrow desktop width for settings, metrics, and profile axes", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#settings-grid .setting").first()).toBeVisible();

  const narrowLayout = await page.locator("#settings-grid .setting").first().evaluate(row => {
    const rowBox = row.getBoundingClientRect();
    const inputBox = row.querySelector(".input-wrap")!.getBoundingClientRect();
    const panelBox = row.closest(".control-panel")!.getBoundingClientRect();
    const viewerBox = document.querySelector(".viewer-panel")!.getBoundingClientRect();
    return {
      panelWidth: panelBox.width,
      viewerWidth: viewerBox.width,
      unusedRight: rowBox.right - inputBox.right,
      inputWidth: inputBox.width,
    };
  });
  expect(narrowLayout.panelWidth).toBe(260);
  expect(narrowLayout.viewerWidth).toBeGreaterThan(590);
  expect(narrowLayout.unusedRight).toBeLessThanOrEqual(10);
  expect(narrowLayout.inputWidth).toBeGreaterThan(190);

  const formulasFit = await page.locator(".setting-equation").evaluateAll(equations => equations.every(equation => {
    const formula = equation.querySelector(".formula")!;
    const range = document.createRange();
    range.selectNodeContents(formula);
    return range.getBoundingClientRect().width <= equation.clientWidth + 1;
  }));
  expect(formulasFit).toBe(true);

  const footerFitsViewer = await page.locator(".viewer-footer").evaluate(footer => {
    const footerBox = footer.getBoundingClientRect();
    const viewerBox = footer.closest(".viewer-panel")!.getBoundingClientRect();
    return footerBox.left >= viewerBox.left && footerBox.right <= viewerBox.right;
  });
  expect(footerFitsViewer).toBe(true);

  await expect(page.locator(".chart-axis-labels")).toHaveCSS("flex-basis", "300px");
});
