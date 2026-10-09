import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import test from 'node:test';

test('project controls render refreshed backend state and report rejected projects or failed refreshes', async () => {
  const html = await readFile('web/templates/index.html', 'utf8');
  const source = html.slice(html.indexOf('async function setProject('), html.indexOf('\nconst browseBtn'));
  for (const outcome of ['success', 'rejected', 'refresh-failed']) {
    const state = { project: '/new-project', session: { id: 'current' }, tools: [{ name: 'read_file' }] };
    const requests: { url: string; options: RequestInit | undefined }[] = [], events: { type: string; detail: unknown }[] = [], dividers: string[] = [];
    const projectError = { textContent: 'old error' };
    const context = {
      formatFailure: (_failure: unknown, reason: string) => reason,
      projectInput: { value: '/new-project' }, projectError,
      api: (path: string) => path,
      backendFetch: async (url: string, options?: RequestInit) => {
        requests.push({ url, options });
        return url === '/project'
          ? Response.json(outcome === 'rejected' ? { error: 'Folder is unavailable' } : { path: state.project }, { status: outcome === 'rejected' ? 400 : 200 })
          : Response.json(state, { status: outcome === 'refresh-failed' ? 503 : 200 });
      },
      window: { dispatchEvent: (event: { type: string; detail: unknown }) => events.push(event) },
      CustomEvent: class { constructor(readonly type: string, readonly options: { detail: unknown }) {} get detail() { return this.options.detail; } },
      addDivider: (text: string) => dividers.push(text),
      setProject: undefined as unknown as () => Promise<void>,
    };
    new Script(source, { filename: 'project-controls.js' }).runInNewContext(context);
    await context.setProject();
    assert.equal(requests[0]!.options!.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests[0]!.options!.body)), { path: state.project });
    if (outcome === 'rejected') {
      assert.equal(requests.length, 1); assert.equal(projectError.textContent, 'Folder is unavailable');
    } else {
      assert.equal(requests[1]!.url, '/bootstrap');
      if (outcome === 'success') {
        assert.equal(projectError.textContent, ''); assert.equal(events[0]!.type, 'myharness:state'); assert.deepEqual(events[0]!.detail, state);
        assert.deepEqual(dividers, ['— project folder: /new-project —']);
      } else assert.match(projectError.textContent, /state could not be refreshed/);
    }
    if (outcome !== 'success') { assert.deepEqual(events, []); assert.deepEqual(dividers, []); }
  }
});
