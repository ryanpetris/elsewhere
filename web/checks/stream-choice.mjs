// Open the same stream preference from a wide chip or the narrow Stream Settings dialog.
export async function streamChoice(page, label) {
  const wide = await page.evaluate(() => matchMedia('(min-width: 57rem)').matches);
  await page.getByTitle(wide ? label : 'Stream Settings', { exact: true }).click();
  const panel = page.getByRole('dialog', { name: wide ? label : 'Stream Settings', exact: true });
  await panel.waitFor();
  return panel.getByRole('group', { name: label, exact: true });
}

export async function chooseStream(page, label, value) {
  const field = await streamChoice(page, label);
  await field.locator(`input[value="${value}"]`).click();
}

export async function selectedStream(page, label) {
  const field = await streamChoice(page, label);
  const value = await field.locator('input:checked').inputValue();
  await page.keyboard.press('Escape');
  return value;
}
