import { GIT_NO_RERERE, runGit } from "./git.js";
import {
  assertClean,
  changeIdForCommit,
  commitSubject,
  currentHead,
  listCommits,
  mergeBase,
  resolveRevision,
  treeId,
} from "./engine.js";
import { CliError } from "./errors.js";
import { newId } from "./ids.js";
import { appendNote } from "./notes.js";
import { carryProvenanceSafely } from "./provenance.js";

function landingInputs(sourceRef, cwd) {
  const targetBefore = currentHead(cwd);
  const sourceHead = resolveRevision(sourceRef, cwd);
  const base = mergeBase(targetBefore, sourceHead, cwd);
  const absorbedCommits = listCommits(base, sourceHead, cwd);
  const absorbedChanges = absorbedCommits.map((commit) =>
    changeIdForCommit(commit, cwd),
  );
  return {
    targetBefore,
    sourceHead,
    base,
    absorbedCommits,
    absorbedChanges,
  };
}

function commitLandingMessage(mode, sourceRef, sourceHead, absorbedChanges, custom) {
  const title = custom ??
    `${mode === "compact" ? "Compact merge" : "Hard squash"} ${sourceRef}`;
  const trailers = [
    `Landing-Mode: ${mode}`,
    `Source-Revision: ${sourceHead}`,
  ];
  for (const changeId of absorbedChanges) trailers.push(`Absorbs: ${changeId}`);
  return `${title}\n\n${trailers.join("\n")}`;
}

export function land(sourceRef, mode, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  assertClean(cwd);
  const inputs = landingInputs(sourceRef, cwd);
  const message = commitLandingMessage(
    mode,
    sourceRef,
    inputs.sourceHead,
    inputs.absorbedChanges,
    options.message,
  );

  const mergeArgs =
    mode === "compact"
      ? [...GIT_NO_RERERE, "merge", "--no-ff", "--no-commit", inputs.sourceHead]
      : [...GIT_NO_RERERE, "merge", "--squash", inputs.sourceHead];
  const merged = runGit(mergeArgs, { cwd, allowFailure: true });
  if (!merged.ok) {
    throw new CliError(
      `The ${mode} landing produced conflicts. Resolve them with Git, then commit manually; no receipt was recorded.`,
      { code: "conflict-blocked", details: merged.output },
    );
  }

  runGit(["commit", "-m", message], { cwd });
  const landingCommit = currentHead(cwd);
  const receipt = {
    schema: "vcs-lab.landing/v1",
    type: "landing",
    id: newId("land"),
    mode,
    sourceRef,
    sourceHead: inputs.sourceHead,
    sourceSubject: commitSubject(inputs.sourceHead, cwd),
    targetBefore: inputs.targetBefore,
    landingCommit,
    base: inputs.base,
    absorbedCommits: inputs.absorbedCommits,
    absorbedChanges: inputs.absorbedChanges,
    resultTree: treeId(landingCommit, cwd),
    createdAt: new Date().toISOString(),
  };
  appendNote(landingCommit, receipt, cwd);
  // The case Git cannot represent. A squash landing collapses many commits
  // into one, and `git blame` on the result attributes every line to the
  // landing commit, so who produced the absorbed work is gone. The landing
  // receipt already names the absorbed commits, so their declared provenance
  // carries onto the landing as the union of their actors (FR-ID-08). It is a
  // claim about the landing as a whole, not about any line in it.
  // The carried record is its own note record, not a member of the receipt:
  // the receipt is a `vcs-lab.landing/v1` document and must stay exactly that.
  // `vlab provenance <rev>` is where the result is read back.
  carryProvenanceSafely(inputs.absorbedCommits, landingCommit, null, cwd);
  return receipt;
}
