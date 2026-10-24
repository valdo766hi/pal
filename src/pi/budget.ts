import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";

/** Request-hook throws are advisory: signal the native task's abort, without joining our own invocation. */
export async function abortBudgetTask(harness: Harness, task: TaskId, context: Context): Promise<never> {
  let cancelled = () => {};
  const signalled = new Promise<void>((resolve) => {
    cancelled = resolve;
    context.abortSignal?.addEventListener("abort", cancelled, { once: true });
    if (context.abortSignal?.aborted) resolve();
  });
  try {
    await Promise.race([harness.abortTask(task, BACKGROUND_CONTEXT), signalled]);
  } finally {
    context.abortSignal?.removeEventListener("abort", cancelled);
  }
  throw new Error("task budget exhausted");
}
