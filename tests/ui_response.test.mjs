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
