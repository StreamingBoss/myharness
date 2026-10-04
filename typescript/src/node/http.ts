import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { NodeHarness, type TurnAction } from "./harness.js";

async function body(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text ? JSON.parse(text) : {};
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

/** Minimal HTTP/NDJSON adapter for the same public actions used by the browser. */
export function createHarnessServer(harness: NodeHarness): Server {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/bootstrap") {
        const state = harness.inspect();
        send(response, 200, { model: state.model, context_length: state.contextLength,
          last_prompt_tokens: state.lastPromptTokens, memory: JSON.stringify(state.memory),
          tools: [], agents: [], prompts: [], project: state.workspace, locked: null,
          session: { settings: { use_memory: true, tools: [], ask_approval: true } }, sessions: [] });
        return;
      }
      if (request.method === "POST" && request.url === "/reset") {
        harness.reset();
        send(response, 200, { memory: "[]" });
        return;
      }
      if (request.method === "POST" && request.url === "/stop") {
        harness.stop();
        send(response, 200, { stopped: true });
        return;
      }
      if (request.method === "POST" && request.url === "/approve") {
        const value = await body(request) as { id?: unknown; approved?: unknown };
        send(response, 200, { ok: typeof value.id === "string" && harness.approve(value.id, value.approved === true) });
        return;
      }
      if (request.method === "POST" && request.url === "/chat") {
        const action = await body(request) as TurnAction;
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        for await (const event of harness.submit(action)) response.write(`${JSON.stringify(event)}\n`);
        response.end();
        return;
      }
      send(response, 404, { error: "Not found" });
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
