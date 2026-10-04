export const ESCAPE_NOTE = 'the harness turned literal \\n sequences sent by the model into real line breaks';
export function unescape(text: string): string {
  for (const [escaped, real] of [['\\r\\n', '\n'], ['\\n', '\n'], ['\\t', '\t'], ['\\"', '"']]) text = text.replaceAll(escaped!, real!);
  return text;
}

