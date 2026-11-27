import { runGit, withGitObjectSession } from "./git.js";
import { commitMessage, refTarget, repoContext } from "./engine.js";
import { metadataSnapshot } from "./metadata.js";
import { withNotesLock } from "./notes.js";
import { buildRetentionCommit, checkedRefUpdate, recordDependencies, RETENTION_REF } from "./git-carriers.js";
import { CliError } from "./errors.js";
import { faultPoint, gatePoint } from "./faults.js";

const NOTES_REF = "refs/notes/vcs-lab";

export function retainMetadata(options = {}) {
  if (Boolean(options.dryRun) === Boolean(options.apply)) {
    throw new CliError("Choose exactly one of --dry-run or --apply for metadata retention.", { code: "usage-conflicting-options" });
  }
  const cwd = options.cwd ?? process.cwd();
  const action = () => withGitObjectSession(cwd, () => retainSnapshot(options, cwd));
  return options.apply ? withNotesLock(cwd, action) : action();
}

function retainSnapshot(options, cwd) {
  const notesTip = refTarget(NOTES_REF, cwd);
  const retentionBefore = refTarget(RETENTION_REF, cwd);
  const snapshot = metadataSnapshot({ cwd, portableOnly: true });
  const dependencies = recordDependencies(snapshot.portableRecords, cwd, { validate: false });
  const marker = `Retention-Notes: ${notesTip}`;
  const alreadyRetained = retentionBefore && commitMessage(retentionBefore, cwd).split("\n").includes(marker);
  const wouldChange = dependencies.size > 0 && !alreadyRetained;
  if (refTarget(NOTES_REF, cwd) !== notesTip || refTarget(RETENTION_REF, cwd) !== retentionBefore) {
    throw new CliError("Causal metadata changed during retention inspection; retry.", { code: "stale-input" });
  }
  const result = {
    schema: "vcs-lab.metadata-retention/v1", mode: options.apply ? "apply" : "preview",
    notesTip, retentionBefore, retentionAfter: retentionBefore,
    eligibleRecords: snapshot.portableRecords.length,
    quarantinedRecords: snapshot.scopes.sharedPortable.notes.quarantinedCount,
    objects: { commits: 0, trees: 0, blobs: 0 }, wouldChange, changed: false,
    diagnostics: snapshot.diagnostics,
  };
  for (const type of dependencies.values()) result.objects[`${type}s`] += 1;
  if (options.apply && wouldChange) {
    const next = buildRetentionCommit(dependencies, retentionBefore, cwd, {
      message: `Backfill vcs-lab object retention\n\n${marker}`,
    });
    gatePoint("retention:backfill-before-publish");
    faultPoint("retention:before-publish");
    const zero = "0".repeat(repoContext(cwd).objectFormat === "sha256" ? 64 : 40);
    runGit(["update-ref", "--stdin"], { cwd, input: [
      "start", `verify ${NOTES_REF} ${notesTip ?? zero}`,
      checkedRefUpdate(RETENTION_REF, next, retentionBefore), "prepare", "commit", "",
    ].join("\n") });
    result.retentionAfter = next;
    result.changed = true;
  }
  return result;
}

export function formatRetention(result) {
  return [
    `Retention ${result.mode}: ${result.changed ? "updated" : result.wouldChange ? "update available" : "no change"}`,
    `Eligible records: ${result.eligibleRecords}`,
    `Quarantined records: ${result.quarantinedRecords}`,
    `Dependencies: ${result.objects.commits} commits, ${result.objects.trees} trees, ${result.objects.blobs} blobs`,
    `Notes: ${result.notesTip ?? "none"}`,
    `Retention before: ${result.retentionBefore ?? "none"}`,
    `Retention after: ${result.retentionAfter ?? "none"}`,
    ...result.diagnostics.map(entry => `${entry.code}: ${entry.message}`),
  ].join("\n");
}
