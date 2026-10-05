import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const archive = path.resolve('dist/myharness-browser.zip');
await rm(archive, { force: true });
await promisify(execFile)('zip', ['-q', '-r', archive, '.'], { cwd: path.resolve('dist/browser') });
console.log(`Browser distribution packaged: ${archive}`);
