import { spawn } from 'node:child_process';
import { characters } from '../format.js';

export async function executeCommand(command: string, workspace: string, signal: AbortSignal, timeout = 60_000): Promise<{ output: string; status: string }> {
    return await new Promise<{ output: string; status: string }>((resolve, reject) => {
      const child = spawn('bash', ['-c', command], { cwd: workspace, detached: true });
      let output = '', total = 0, killed = '';
      const collect = (chunk: string) => { total += characters(chunk); output = [...(output + chunk)].slice(-10_000).join(''); };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const kill = (reason: string) => {
        if (killed) return;
        killed = reason;
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      };
      const abort = () => kill('stopped by the user');
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => kill(`timed out after ${timeout / 1000} seconds`), timeout);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      child.on('error', error => { cleanup(); reject(error); });
      child.on('close', code => { cleanup(); resolve({ output: total > 10_000 ? `[first ${total - 10_000} characters cut]\n${output}` : output, status: killed || `exit code ${code}` }); });
      if (signal.aborted) abort();
    });
}
