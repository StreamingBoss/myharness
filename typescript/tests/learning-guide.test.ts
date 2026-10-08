import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

test('English and French learning guides link both ways, retain progress and run localized offline demonstrations', async t => {
  const files = ['myharness-learning-guide.html', 'myharness-learning-guide.fr.html'];
  const guides = new Map(await Promise.all(files.map(async name => [name, await readFile(path.resolve('docs', name), 'utf8')] as const)));
  const server = createServer((request, response) => {
    const content = guides.get(request.url!.slice(1));
    response.writeHead(content ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(content ?? 'Not found');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ executablePath: process.env.MYHARNESS_TEST_CHROMIUM ?? chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.goto(base + '/' + files[0]);
  await page.locator('[data-complete="1"]').check();
  assert.equal(await page.locator('#progressText').innerText(), '1 of 12 steps explored');
  await page.getByRole('link', { name: 'Français', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('lang'), 'fr');
  assert.equal(await page.locator('.languages [aria-current="page"]').innerText(), 'Français');
  assert.match(await page.title(), /réponse d’IA/);
  assert.equal(await page.locator('.lesson[id^=step-]').count(), 12);
  assert.equal(await page.locator('nav a').count(), 12);
  assert.equal(await page.locator('[data-complete="1"]').isChecked(), true);
  assert.equal(await page.locator('#progressText').innerText(), '1 étape explorée sur 12');
  await page.locator('[data-complete="2"]').check();
  assert.equal(await page.locator('#progressText').innerText(), '2 étapes explorées sur 12');
  assert.match(await page.locator('#memoryPayload').innerText(), /Mon nombre préféré est 42/);
  await page.getByRole('button', { name: 'Mémoire activée', exact: true }).click();
  assert.equal(await page.locator('#memoryToggle').getAttribute('aria-pressed'), 'false');
  assert.equal(JSON.parse(await page.locator('#memoryPayload').innerText()).messages.length, 1);
  assert.match(await page.locator('#memoryExplanation').innerText(), /Le fait est absent/);
  await page.getByRole('button', { name: 'Mémoire désactivée', exact: true }).click();
  assert.equal(JSON.parse(await page.locator('#memoryPayload').innerText()).messages.length, 3);
  await page.getByRole('button', { name: 'Autoriser', exact: true }).click();
  assert.match(await page.locator('#approvalResult').innerText(), /l’écriture a réussi/);
  await page.getByRole('button', { name: 'Refuser', exact: true }).click();
  assert.match(await page.locator('#approvalResult').innerText(), /Aucun fichier n’est créé/);
  await page.locator('#growContext').click();
  assert.match(await page.locator('#contextStatus').innerText(), /Total 74 %/);
  await page.locator('#compactContext').click();
  assert.match(await page.locator('#contextStatus').innerText(), /mémoire 8 %/);
  await page.locator('#resetContext').click();
  assert.match(await page.locator('#contextStatus').innerText(), /Total 62 %/);
  await page.getByRole('link', { name: 'English', exact: true }).click();
  assert.equal(await page.locator('[data-complete="2"]').isChecked(), true);
  assert.equal(await page.locator('#progressText').innerText(), '2 of 12 steps explored');
  await page.locator('#resetProgress').click();
  await page.getByRole('link', { name: 'Français', exact: true }).click();
  assert.equal(await page.locator('#progressText').innerText(), '0 étape explorée sur 12');
  await page.evaluate(() => { window.print = () => { document.body.dataset.printed = 'yes'; }; });
  await page.getByRole('button', { name: 'Imprimer / enregistrer en PDF', exact: true }).click();
  assert.equal(await page.locator('body').getAttribute('data-printed'), 'yes');
  assert.deepEqual(errors, []);
  assert.ok(requests.every(url => files.some(file => url === base + '/' + file)));

  const noScripts = await browser.newContext({ javaScriptEnabled: false });
  t.after(() => noScripts.close());
  const offline = await noScripts.newPage();
  for (const [file, lang] of [[files[0], 'en'], [files[1], 'fr']] as const) {
    await offline.goto(base + '/' + file);
    assert.equal(await offline.locator('html').getAttribute('lang'), lang);
    assert.equal(await offline.locator('.lesson[id^=step-]').count(), 12);
    assert.equal(await offline.locator('noscript').isVisible(), true);
    assert.equal(await offline.locator('.languages a').count(), 2);
    // Every lesson has translated prose, exercises and a reflection even without scripts.
    for (const lesson of await offline.locator('.lesson[id^=step-]').all()) {
      assert.ok((await lesson.innerText()).length > 400);
      assert.equal(await lesson.locator('.reflect').count(), 1);
    }
  }
});
