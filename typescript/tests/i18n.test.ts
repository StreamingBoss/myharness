import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';
import { english, pageTranslator, type Translator } from '../src/text.js';
import { DiagnosticError, failureDetails, failureText, presentFailure } from '../src/failure.js';
import { timeoutDuration } from '../src/error-messages.js';

interface KeyEntry { one?: string; where?: string }
interface KeysModule {
  LANGUAGES: string[];
  extractKeys(): Promise<{ keys: Map<string, KeyEntry>; problems: string[] }>;
  readCatalog(lang: string): Promise<Record<string, string | Record<string, string>>>;
  checkCatalog(lang: string, catalog: Record<string, unknown>, keys: Map<string, KeyEntry>): string[];
}
const keysModule = () => import(pathToFileURL(path.resolve('scripts/i18n-keys.mjs')).href) as Promise<KeysModule>;

test('every catalog translates every interface text and keeps its placeholders and tags', async () => {
  const { LANGUAGES, extractKeys, readCatalog, checkCatalog } = await keysModule();
  const { keys, problems } = await extractKeys();
  assert.ok(keys.size > 600, 'the interface texts were found');
  for (const lang of LANGUAGES) problems.push(...checkCatalog(lang, await readCatalog(lang), keys));
  assert.deepEqual(problems, []);
});

test('the catalog check reports what a translation could get wrong', async () => {
  const { checkCatalog } = await keysModule();
  const keys = new Map<string, KeyEntry>([['Send', {}], ['{count} tools', { one: '{count} tool' }], ['Saved to {source}', {}], ['<b>Preview</b> connects', {}], ['Close', {}]]);
  const problems = checkCatalog('xx', {
    Send: '', '{count} tools': { one: 'un outil', few: '{count}', other: '{count} outils', lots: 'x' }, 'Saved to {source}': 'Enregistré dans {place}',
    '<b>Preview</b> connects': 'Aperçu se connecte', Extra: 'en trop',
  }, keys).join('\n');
  for (const expected of ['missing "Close"', 'unknown key "Extra"', 'empty translation for "Send"', 'unknown plural form "lots"', 'lost {source}', 'added {place}', 'must keep the tags']) assert.match(problems, new RegExp(expected.replace(/[{}()]/g, '\\$&')));
  assert.doesNotMatch(problems, /"\{count\} tools" lost \{count\}/, 'a plural form may spell out its number');
  assert.match(checkCatalog('xx', { Send: { other: 'Envoyer' } }, new Map([['Send', {}]])).join(), /cannot have plural forms/);
  assert.match(checkCatalog('xx', { '{count} tools': { one: '{count}' } }, new Map([['{count} tools', {}]])).join(), /needs an "other" form/);
  assert.match(checkCatalog('xx', { Send: ['Envoyer'] }, new Map([['Send', {}]])).join(), /must be a string or plural forms/);
});

test('the key list reads markup, rich text and literal t() and tn() calls, and rejects computed texts', async () => {
  const { extractKeys } = await keysModule();
  const { keys, problems } = await extractKeys();
  assert.deepEqual(problems, []);
  assert.match(keys.get('Send')!.where!, /<button id="send">/);
  assert.ok(keys.has('<strong>Clear this conversation?</strong> Its messages are removed from memory and from the screen. This cannot be undone.'));
  assert.ok(keys.has('This page could not reach Ollama at <code></code>. Ollama only answers websites it was told to allow. Quit Ollama if it is running, start it with this page allowed, then try again:'));
  assert.equal(keys.get('{count} tools')!.one, '{count} tool');
  assert.ok(keys.has('The model or service could not be reached.'), 'error explanations are listed');
  for (const brand of ['Gemini', 'OpenAI GPT', 'MyHarness', 'myharness', '…']) assert.ok(!keys.has(brand), `${brand} is not translated`);
  const module = await import(pathToFileURL(path.resolve('scripts/i18n-keys.mjs')).href) as { scriptKeys(source: string, file: string, add: (key: string) => void, problems: string[]): void; markupKeys(html: string, add: (key: string) => void): void };
  const found: string[] = [], reported: string[] = [];
  module.scriptKeys('t(label); tn("one only", count); t("A {x}", { x }); t(explanation.message)', 'f.js', key => found.push(key), reported);
  assert.deepEqual(found, ['A {x}']);
  assert.equal(reported.length, 2);
  assert.throws(() => module.markupKeys('<div><span></div>', () => {}), /Unbalanced/);
  assert.throws(() => module.markupKeys('<div>', () => {}), /Unclosed/);
});

test('English is the default presentation; a translator words explanations but never the raw reason or recovery', () => {
  assert.equal(english.t('{a} and {b}', { a: 1 }), '1 and {b}');
  assert.equal(english.t('plain'), 'plain');
  assert.equal(english.tn('{count} tool', '{count} tools', 1), '1 tool');
  assert.equal(english.tn('{count} of {total} tool', '{count} of {total} tools', 2, { count: 0, total: 2 }), '0 of 2 tools');
  assert.equal(pageTranslator(), english);
  const page: Translator = { t: text => text, tn: (_one, other) => other };
  (globalThis as { MyHarnessI18n?: Translator }).MyHarnessI18n = page;
  try { assert.equal(pageTranslator(), page); } finally { delete (globalThis as { MyHarnessI18n?: Translator }).MyHarnessI18n; }

  const marked: Translator = { t: (text, vars) => '«' + english.t(text, vars) + '»', tn: (one, other, count, vars) => '«' + english.tn(one, other, count, vars) + '»' };
  const explained = presentFailure(failureDetails('HTTP 503', 'model', 'Ollama', 'Start Ollama.', 180_000), '', marked);
  assert.match(explained, /^«The model or service could not be reached\.»/);
  assert.match(explained, /«Where: «Model service» \(Ollama\)»/);
  assert.match(explained, /«Time limit: «3 minutes»\.»/);
  assert.match(explained, /«Technical details:» HTTP 503$/);
  const unexplained = presentFailure(failureDetails('odd internal state', 'harness', 'Harness', 'Retry the turn.'), '', marked);
  assert.match(unexplained, /«The harness could not complete this action\.»/);
  assert.match(unexplained, /«To continue: Retry the turn\.»/, 'the backend recovery text is shown as given');
  assert.match(presentFailure(undefined, 'Model request timed out. [Time limit: 10 seconds]', marked), /«Time limit: 10 seconds\.»/);
  assert.equal(timeoutDuration(150_000, marked), '««2 minutes» «30 seconds»»');
  assert.equal(timeoutDuration(150_000), '2 minutes 30 seconds');
  assert.equal(timeoutDuration(1), '1 millisecond');
  assert.match(failureText(new DiagnosticError(failureDetails('Backend Worker stopped', 'transport', 'Browser', 'Reload.')), '', marked), /«Browser connection to the harness»/);
  assert.equal(failureText(new Error('offline'), 'fallback', marked), 'fallback');
});

async function staticServer(t: { after(callback: () => unknown): void }) {
  const child = spawn(process.execPath, ['scripts/serve-browser.mjs'], { env: { ...process.env, MYHARNESS_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGTERM'); });
  return new Promise<string>((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('Static server did not start: ' + output)), 10000);
    child.stdout.on('data', chunk => { output += String(chunk); const match = output.match(/http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); } });
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error('Static server exited: ' + code)); });
  });
}
const ready = (page: Page) => page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);

test('the browser edition follows a ?lang= link, the saved choice or the browser language, and its menu saves the choice', async t => {
  const { LANGUAGES, readCatalog } = await keysModule();
  const base = await staticServer(t);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());

  const english_ = await browser.newPage({ locale: 'en-US' });
  await english_.goto(base + '/?database=i18n-en'); await ready(english_);
  assert.equal(await english_.evaluate(() => document.documentElement.lang), 'en');
  assert.equal(await english_.locator('#send').innerText(), 'Send');
  assert.deepEqual(await english_.locator('#ui-language option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)), ['en', ...LANGUAGES]);

  for (const lang of LANGUAGES) {
    const catalog = await readCatalog(lang), errors: string[] = [];
    const page = await browser.newPage({ locale: 'en-US' }); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/?database=i18n-${lang}&lang=${lang}`); await ready(page);
    assert.equal(await page.evaluate(() => document.documentElement.lang), lang);
    assert.equal(await page.locator('#send').innerText(), catalog.Send);
    assert.equal(await page.locator('#send').getAttribute('title'), catalog['Send your message and run one backend turn, including any requested tool calls and approval waits. While the model is still answering, Send queues the message: it is sent when the current turn ends. Stop holds queued messages back in the message box.']);
    assert.equal(await page.locator('#ui-language').inputValue(), lang);
    // Rich text keeps the original child elements, so ids and links survive translation.
    assert.equal(await page.locator('#confirm-clear strong').count(), 1);
    assert.equal(await page.locator('#connect-ollama-shown').count(), 1);
    assert.match(await page.locator('#token-helper-download').getAttribute('href') ?? '', /^https:\/\//);
    assert.deepEqual(errors, []);
    await page.close();
  }

  const fromBrowser = await browser.newPage({ locale: 'ja-JP' });
  await fromBrowser.goto(base + '/?database=i18n-ja-browser'); await ready(fromBrowser);
  assert.equal(await fromBrowser.evaluate(() => document.documentElement.lang), 'ja');
  await fromBrowser.locator('#ui-language').selectOption('de');
  await fromBrowser.waitForFunction(() => document.documentElement.lang === 'de'); await ready(fromBrowser);
  assert.equal(await fromBrowser.evaluate(() => localStorage.getItem('lang')), 'de');
  await fromBrowser.goto(base + '/?database=i18n-ja-browser&lang=fr'); await ready(fromBrowser);
  assert.equal(await fromBrowser.evaluate(() => document.documentElement.lang), 'fr', 'a link wins for that page');
  assert.equal(await fromBrowser.evaluate(() => localStorage.getItem('lang')), 'de', 'without changing the saved choice');
  await fromBrowser.locator('#ui-language').selectOption('en');
  await fromBrowser.waitForFunction(() => document.documentElement.lang === 'en' && !location.search.includes('lang='));
});
