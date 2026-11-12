/**
 * The storage gate on one real repository (ADR-0044 item 2, #309): its
 * store's bytes against what `git gc --aggressive` leaves. Stored bytes must
 * be at most Git's, or with `strictly` fewer.
 *
 * A repository of `real-repositories.js` may carry a known-gap entry,
 * `knownGap: { issue, ceiling, margin }`, listed against the issue that
 * closes it (#343, decision 1). N1 cannot exit while any entry is listed.
 *
 * - A gap passes a store of up to `ceiling` times Git's bytes, and fails
 *   once the store meets the gate, so that its entry is removed.
 * - A margin entry, `margin: true`, is for a store that sits near Git's
 *   bytes and moves across them with the history under test. It passes a
 *   store of up to `ceiling` times Git's bytes on either side, and is
 *   removed by hand once the store is clearly under them.
 */

/**
 * The verdict on a store of `native` bytes against Git's `git`, for the
 * repository `repository`, as `{ gate, problem }`: `gate` is "passed",
 * "failed", "known gap (#n)" or "within margin (#n)", and `problem` says
 * what failed, or is null. `where` names the repository in the problem.
 */
export function storageGate(repository, native, git, where) {
  const meets = repository.strictly ? native < git : native <= git;
  const bound = repository.strictly ? "fewer than" : "at most";
  const gap = repository.knownGap;
  const failed = (problem) => ({ gate: "failed", problem: `${where}: the store takes ${native} bytes, ${problem}` });
  if (!gap) {
    return meets ? { gate: "passed", problem: null } : failed(`which is not ${bound} the ${git} of git gc --aggressive`);
  }
  const kind = gap.margin ? "margin" : "known gap";
  if (native / git > gap.ceiling) {
    return failed(`past the ${kind}'s ceiling of ${gap.ceiling} times the ${git} of git gc --aggressive (#${gap.issue})`);
  }
  if (gap.margin) return { gate: `within margin (#${gap.issue})`, problem: null };
  if (meets) {
    return failed(`${bound} the ${git} of git gc --aggressive: the known gap is closed, so remove its entry (#${gap.issue})`);
  }
  return { gate: `known gap (#${gap.issue})`, problem: null };
}
