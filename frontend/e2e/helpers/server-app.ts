import { expect, type Page } from '@playwright/test';

/** Shows the Server App's table list: a phone opens it with Select Table, a tablet always shows it. */
export async function openServerAppTables(page: Page): Promise<void> {
  const picker = page.getByTestId('server-app-table-picker');
  const button = page.getByTestId('server-app-table-button');
  await expect(picker.or(button).first()).toBeVisible();
  if ((await button.isVisible()) && (await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  await expect(picker).toBeVisible();
}
