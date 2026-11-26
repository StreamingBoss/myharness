/* Interface language. Display only: nothing here changes what the harness sends to a model.
   English is the source. Each catalog (static/i18n-<lang>.js) maps an English text to its translation, so any text a
   catalog lacks stays in English. A text with a {count} placeholder may map to an object of Intl.PluralRules forms
   ({ one, few, many, other }) instead of a string; tn() texts are keyed by their English plural form.
   Markup is translated by apply(); scripts call t() and tn(). Keys are listed by scripts/i18n-keys.mjs. */
(function (global) {
  // Same codes and names as the language menu of harnessarium.com, which shares the saved choice ("lang").
  var LANGUAGES = [
    ['en', 'English'], ['zh', '简体中文'], ['es', 'Español'], ['pt', 'Português (Brasil)'], ['ja', '日本語'], ['ru', 'Русский'],
    ['de', 'Deutsch'], ['fr', 'Français'], ['ko', '한국어'], ['tr', 'Türkçe'], ['hi', 'हिन्दी'], ['it', 'Italiano']
  ];
  var LOCALES = { zh: 'zh-CN', pt: 'pt-BR' };
  var codes = LANGUAGES.map(function (entry) { return entry[0]; });
  var known = function (code) { code = String(code || '').toLowerCase().split('-')[0]; return codes.indexOf(code) >= 0 ? code : ''; };

  // A ?lang= link wins for this page only; then the visitor's saved menu choice; then the browser's languages.
  function choose() {
    var fromLink = '', saved = '', browser = [];
    try { fromLink = known(new URLSearchParams(location.search).get('lang')); } catch (e) {}
    try { saved = known(localStorage.getItem('lang')); } catch (e) {}
    try { browser = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]; } catch (e) {}
    if (fromLink) return fromLink;
    if (saved) return saved;
    for (var i = 0; i < browser.length; i++) if (known(browser[i])) return known(browser[i]);
    return 'en';
  }

  var lang = choose(), locale = LOCALES[lang] || lang, catalog = {}, rules = null;
  try { rules = new Intl.PluralRules(locale); } catch (e) {}

  var normalize = function (text) { return String(text).replace(/\s+/g, ' ').trim(); };
  var number = function (value) { return typeof value === 'number' ? value.toLocaleString(locale) : String(value); };
  function fill(text, vars) {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, function (match, name) { return Object.prototype.hasOwnProperty.call(vars, name) ? number(vars[name]) : match; });
  }
  function translated(text, count) {
    var value = catalog[text];
    if (value && typeof value === 'object') value = value[rules && typeof count === 'number' ? rules.select(count) : 'other'] || value.other;
    return typeof value === 'string' ? value : undefined;
  }
  function t(text, vars) {
    var value = translated(text, vars && vars.count);
    return fill(value === undefined ? text : value, vars);
  }
  // one and other are the English singular and plural; {count} is the number, formatted for the language.
  function tn(one, other, count, vars) {
    var all = { count: count }, value = translated(other, count);
    for (var name in vars || {}) all[name] = vars[name];
    return fill(value === undefined ? (count === 1 ? one : other) : value, all);
  }

  // Rich text: an element marked data-i18n-html is keyed by its text with each child element written as <tag>…</tag>.
  // The translation uses the same tags; each tag reuses the original child of that name, in order, so ids, links and
  // attributes are kept and nothing from a catalog is parsed as HTML.
  function richKey(element) {
    var key = '';
    element.childNodes.forEach(function (child) {
      if (child.nodeType === 3) key += child.data;
      else if (child.nodeType === 1) { var tag = child.tagName.toLowerCase(); key += '<' + tag + '>' + child.textContent + '</' + tag + '>'; }
    });
    return normalize(key);
  }
  function applyRich(element) {
    var value = catalog[richKey(element)];
    if (typeof value !== 'string') return;
    var spare = {};
    Array.prototype.forEach.call(element.children, function (child) {
      var tag = child.tagName.toLowerCase(); (spare[tag] = spare[tag] || []).push(child);
    });
    var parts = [], pattern = /<([a-z0-9]+)>([\s\S]*?)<\/\1>/g, last = 0, match;
    while ((match = pattern.exec(value))) {
      if (match.index > last) parts.push(document.createTextNode(value.slice(last, match.index)));
      var original = (spare[match[1]] || []).shift();
      if (original) { if (original.textContent !== match[2]) original.textContent = match[2]; parts.push(original); }
      else parts.push(document.createTextNode(match[2]));
      last = pattern.lastIndex;
    }
    if (last < value.length) parts.push(document.createTextNode(value.slice(last)));
    element.replaceChildren.apply(element, parts);
  }

  // Elements marked translate="no" (brand and product names, raw output) are left as they are, attributes included.
  var ATTRIBUTES = ['title', 'placeholder', 'aria-label'];
  function translateAttributes(element) {
    ATTRIBUTES.forEach(function (name) {
      if (!element.hasAttribute(name)) return;
      var value = catalog[normalize(element.getAttribute(name))];
      if (typeof value === 'string') element.setAttribute(name, value);
    });
  }
  function visit(node) {
    if (node.nodeType === 3) {
      var key = normalize(node.data), value = catalog[key];
      if (key && typeof value === 'string') node.data = node.data.match(/^\s*/)[0] + value + node.data.match(/\s*$/)[0];
      return;
    }
    if (node.nodeType !== 1 || node.getAttribute('translate') === 'no' || node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
    translateAttributes(node);
    if (node.hasAttribute('data-i18n-html')) { applyRich(node); Array.prototype.forEach.call(node.querySelectorAll('*'), translateAttributes); return; }
    Array.prototype.slice.call(node.childNodes).forEach(visit);
  }
  function apply(root) { if (lang !== 'en' && root) visit(root); }

  // The language menu in the header: the choice is saved for this site, so the home page follows it too.
  function menu(select) {
    if (!select) return;
    LANGUAGES.forEach(function (entry) {
      var option = new Option(entry[1], entry[0], false, entry[0] === lang);
      option.lang = entry[0];
      select.add(option);
    });
    select.addEventListener('change', function () {
      try { localStorage.setItem('lang', select.value); } catch (e) {}
      var url = new URL(location.href); url.searchParams.delete('lang');
      location.replace(url.href);
    });
  }

  global.MyHarnessI18n = {
    lang: lang, locale: locale, languages: LANGUAGES, t: t, tn: tn, number: number, apply: apply, menu: menu,
    add: function (entries) { catalog = entries; document.documentElement.lang = lang; },
    keyOf: richKey
  };

  if (lang !== 'en') {
    var self = document.currentScript && document.currentScript.src;
    var source = self ? self.replace(/i18n\.js(\?.*)?$/, 'i18n-' + lang + '.js') : 'static/i18n-' + lang + '.js';
    // Loaded before the page's other scripts run, so every text is translated the first time it is shown.
    document.write('<script src="' + source + '"><\/script>');
  }
})(globalThis);
