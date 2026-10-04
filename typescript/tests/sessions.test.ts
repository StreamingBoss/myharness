import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../src/node/sessions.js";

test("session store atomically saves, loads, lists, and rejects malformed records", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "myharness-sessions-"));
  const store = new SessionStore(directory);
  const first = store.create({ model: "qwen", context_length: 100, workspace: "/tmp/work" }, "first");
  first.memory.push({ role: "user", content: "keep" });
  await store.save(first);
  assert.deepEqual((await store.load(first.id)).memory, first.memory);
  const second = store.create({ model: "qwen", context_length: 100, workspace: "/tmp/work" }, "second");
  await store.save(second);
  assert.equal((await store.list()).length, 2);
  await writeFile(path.join(directory, "bad.json"), "{}", "utf8");
  assert.equal((await store.list()).length, 2);
  assert.throws(() => store.validate({}), /supported/);
});
