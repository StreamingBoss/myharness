import path from "node:path";

import { NodeHarness } from "./harness.js";
import { createHarnessServer } from "./http.js";
import { OllamaAdapter } from "./ollama.js";

const model = process.env.MYHARNESS_MODEL ?? "qwen3:8b";
const workspace = path.resolve(process.env.MYHARNESS_WORKSPACE ?? "workspace");
const port = Number.parseInt(process.env.MYHARNESS_PORT ?? "5001", 10);
const ollama = new OllamaAdapter(fetch, process.env.OLLAMA_URL ?? "http://localhost:11434");
const contextLength = await ollama.contextLength(model);
const harness = new NodeHarness({ workspace, model, contextLength, ollama });
const server = createHarnessServer(harness);

server.listen(port, () => {
  console.log(`TypeScript harness on http://localhost:${port}`);
  console.log(`Model: ${model} (${contextLength} tokens)`);
  console.log(`Workspace: ${workspace}`);
});
