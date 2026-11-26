/** Presentation text hook. Callers that show text to a person may pass a translator; the default is the English source.
 *  The harness never translates what it sends to a model or stores in a session. */
export interface Translator {
  /** text is the English source; {name} placeholders are filled from vars. */
  t(text: string, vars?: Record<string, string | number>): string;
  /** one and other are the English singular and plural; {count} is filled with count. */
  tn(one: string, other: string, count: number, vars?: Record<string, string | number>): string;
}

const fill = (text: string, vars: Record<string, string | number> = {}): string =>
  text.replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(vars, name) ? String(vars[name]) : match);

export const english: Translator = {
  t: fill,
  tn: (one, other, count, vars) => fill(count === 1 ? one : other, { count, ...vars }),
};

/** The page's translator (web/static/i18n.js) when it is loaded, otherwise English. */
export function pageTranslator(): Translator {
  const page = (globalThis as { MyHarnessI18n?: Translator }).MyHarnessI18n;
  return page ?? english;
}
