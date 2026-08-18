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

  const controlsFit = await page.locator(".optimization-control").evaluate(controls => {
    const buttonBox = controls.querySelector("button")!.getBoundingClientRect();
    const panelBox = controls.closest(".control-panel")!.getBoundingClientRect();
    const configuration = document.querySelector(".configuration-head")!;
    const configurationBox = configuration.getBoundingClientRect();
    const titleBox = configuration.querySelector("h1")!.getBoundingClientRect();
    const resetBox = configuration.querySelector("button")!.getBoundingClientRect();
    return {
      insidePanel: buttonBox.left >= panelBox.left && buttonBox.right <= panelBox.right,
      buttonWidth: buttonBox.width,
      sameRow: Math.abs(
        titleBox.top + titleBox.height / 2 - (resetBox.top + resetBox.height / 2),
      ),
      configurationBelowButton: configurationBox.top >= buttonBox.bottom,
    };
  });
  expect(controlsFit.insidePanel).toBe(true);
  expect(controlsFit.buttonWidth).toBeGreaterThan(200);
  expect(controlsFit.sameRow).toBeLessThanOrEqual(1);
  expect(controlsFit.configurationBelowButton).toBe(true);

  const configurationOverflow = await page.locator(".configuration-scroll").evaluate(scroll => ({
    overflowX: getComputedStyle(scroll).overflowX,
    fits: scroll.scrollWidth <= scroll.clientWidth,
  }));
  expect(configurationOverflow).toEqual({ overflowX: "hidden", fits: true });

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

  await page.setViewportSize({ width: 1440, height: 900 });
  const wideLayout = await page.locator(".configuration-scroll").evaluate(scroll => {
    const panel = scroll.closest(".control-panel")!;
    const title = document.querySelector("#track-name")!.getBoundingClientRect();
    const meta = document.querySelector("#track-meta")!.getBoundingClientRect();
    const settings = [...scroll.querySelectorAll<HTMLElement>(".setting")];
    return {
      panelWidth: panel.getBoundingClientRect().width,
      settingsFit: scroll.scrollWidth <= scroll.clientWidth,
      trackMetaInline: Math.max(title.top, meta.top) < Math.min(title.bottom, meta.bottom),
      amountFormulaAligned: settings.every(setting => {
        const input = setting.querySelector(".input-wrap")!.getBoundingClientRect();
        const formula = setting.querySelector(".formula")!.getBoundingClientRect();
        return Math.abs(
          input.top + input.height / 2 - (formula.top + formula.height / 2),
        ) <= 2;
      }),
      equationsFollowEditors: settings.every(setting => {
        const input = setting.querySelector(".input-wrap")!.getBoundingClientRect();
        const equation = setting.querySelector(".setting-equation")!.getBoundingClientRect();
        return equation.left >= input.right && equation.left - input.right <= 9;
      }),
    };
  });
  expect(wideLayout.panelWidth).toBeGreaterThanOrEqual(420);
  expect(wideLayout.settingsFit).toBe(true);
  expect(wideLayout.trackMetaInline).toBe(true);
  expect(wideLayout.amountFormulaAligned).toBe(true);
  expect(wideLayout.equationsFollowEditors).toBe(true);
});
