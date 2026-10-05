import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import test from 'node:test';

// Execute the actual UI helper, with rendering observed through small DOM fakes.
const html = readFileSync(new URL('../web/templates/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function completeReply('), html.indexOf('\nasync function sendMessage('));
assert.ok(source.startsWith('function completeReply('));
const calls = [];
const context = {
  renderChatBubble(role, text) { const bubble = { role, text }; calls.push(bubble); return bubble; },
  renderMarkdown(bubble, text) { bubble.text = text; },
};
new Script(source, { filename: 'ui-response-helper.js' }).runInNewContext(context);

test('terminal content completes the live and replayed answer without duplication', () => {
  const [bubble, text] = context.completeReply({content: 'Hello'}, null, '');
  assert.equal(text, 'Hello');
  assert.equal(bubble.text, 'Hello');
  assert.equal(calls.length, 1);
  const [same] = context.completeReply({content: 'Hello'}, bubble, 'Hel');
  assert.equal(same, bubble);
  assert.equal(bubble.text, 'Hello');
  assert.equal(context.completeReply({content: 'Hello'}, bubble, 'Hello')[0], bubble);
  for (const event of [{}, {content: null}, {content: 1}, {content: ''}]) {
    assert.equal(context.completeReply(event, bubble, 'Hello')[1], 'Hello');
  }
  assert.equal(calls.length, 1);
  assert.match(html, /if \(event.type === "response"\) \[assistant, assistantText\] = completeReply/);
  assert.match(html, /\[assistantDiv, replyText\] = completeReply/);
});

const requestCalls = [];
const requestContext = {
  document: { createElement(tag) { return { tag, children: [], append(value) { this.children.push(value); } }; } },
  terminalEl: { appendChild(value) { requestCalls.push(value); }, scrollHeight: 100 },
};
const requestSource = html.slice(html.indexOf('const SEP ='), html.indexOf('\nfunction replaySessionEvent'));
new Script(requestSource, { filename: 'ui-request-helper.js' }).runInNewContext(requestContext);

test('native provider requests highlight user input and preserve request data', () => {
  for (const [provider, wire_request] of [
    ['gemini', { input: [{ type: 'user_input', content: [{ type: 'text', text: 'hello <script> & "world"' }] }, { type: 'model_output', content: [{ type: 'text', text: 'reply' }] }, { type: 'user_input', content: [{ type: 'text', text: 'follow up' }] }] }],
    ['openai', { input: [{ role: 'user', content: 'hello @@USER:0@@' }, { role: 'assistant', content: 'reply' }], store: false }],
    ['anthropic', { messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'reply' }] }],
    ['gemini', { system_instruction: 'no user message', tools: null }],
  ]) {
    const parts = requestContext.nativeRequestParts(wire_request);
    assert.deepEqual(JSON.parse(parts.join('')), wire_request);
    requestContext.printModelRequest({ provider, wire_request }, true);
    const block = requestCalls.at(-1);
    const highlights = block.children.filter(child => child.tag === 'b');
    assert.equal(highlights.length, provider === 'gemini' ? (wire_request.input ? 2 : 0) : 1);
    assert.match(block.children[0], new RegExp('SENT to ' + provider + ' \\(saved\\)'));
    for (const highlight of highlights) assert.match(highlight.textContent, /user/);
  }
  requestContext.printModelRequest({ parts: ['before', 'user input', 'after'] }, false);
  assert.equal(requestCalls.at(-1).children[2].textContent, 'user input');
  requestContext.printBlock('plain', 'plain text');
  assert.equal(requestCalls.at(-1).children[1], 'plain text');
  requestContext.printBlock('empty', ['before', '', 'after']);
  assert.equal(requestCalls.at(-1).children.filter(child => child.tag === 'b').length, 0);
});
