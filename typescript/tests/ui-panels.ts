import type { Page } from 'playwright';

/** The settings drawer and the sessions list are closed by default. These open one, closing the other, and do nothing if it is already open. */
export async function openSettings(page: Page): Promise<void> {
  if (!(await page.locator('#settings-drawer').isHidden())) return;
  if (!(await page.locator('#sessions-panel').isHidden())) await page.keyboard.press('Escape');
  await page.locator('#open-settings').click();
}

export async function openSessions(page: Page): Promise<void> {
  if (!(await page.locator('#sessions-panel').isHidden())) return;
  if (!(await page.locator('#settings-drawer').isHidden())) await page.keyboard.press('Escape');
  await page.locator('#sessions-btn').click();
}

/** The terminal log is the Log tab of the inspector. */
export async function showLog(page: Page): Promise<void> {
  const view = page.locator('#explore-view');
  if ((await view.inputValue()) !== 'log') await view.selectOption('log');
}

/** The tool list sits inside the Active tools section, which is collapsed by default. */
export async function openTools(page: Page): Promise<void> {
  if (!(await page.locator('#active-tools').evaluate(element => (element as HTMLDetailsElement).open))) await page.locator('#active-tools > summary').click();
}

/** Close the settings drawer and the sessions list, so the chat and the inspector can be used. */
export async function closePanels(page: Page): Promise<void> {
  if (!(await page.locator('#sessions-panel').isHidden()) || !(await page.locator('#settings-drawer').isHidden())) await page.keyboard.press('Escape');
  if (!(await page.locator('#settings-drawer').isHidden())) await page.keyboard.press('Escape');
}
