export { timeoutDuration } from './error-messages.js';
import { explainError, timeoutDuration } from './error-messages.js';
/** Safe, structured diagnostics shared by headless backends and their transports. */
export type FailureSource = 'model' | 'harness' | 'bridge' | 'transport';
export interface FailureDetails { source: FailureSource; component: string; reason: string; recovery: string; timeoutMs?: number }
export class DiagnosticError extends Error {
  constructor(readonly failure: FailureDetails) { super(failure.reason); }
}
export function failureDetails(error: unknown, source: FailureSource = 'harness', component = 'Harness backend', recovery = 'Check the selected workspace and harness settings, then retry.', timeoutMs?: number): FailureDetails {
  if (error instanceof Error && 'failure' in error && error.failure) return error.failure as FailureDetails;
  return { source, component, reason: String(error instanceof Error ? error.message : error), recovery, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}
/** Callers supply a safe fallback when a transport did not provide details. */
export function failureText(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !('failure' in error) || !error.failure) return presentFailure(undefined, fallback);
  return presentFailure(error.failure as FailureDetails, fallback);
}

/** Presentation only: the source and raw reason remain part of the diagnostic. */
export function presentFailure(failure: FailureDetails | undefined, fallback: string): string {
  const reason = failure ? failure.reason : fallback;
  const explanation = explainError(reason);
  if (!failure && !explanation) return fallback;
  const sources = { model: 'Model service', harness: 'Harness', bridge: 'Connection to your local computer', transport: 'Browser connection to the harness' };
  const where = failure ? `\nWhere: ${sources[failure.source]} (${failure.component})` : '';
  const message = explanation ? explanation.message : `The ${sources[failure!.source].toLowerCase()} could not complete this action.`;
  const next = explanation ? explanation.next : failure!.recovery;
  const statedLimit = reason.match(/\[Time limit: ([^\]]+)\]/);
  const timeout = failure?.timeoutMs === undefined ? (statedLimit ? `\nTime limit: ${statedLimit[1]}.` : '') : `\nTime limit: ${timeoutDuration(failure.timeoutMs)}.`;
  return `${message}${where}${timeout}\nTo continue: ${next}\n\nTechnical details: ${reason}`;
}
