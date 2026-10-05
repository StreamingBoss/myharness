/** Loop-hygiene guard: notices a model repeating the exact same tool call. */

/** Consecutive-repeat counts that trigger a reminder; the first is the gentle one. */
export const REPEAT_THRESHOLDS: readonly number[] = [3, 5, 8];
/** Longest argument text quoted back to the model in a detailed reminder. */
export const ARGUMENT_PREVIEW_CHARS = 500;

export interface RepeatReminder {
  tool: string;
  count: number;
  level: "gentle" | "detailed";
  message: string;
}

/** Deep key-sort so argument objects that differ only in property order compare equal. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sorted(record[key])]));
  }
  return value;
}

export function canonicalArguments(value: unknown): string {
  return JSON.stringify(sorted(value));
}

const GENTLE =
  "You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result " +
  "before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.";

function detailed(tool: string, count: number, canonical: string): string {
  const shown = canonical.length <= ARGUMENT_PREVIEW_CHARS
    ? canonical : `${canonical.slice(0, ARGUMENT_PREVIEW_CHARS)}… (+${canonical.length - ARGUMENT_PREVIEW_CHARS} more chars)`;
  return `Repeated tool call detected:\n- tool: ${tool}\n- consecutive_calls: ${count}\n- arguments: ${shown}\n` +
    "The repeated calls are not making progress. Do not call this tool with these exact arguments again. " +
    "Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.";
}

/**
 * Counts consecutive identical calls (same tool, same arguments). Advisory only: it never blocks a call.
 * Refused calls count too, because a model hammering a refused call is exactly the loop worth breaking.
 * Create one per turn, so a new user message always starts a fresh count.
 */
export class RepeatGuard {
  private key = "";
  private count = 0;

  observe(tool: string, args: unknown): RepeatReminder | undefined {
    const canonical = canonicalArguments(args);
    const key = `${tool}\n${canonical}`;
    this.count = key === this.key ? this.count + 1 : 1;
    this.key = key;
    const index = REPEAT_THRESHOLDS.indexOf(this.count);
    if (index < 0) return undefined;
    return index === 0
      ? { tool, count: this.count, level: "gentle", message: GENTLE }
      : { tool, count: this.count, level: "detailed", message: detailed(tool, this.count, canonical) };
  }
}
