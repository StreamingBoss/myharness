// Lists every interface text that the language catalogs (web/static/i18n-<lang>.js) translate.
// Keys are the English texts, normalised the way web/static/i18n.js looks them up: markup text and the title,
// placeholder and aria-label attributes, rich elements (data-i18n-html), and the literal texts passed to t() and tn().
// Run after `npm run build:ts` (it reads the compiled markup constants and error explanations):
//   node scripts/i18n-keys.mjs                 prints { key: { one?: singular, where: first place it appears } } as JSON
//   node scripts/i18n-keys.mjs --check [lang]  compares every catalog (or one) with the keys and exits 1 on a problem
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = file => readFile(path.join(root, file), 'utf8');
const normalize = text => text.replace(/\s+/g, ' ').trim();
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, name) => name[0] === '#'
  ? String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))) : ENTITIES[name] ?? match);
// A key must contain a letter: punctuation such as "·", "▾" or "…" is never translated.
const worthy = key => /\p{L}/u.test(key);

const VOID = new Set(['input', 'br', 'meta', 'link', 'img', 'hr', 'source', 'wbr']);
const ATTRIBUTES = ['title', 'placeholder', 'aria-label'];
/** Collects keys from a markup fragment written by this project (well-formed, no inline scripts in translated parts). */
export function markupKeys(html, add, file = 'markup') {
  // The runtime translates the body only: the document head (title included) and the doctype are not keys.
  html = html.replace(/<!doctype[^>]*>/i, '').replace(/<head>[\s\S]*?<\/head>/i, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const token = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/g;
  const stack = []; // { tag, skip, rich: { parts } | null, depth }
  let match;
  while ((match = token.exec(html))) {
    const [, closing, tagName, attributeText, text] = match;
    const top = stack[stack.length - 1];
    if (text !== undefined) {
      if (top?.skip) continue;
      const rich = stack.find(entry => entry.rich)?.rich;
      if (rich) rich.parts.push(decode(text));
      else { const key = normalize(decode(text)); if (worthy(key)) add(key, undefined, `${file}: text of ${describe(top)}`); }
      continue;
    }
    const tag = tagName.toLowerCase();
    if (closing) {
      const entry = stack.pop();
      if (!entry || entry.tag !== tag) throw new Error(`Unbalanced markup near </${tag}>`);
      const rich = stack.find(item => item.rich)?.rich;
      if (entry.rich) { const key = normalize(entry.rich.parts.join('')); if (worthy(key)) add(key, undefined, `${file}: rich text of ${describe(entry)} (keep the tags)`); }
      else if (rich && entry.richChild) rich.parts.push(`</${tag}>`);
      continue;
    }
    const attributes = {};
    for (const [, name, , double, single, bare] of attributeText.matchAll(/([^\s=]+)(?:=("([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attributes[name.toLowerCase()] = decode(double ?? single ?? bare ?? '');
    const skip = Boolean(top?.skip) || attributes.translate === 'no';
    if (!skip) for (const name of ATTRIBUTES) if (attributes[name] !== undefined) { const key = normalize(attributes[name]); if (worthy(key)) add(key, undefined, `${file}: ${name === 'title' ? 'hover text (title)' : name} of ${describe({ tag, attributes })}`); }
    const outerRich = stack.find(item => item.rich)?.rich;
    // Only direct children of a rich element appear as tags in its key; deeper elements contribute their text.
    const richChild = Boolean(outerRich) && stack[stack.length - 1]?.rich === outerRich;
    if (richChild) outerRich.parts.push(`<${tag}>`);
    const entry = { tag, attributes, skip, rich: !skip && !outerRich && attributes['data-i18n-html'] !== undefined ? { parts: [] } : null, richChild };
    if (VOID.has(tag)) { if (richChild) outerRich.parts.push(`</${tag}>`); continue; }
    stack.push(entry);
  }
  if (stack.length) throw new Error(`Unclosed <${stack[stack.length - 1].tag}>`);
}

// <button id="send">, or the nearest description the markup allows.
const describe = entry => entry ? `<${entry.tag}${entry.attributes?.id ? ` id="${entry.attributes.id}"` : entry.attributes?.class ? ` class="${entry.attributes.class}"` : ''}>` : 'the page';

const unescape = text => text.replace(/\\(u\{[0-9a-f]+\}|u[0-9a-f]{4}|.)/gi, (match, code) => code === 'n' ? '\n' : code === 't' ? '\t'
  : code[0] === 'u' && code.length > 1 ? String.fromCodePoint(parseInt(code.replace(/[u{}]/g, ''), 16)) : code);
const STRING = String.raw`(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")`;
/** Collects the literal texts passed to t() and tn(); a call with any other first argument is reported. */
export function scriptKeys(source, file, add, problems) {
  for (const match of source.matchAll(new RegExp(String.raw`\b(t|tn)\(\s*` + STRING + String.raw`(?:\s*,\s*` + STRING + ')?', 'g'))) {
    const [, fn, single1, double1, single2, double2] = match;
    const first = unescape(single1 ?? double1), where = `${file}:${source.slice(0, match.index).split('\n').length}`;
    if (fn === 't') add(normalize(first), undefined, where);
    else if (single2 === undefined && double2 === undefined) problems.push(`${file}: tn() needs two literal texts: ${match[0]}`);
    else add(normalize(unescape(single2 ?? double2)), normalize(first), where + ' (plural; English singular in "one")');
  }
  for (const match of source.matchAll(/\b(t|tn)\(\s*(?!['"\s)])([^,)]*)/g)) {
    if (/^explanation\.(message|next)$/.test(match[2])) continue; // listed from the compiled explanations
    problems.push(`${file}: ${match[1]}() must take a literal English text, not ${match[2]}`);
  }
}

export async function extractKeys() {
  const keys = new Map(), problems = [];
  const add = (key, one, where) => { const entry = keys.get(key) ?? {}; if (one !== undefined) entry.one = one; entry.where ??= where; keys.set(key, entry); };
  markupKeys(await read('web/templates/index.html'), add, 'web/templates/index.html');
  const browser = await read('typescript/ui/browser.ts');
  markupKeys(unescape(browser.match(/bar\.innerHTML = '((?:\\.|[^'\\])*)';/)[1]), add, 'typescript/ui/browser.ts (model settings)');
  markupKeys((await read('web/static/orchestration.js')).match(/this\.root\.innerHTML = `([\s\S]*?)`;/)[1], add, 'web/static/orchestration.js');
  const compiled = file => import(pathToFileURL(path.join(root, 'dist/typescript', file)).href);
  markupKeys((await compiled('ui/connect-card.js')).CONNECT_CARD_HTML, add, 'typescript/ui/connect-card.ts');
  markupKeys((await compiled('ui/token-helper-panel.js')).TOKEN_HELPER_HTML, add, 'typescript/ui/token-helper-panel.ts');
  for (const [, message, next] of (await compiled('src/error-messages.js')).explanations) {
    add(message, undefined, 'typescript/src/error-messages.ts: error explanation (what happened)');
    add(next, undefined, 'typescript/src/error-messages.ts: error explanation (what to do next)');
  }
  const scripts = (await readdir(path.join(root, 'web/static'))).filter(file => file.endsWith('.js') && !/^(i18n|marked|purify)/.test(file)).map(file => 'web/static/' + file);
  scripts.push('typescript/ui/browser.ts', 'typescript/ui/connect-card.ts', 'typescript/ui/token-helper-panel.ts', 'typescript/src/failure.ts', 'typescript/src/error-messages.ts', 'scripts/build-browser.mjs');
  for (const file of scripts) scriptKeys(await read(file), file, add, problems);
  return { keys: new Map([...keys].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), problems };
}

export const LANGUAGES = ['zh', 'es', 'pt', 'ja', 'ru', 'de', 'fr', 'ko', 'tr', 'hi', 'it'];
/** Reads a catalog file: one call of MyHarnessI18n.add with a JSON object. */
export async function readCatalog(lang) {
  const source = await read(`web/static/i18n-${lang}.js`);
  const body = source.slice(source.indexOf('MyHarnessI18n.add(') + 'MyHarnessI18n.add('.length, source.lastIndexOf(');'));
  return JSON.parse(body);
}
const PLURAL_FORMS = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(',');
const tags = text => [...text.matchAll(/<\/?([a-z0-9]+)>/g)].map(match => match[0]).sort().join('');
/** Problems in one catalog: missing or unknown keys, and translations whose placeholders or tags differ from the English. */
export function checkCatalog(lang, catalog, keys) {
  const problems = [];
  for (const key of keys.keys()) if (!Object.hasOwn(catalog, key)) problems.push(`${lang}: missing ${JSON.stringify(key)}`);
  for (const [key, value] of Object.entries(catalog)) {
    if (!keys.has(key)) { problems.push(`${lang}: unknown key ${JSON.stringify(key)}`); continue; }
    const forms = typeof value === 'string' ? [value] : value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : null;
    if (!forms) { problems.push(`${lang}: ${JSON.stringify(key)} must be a string or plural forms`); continue; }
    if (typeof value === 'object') {
      if (!key.includes('{count}')) problems.push(`${lang}: ${JSON.stringify(key)} has no {count}, so it cannot have plural forms`);
      if (!Object.hasOwn(value, 'other')) problems.push(`${lang}: ${JSON.stringify(key)} needs an "other" form`);
      for (const [form] of forms) if (!PLURAL_FORMS.has(form)) problems.push(`${lang}: ${JSON.stringify(key)} has an unknown plural form "${form}"`);
    }
    for (const text of typeof value === 'string' ? [value] : Object.values(value)) {
      if (typeof text !== 'string' || !text.trim()) { problems.push(`${lang}: empty translation for ${JSON.stringify(key)}`); continue; }
      // A plural form may leave out {count} (e.g. "one tool"); every other placeholder must stay.
      const want = placeholders(key).split(',').filter(name => !(typeof value === 'object' && name === 'count')).filter(Boolean);
      for (const name of want) if (!text.includes(`{${name}}`)) problems.push(`${lang}: ${JSON.stringify(key)} lost {${name}}`);
      for (const name of placeholders(text).split(',').filter(Boolean)) if (!key.includes(`{${name}}`)) problems.push(`${lang}: ${JSON.stringify(key)} added {${name}}`);
      if (tags(text) !== tags(key)) problems.push(`${lang}: ${JSON.stringify(key)} must keep the tags ${tags(key) || '(none)'}`);
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { keys, problems } = await extractKeys();
  if (process.argv.includes('--check')) {
    const only = process.argv[process.argv.indexOf('--check') + 1], languages = only ? [only] : LANGUAGES;
    if (only && !LANGUAGES.includes(only)) { console.error(`Unknown language: ${only}`); process.exit(1); }
    for (const lang of languages) problems.push(...checkCatalog(lang, await readCatalog(lang), keys));
    console.log(problems.length ? problems.join('\n') : `${keys.size} keys; catalogs complete: ${languages.join(', ')}.`);
    process.exit(problems.length ? 1 : 0);
  }
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(JSON.stringify(Object.fromEntries(keys), null, 2));
}
