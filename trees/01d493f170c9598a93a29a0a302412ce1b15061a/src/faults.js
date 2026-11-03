/**
 * Deterministic fault injection for the failure-boundary tests, whose exit
 * criterion is that no partial receipt and no unsafe ref survives an
 * interrupted operation (GitHub issue #14).
 *
 * A real interruption is a kill: the process stops between two Git mutations
 * with no unwinding, no `finally`, and no chance to tidy up. Testing that with
 * a signal and a sleep is flaky and proves nothing repeatable, so the mutating
 * paths name the points where an interruption would be most damaging and this
 * module turns one of them into a hard exit when the environment asks for it.
 *
 * Three stretches are named, for both reconciliation and causal rebase:
 *
 * - **publication** (`*:before-publish`, `*:mid-publish`, `*:before-receipt`,
 *   `*:before-clear`), where shared records reach the notes ref;
 * - **the journal advance** (`*:before-journal-advance`), the one point where
 *   Git is knowingly ahead of the journal, because the pick has been committed
 *   and the journal has not yet been told;
 * - **abort cleanup** (`*:abort-before-clear`), where the history has been
 *   restored but the journal still advertises a pending operation.
 *
 * `process.exit` is deliberate rather than a thrown error: throwing would run
 * cleanup the real failure would not, and the whole question is what the
 * repository looks like when cleanup never happened.
 *
 * A second hook, `gatePoint`, holds a process at a named point until a test
 * releases it. Where a fault asks what a repository looks like when one
 * process stops, a gate asks what two processes do to each other: it parks
 * one inside a critical section while the other runs to completion, so an
 * interleaving a real race would produce once in a thousand runs is produced
 * every run. Named gates include:
 *
 * - **`notes:after-read`**, inside `appendNote` between reading a commit's
 *   note container and writing it back: the read-modify-write two publishers
 *   would otherwise interleave.
 * - **`workspaces:after-read`**, after a registry writer reads its snapshot,
 *   while holding the shared registry lock; also a fault point for a crashed
 *   holder before any Git mutation.
 * - **`workspaces:lock-contended`**, when a competing registry writer has
 *   attempted to acquire an already-held lock.
 *
 * Each hook costs one environment read per named point and is inert unless
 * `VLAB_TEST_FAULT` or `VLAB_TEST_GATE` names that point exactly, so neither
 * can fire in ordinary use. They are test-only scaffolding in the same spirit
 * as the session-failure switches in `src/git.js`.
 */
import fs from "node:fs";

/** Exit code used when a fault point fires, distinct from any CliError code. */
export const FAULT_EXIT_CODE = 70;

/** Exit code used when a gate is never released, distinct from a fault. */
export const GATE_EXIT_CODE = 71;

const GATE_TIMEOUT_MS = 30_000;
const GATE_POLL_MS = 20;

/**
 * Stop the process here if `VLAB_TEST_FAULT` names this point. Call sites read
 * as a statement of where an interruption is survivable, so keep the names
 * stable: the tests reference them.
 */
export function faultPoint(name) {
  if (process.env.VLAB_TEST_FAULT === name) {
    process.stderr.write(`vlab: fault injected at ${name}\n`);
    process.exit(FAULT_EXIT_CODE);
  }
}

/**
 * Hold the process here until a test releases it, if `VLAB_TEST_GATE` names
 * this point. The protocol is two files named by `VLAB_TEST_GATE_FILE`: the
 * gated process creates `<file>.reached` on arrival, so the test knows it is
 * inside, and proceeds once `<file>` exists. A gate nobody releases exits
 * with `GATE_EXIT_CODE` after thirty seconds rather than hanging the suite.
 */
export function gatePoint(name) {
  if (process.env.VLAB_TEST_GATE !== name) return;
  const file = process.env.VLAB_TEST_GATE_FILE;
  if (!file) {
    process.stderr.write(`vlab: gate ${name} requested without VLAB_TEST_GATE_FILE\n`);
    process.exit(GATE_EXIT_CODE);
  }
  fs.writeFileSync(`${file}.reached`, `${process.pid}\n`);
  const deadline = Date.now() + GATE_TIMEOUT_MS;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) {
      process.stderr.write(`vlab: gate ${name} was never released\n`);
      process.exit(GATE_EXIT_CODE);
    }
    Atomics.wait(cell, 0, 0, GATE_POLL_MS);
  }
}
