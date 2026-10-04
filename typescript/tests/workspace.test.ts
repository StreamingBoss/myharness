import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceAdapter } from "../src/node/workspace.js";

async function workspace(): Promise<WorkspaceAdapter> {
  const root = await mkdtemp(path.join(tmpdir(), "myharness-ts-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.txt"), "one\ntwo\nthree");
  await writeFile(path.join(root, "empty.txt"), "");
  return new WorkspaceAdapter(root);
}

test("workspace adapter confines paths and lists sorted files", async () => {
  const files = await workspace();
  await writeFile(path.join(files.root, "z.txt"), "z");
  await mkdir(path.join(files.root, "empty"));
  assert.equal(await files.listFiles(), "empty/\nempty.txt\nsrc/\nz.txt");
  assert.equal(await files.listFiles("empty"), "(empty folder)");
  await assert.rejects(() => files.listFiles("../outside"), /outside/);
  assert.equal(files.pathFor(path.join(files.root, "src", "a.txt")), path.join(files.root, "src", "a.txt"));
  assert.equal(files.pathFor("/src/a.txt"), path.join(files.root, "src", "a.txt"));
  assert.equal(files.pathFor(files.root), files.root);
});

test("workspace adapter reads numbered ranges and protects its output cap", async () => {
  const files = await workspace();
  assert.equal(await files.readNumbered("src/a.txt", 2, 3), "   2: two\n   3: three");
  assert.equal(await files.readNumbered("empty.txt"), "(empty file)");
  assert.match(await files.readNumbered("src/a.txt", 9), /past the end/);
  await assert.rejects(() => files.readNumbered("src/a.txt", 0), /start_line/);
  await assert.rejects(() => files.readNumbered("src/a.txt", 3, 2), /start_line/);
  await writeFile(path.join(files.root, "long.txt"), "x".repeat(20_000));
  assert.match(await files.readNumbered("long.txt"), /long line truncated/);
});
