export { timeoutDuration } from './error-messages.js';
import { explainError, timeoutDuration } from './error-messages.js';
import { english, type Translator } from './text.js';
/** Safe, structured diagnostics shared by headless backends and their transports. */
export type FailureSource = 'model' | 'harness' | 'bridge' | 'helper' | 'transport';
export interface FailureDetails { source: FailureSource; component: string; reason: string; recovery: string; timeoutMs?: number }
export class DiagnosticError extends Error {
  constructor(readonly failure: FailureDetails) { super(failure.reason); }
}
export function failureDetails(error: unknown, source: FailureSource = 'harness', component = 'Harness backend', recovery = 'Check the selected workspace and harness settings, then retry.', timeoutMs?: number): FailureDetails {
  if (error instanceof Error && 'failure' in error && error.failure) return error.failure as FailureDetails;
  return { source, component, reason: String(error instanceof Error ? error.message : error), recovery, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}
/** Callers supply a safe fallback when a transport did not provide details. */
export function failureText(error: unknown, fallback: string, text: Translator = english): string {
  if (!(error instanceof Error) || !('failure' in error) || !error.failure) return presentFailure(undefined, fallback, text);
  return presentFailure(error.failure as FailureDetails, fallback, text);
}

/** Presentation only: the source and raw reason remain part of the diagnostic. The raw reason is never translated. */
export function presentFailure(failure: FailureDetails | undefined, fallback: string, text: Translator = english): string {
  const reason = failure ? failure.reason : fallback;
  const explanation = explainError(reason);
  if (!failure && !explanation) return fallback;
  const sources = { model: text.t('Model service'), harness: text.t('Harness'), bridge: text.t('Connection to your local computer'), helper: text.t('Tokenizer helper on this computer'), transport: text.t('Browser connection to the harness') };
  const unexplained = { model: text.t('The model service could not complete this action.'), harness: text.t('The harness could not complete this action.'), bridge: text.t('The connection to your local computer could not complete this action.'), helper: text.t('The tokenizer helper on this computer could not complete this action.'), transport: text.t('The browser connection to the harness could not complete this action.') };
  const where = failure ? '\n' + text.t('Where: {place} ({component})', { place: sources[failure.source], component: failure.component }) : '';
  const message = explanation ? text.t(explanation.message) : unexplained[failure!.source];
  const next = explanation ? text.t(explanation.next) : failure!.recovery;
  const statedLimit = reason.match(/\[Time limit: ([^\]]+)\]/);
  const limit = failure?.timeoutMs === undefined ? statedLimit?.[1] : timeoutDuration(failure.timeoutMs, text);
  const timeout = limit === undefined ? '' : '\n' + text.t('Time limit: {limit}.', { limit });
  return `${message}${where}${timeout}\n${text.t('To continue: {next}', { next })}\n\n${text.t('Technical details:')} ${reason}`;
}
