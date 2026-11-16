/** Plain-language explanations. Raw diagnostics remain available for troubleshooting. */
export interface ErrorExplanation { message: string; next: string }
const explanations: [RegExp, string, string][] = [
  [/Tokenizer helper (unavailable|is disconnected|connection is unavailable|denied)|not allowed to use the tokenizer helper/i, 'The page could not use the tokenizer helper on this computer.', 'You can keep chatting. Check that the helper is running and was started for this website, then reconnect it in the token viewer.'],
  [/Origin|loopback|local.network permission|HTTP loopback/i, 'The browser could not access the local service.', 'Check the service address in Settings and allow local-network access if your browser asks. The service must allow this website address, including http or https and its port.'],
  [/credential.*locked|credentials were locked|cancelled by credential locking/i, 'Your connections were locked, so this operation was stopped.', 'Reconnect your model in Settings: enter its API key again, or choose Ollama.'],
  [/Enter.*API key|API key.*before continuing|HTTP (401|403)/i, 'The model or service needs a valid access key.', 'Enter the correct API key in the connect card or in Settings. Keys are kept in memory only, so enter yours again after reloading the page. Check that your account can use the selected model.'],
  [/HTTP 402|credits are used up|no credits left/i, 'The model service says this account has no credits left.', 'Add credits in your provider account, or choose a model that is free (on OpenRouter, an ID ending in :free). Some providers only give a small starter credit.'],
  [/HTTP 429|Quota or rate limit/i, 'The model service has reached a usage limit.', 'Wait before retrying, or check the usage allowance in your model-provider account.'],
  [/HTTP 404|model.*not found|model.*not installed/i, 'The selected model or service could not be found.', 'Check the selected model and service address. For Ollama, make sure the model is installed.'],
  [/Could not connect to (Ollama|gemini|openai|anthropic|openrouter|groq|mistral|cerebras|custom)|request failed.*HTTP|HTTP 5\d\d|fetch failed|Failed to fetch|network connection/i, 'The model or service could not be reached.', 'Check that the service is running and your network connection works, then retry. For a local model, check its address in Settings and that it allows this website (OLLAMA_ORIGINS).'],
  [/empty reply|empty or incomplete summary/i, 'The model did not return a usable answer.', 'Send your message again. If this keeps happening, try another model.'],
  [/stream ended|stream.*completion|Model response (failed|blocked|length)|generation failed/i, 'The model stopped before it finished its answer.', 'Retry your message. If the answer reached its length limit, increase the output limit or ask for a shorter answer.'],
  [/Invalid tool|Missing required argument|Unknown tool|bad arguments|argument.*tool|tool call.*missing/i, 'The model asked to use a tool with missing or invalid information.', 'Ask the model to try again with the correct tool information. Check Technical details if the problem repeats.'],
  [/nobody answered the approval|no answer/i, 'The action was not run because nobody approved it in time.', 'Ask for the action again if you still want it, then answer the approval request.'],
  [/already running|while.*running|busy|idle/i, 'Another operation is still running.', 'Wait for it to finish, or press Stop before trying this action again.'],
  [/does not exist|ENOENT/i, 'The requested file or folder could not be found.', 'Check its name and the selected project folder, then try again.'],
  [/saved project folder.*missing|not a folder|existing.*directory|could not be opened/i, 'The selected project folder could not be opened.', 'Choose an existing folder that this computer can access.'],
  [/permission|not granted|access.*denied|EACCES|EPERM/i, 'Permission to perform this action is missing.', 'Allow access to the selected folder. Retry only after granting the access you intend to allow.'],
  [/file changed|changed after.*proposal|changed after.*read/i, 'The file changed since the harness last read it.', 'Ask the model to read the file again and propose a new change before you approve it.'],
  [/outside.*workspace|escape|symlink/i, 'This file is outside the selected project folder or points outside it.', 'Choose the correct project folder, then ask the model to use a file inside that folder.'],
  [/unsupported|not available|does not support|does not provide/i, 'This feature is unavailable with the current connection.', 'Check the active tools and the connected model in Settings. A web page cannot run commands on your computer; use the local Node edition for that.'],
  [/Tokenizer helper is not installed|Could not start tokenizer|tokenizer.*not.*installed/i, 'The program needed to inspect tokens is not installed or could not start.', 'You can keep chatting. Build or reinstall the tokenizer program next to the tokenizer helper; TOKENIZATION.md has the steps.'],
  [/Tokenizer.*timed out|tokenizer.*deadline|tokenizer.*ready before|Tokenizer operation was cancelled/i, 'Token inspection did not finish.', 'You can keep chatting. Retry inspection; if it keeps failing, restart the tokenizer helper and check its setup.'],
  [/GGUF|tokenizer|token ID|token bytes|rendering response/i, 'The harness could not inspect this model’s tokens.', 'Chatting is still available. Check the token-inspection setup for the selected model, then retry inspection.'],
  [/context full|Compaction input.*large|summary did not reduce|Nothing to compact/i, 'The conversation does not fit the available model memory, or cannot be shortened further.', 'Use Compact to summarize earlier messages, choose a larger context limit, or start a new conversation. Reset memory makes the model forget earlier messages.'],
  [/save.*failed|Could not save|storage unavailable|IndexedDB/i, 'The harness could not save your work.', 'Keep this tab open. Export your session if possible, then check browser storage or folder access before retrying.'],
  [/no reply within|timed out|time limit|deadline.*elapsed/i, 'The operation did not finish within its time limit.', 'Retry the action. If it keeps taking too long, check the connection or increase the time limit where that setting is available.'],
  [/Backend Worker.*closed|Backend Worker.*stopped|backend.*unavailable/i, 'The browser lost its connection to the harness.', 'Reload this page to restart the harness. Your saved conversation can be loaded again.'],
  [/session.*no longer|active session/i, 'This tab is showing a different conversation from the one currently active.', 'Load the conversation you want to use, then send your message again.'],
  [/conversation.*another provider|history.*missing|result.*missing.*ID/i, 'This conversation cannot be sent to the selected model service.', 'Reconnect the original model service or start a new conversation with the newly selected service.'],
  [/MCP|JSON.RPC|protocol/i, 'A connected tool service could not complete this action.', 'Check that the tool service is running and configured correctly, then reconnect it. Chatting can continue without that tool.'],
];
export function explainError(reason: string): ErrorExplanation | undefined {
  const match = explanations.find(([pattern]) => pattern.test(reason));
  return match ? { message: match[1], next: match[2] } : undefined;
}
/** Durations come from the actual operation limits, including custom settings. */
export function timeoutDuration(ms: number): string {
  if (ms < 1000) return `${ms} ${ms === 1 ? 'millisecond' : 'milliseconds'}`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.floor(seconds / 60), remainder = seconds % 60;
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}${remainder ? ` ${remainder} ${remainder === 1 ? 'second' : 'seconds'}` : ''}`;
}
