/**
 * A bound on how long one process a check starts may run. Every process the
 * generated-history corpus and the native-kind comparison start takes
 * seconds; one that never ends (a Git or a `cst` that spins on what it was
 * given) must fail its check, not hold the suite until the job's timeout.
 */

/** How long one process may run: pass it as `spawn`'s `timeout`. */
export const PROCESS_LIMIT = 5 * 60 * 1000;

/**
 * Lets `child`, spawned with `timeout: PROCESS_LIMIT`, close when it is
 * stopped even if a process it started still holds its output. Returns what
 * to add to its stderr, given the signal `close` reports.
 */
export function bounded(child) {
  child.on("exit", () => {
    if (child.killed) {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  });
  return (signal) => {
    if (child.killed) return `\n(stopped after ${PROCESS_LIMIT / 1000} s)`;
    return signal ? `\n(ended by ${signal})` : "";
  };
}
