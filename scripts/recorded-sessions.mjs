import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

// Recorded sessions ship with the page: <source>/<language>/<file>.json, each a session exported from the app.
// They are copied to <target>/<language>/<file>.json with an index.json listing them in file-name order; the page
// reads a session file only when the visitor opens it. A source folder that does not exist means no recordings.
export async function copyRecordedSessions(source, target) {
  const index = [];
  await mkdir(target, { recursive: true });
  for (const language of (await readdir(source).catch(() => [])).sort()) {
    const folder = path.join(source, language);
    if (!(await stat(folder)).isDirectory()) continue;
    for (const file of (await readdir(folder)).filter(file => file.endsWith('.json')).sort()) {
      const text = await readFile(path.join(folder, file), 'utf8'), session = JSON.parse(text);
      if (session.format !== 'myharness-session') throw new Error(`Recorded session is not a myharness session export: ${language}/${file}`);
      // A recording is public: it must not carry a path from the recording computer.
      if (/\/home\/|\/Users\/|[A-Za-z]:\\\\/.test(text)) throw new Error(`Recorded session mentions a local path (record it in the browser edition): ${language}/${file}`);
      await mkdir(path.join(target, language), { recursive: true });
      await writeFile(path.join(target, language, file), text);
      index.push({ language, file: `${language}/${file}`, name: session.name });
    }
  }
  await writeFile(path.join(target, 'index.json'), JSON.stringify(index));
  return index;
}
