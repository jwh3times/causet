import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  abortReconciliation,
  continueReconciliation,
  createCommit,
  cherryPick,
  reconcile,
  reconciliationStatus,
} from "./operations.js";
import { buildMergePlan, formatMergePlan } from "./merge-plan.js";
import {
  assertProofBundleDocument,
  buildProofBundle,
  verifyAgainstRepository,
  verifyProofBundle,
} from "./proof-bundle.js";
import { buildRebasePlan, formatRebasePlan } from "./rebase-plan.js";
import {
  forecastRebase,
  formatForecastEngine,
  formatRebaseForecast,
} from "./rebase-forecast.js";
import {
  abortRebase,
  continueRebase,
  rebaseStatus,
  startRebase,
} from "./rebase-operations.js";
import { land } from "./landings.js";
import { initLab } from "./store.js";
import {
  FORECAST_ENGINES,
  forecastEngine,
  beginGitMetrics,
  endGitMetrics,
  gitObjectSessionEnabled,
  READ_ENGINES,
  readEngine,
  runGit,
  withGitObjectSession,
} from "./git.js";
import {
  commitSubject,
  currentHead,
  describeReadEngines,
  gitVersion,
  historyGraph,
  reachableCommits,
  repoContext,
  resolveRevision,
  runDifferential,
  treeId,
} from "./engine.js";
import {
  archiveWorkspace,
  checkpointWorkspace,
  createWorkspace,
  listWorkspaces,
  moveWorkspace,
  pruneWorkspaces,
  repairWorkspace,
  restoreWorkspace,
} from "./workspaces.js";
import {
  applyPendingSpecMerges,
  benchmarkSpecIndex,
  indexAllSpecs,
  indexSpec,
  pendingSpecMergeStatus,
  planSpecMerge,
  readSpecManifest,
} from "./specs.js";
import { listNoteRecords } from "./notes.js";
import {
  AGENT_ENV,
  declaredActors,
  formatProvenance,
  provenanceFor,
} from "./provenance.js";
import { auditIdentity } from "./identity-audit.js";
import { CliError, requestJsonErrors } from "./errors.js";
import { assertWithinBound } from "./schemas.js";
import { VERSION } from "./version.js";
import {
  applyResolution,
  listResolutionRecords,
  pendingResolutionStatus,
  rejectResolution,
} from "./resolutions.js";
import {
  forecastReconciliation,
  forecastWorkspaces,
} from "./forecasts.js";
import { metadataStatus, validateMetadata } from "./metadata.js";
import { retainMetadata, formatRetention } from "./retention.js";
import { exportMetadata, importMetadata } from "./metadata-transfer.js";
import { benchmarkRepositoryScale } from "./scale-benchmark.js";

const HELP = `vcs-lab — Git-backed experiments for causal source control

Usage:
  vlab init
  vlab commit -m <message> [--all] [--allow-empty]
  vlab branch <name> [from]
  vlab merge <source> [--compact | --hard-squash] [-m <message>]
  vlab compact-merge <source> [-m <message>]
  vlab hard-squash <source> [-m <message>]
  vlab merge-plan <source> [--json]
  vlab proof-bundle <source>
  vlab verify-proof <file> [--offline] [--json]
  vlab rebase-plan <onto> [<source>] [--json]
  vlab rebase-forecast <onto> [<source>] [--accept-candidates] [--json]
  vlab rebase <onto> [--accept-candidates] [--use-forecast <id>] [--json]
  vlab rebase --status [--json]
  vlab rebase --continue [--fork] [--json]
  vlab rebase --abort [--json]
  vlab forecast <source> [--accept-candidates] [--json]
  vlab reconcile <source> [--accept-candidates] [--use-forecast <id>] [--json]
  vlab reconcile --status [--json]
  vlab reconcile --continue [--fork] [--json]
  vlab reconcile --abort [--json]
  vlab resolve status [--json]
  vlab resolve apply [path] [--all] [--resolution <id>] [--json]
  vlab resolve reject [path] [--all] [--resolution <id>] [--json]
  vlab resolve list [--json]
  vlab cherry-pick <commit-or-change-id> [--fork] [--repeat] [--json]
  vlab graph
  vlab commit ... [--authored-by <actor>] [--generated-by <actor>]
                 [--reviewed-by <actor>]     declare provenance (repeatable)
  vlab provenance [<rev>] [--all] [--json]
  vlab receipts [--json]
  vlab audit identity [--json]
  vlab metadata status [--json]
  vlab metadata validate [--strict] [--json]
  vlab metadata retain --dry-run|--apply [--json]
  vlab metadata export <directory> [--json]
  vlab metadata import <directory> --dry-run [--json]
  vlab metadata import <directory> --apply [--json]
  vlab metadata benchmark [--history <n>] [--workspaces <n>] [--notes <n>] [--resolutions <n>] [--areas <n>] [--files-per-area <n>] [--samples <n>] [--budget-ms <n>] [--json]
  vlab workspace create <name> [--from <ref>] [--path <directory>] [--owner <name>] [--focus <text>] [--cone <dir,dir>] [--json]
  vlab workspace list
  vlab workspace checkpoint [--label <text>] [--json]
  vlab workspace move <name> <directory> [--json]
  vlab workspace archive <name> [--json]
  vlab workspace restore <name> [--path <directory>] [--json]
  vlab workspace repair <name> --path <directory> [--json]
  vlab workspace prune [--dry-run|--apply] [--json]
  vlab workspace forecast <target> <source> [--source-checkpoint] [--accept-candidates] [--json]
  vlab spec index <markdown-file> [--force] [--json]
  vlab spec index --all [--force] [--json]
  vlab spec show <markdown-file>
  vlab spec merge-plan <markdown-file> <base> <ours> <theirs> [--json]
  vlab spec status [--json]
  vlab spec resolve [markdown-file] [--all] [--json]
  vlab spec benchmark [--documents <n>] [--blocks <n>]
  vlab doctor [--benchmark] [--samples <n>] [--warmup <n>] [--differential]
  vlab version

Plan legend: '=' proven covered/omit, '?' heuristic review, '+' new/replay.

Global diagnostics:
  --trace-git        print per-command process/session timings to stderr
  --git-session      force persistent Git object plumbing for this command
  --no-git-session  use ordinary one-process-per-command Git plumbing
  --forecast-engine <worktree|merge-tree>
                     simulate clean forecast steps in a temporary worktree
                     (the oracle; default on POSIX) or with one git merge-tree
                     process (default on Windows; needs Git 2.49, else falls back)
  --engine <git|native>
                     answer repository reads with Git processes (the default and
                     the oracle) or with the native core, which passes every
                     read through to Git until its binding exists; each fallback
                     is recorded in the Git metrics of the result
`;

function parseArgs(args) {
  const positionals = [];
  const options = {};
  // Declared provenance can name several actors on one commit (FR-ID-08), so
  // these accumulate instead of the last one winning.
  const repeatableFlags = new Set(["--authored-by", "--generated-by", "--reviewed-by"]);
  const valueFlags = new Set(["--message", "-m", "--from", "--path", "--owner", "--focus", "--cone", "--label", "--resolution", "--use-forecast", "--samples", "--warmup", "--documents", "--blocks", "--history", "--workspaces", "--notes", "--resolutions", "--budget-ms", "--areas", "--files-per-area"]);
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (valueFlags.has(item) || repeatableFlags.has(item)) {
      const value = args[index + 1];
      if (value === undefined) throw new CliError(`${item} requires a value.`,
        { code: "usage-missing-argument" });
      const key = item === "-m" ? "message" : item.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      // A repeatable flag always yields an array, even for one occurrence, so
      // a caller never has to test which shape it got.
      if (repeatableFlags.has(item)) {
        options[key] = [...(options[key] ?? []), value];
      } else {
        options[key] = value;
      }
      index += 1;
    } else if (item.startsWith("--")) {
      options[item.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
    } else {
      positionals.push(item);
    }
  }
  return { positionals, options };
}

function requireValue(value, usage) {
  if (!value) throw new CliError(`Missing required argument. Usage: ${usage}`,
    { code: "usage-missing-argument" });
  return value;
}

function print(value, json = false) {
  if (json || typeof value !== "string") {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(value);
  }
}

function formatIdentityAudit(result) {
  const lines = [
    "Identity audit",
    `repository   ${result.repository.root}`,
    `scanned      ${result.scanned.commits} commits, ${result.scanned.changeIds} change IDs, ${result.scanned.applicationRecords} application records`,
    `collisions   ${result.summary.collisions}`,
    `trailers     ${result.summary.conflictingTrailers} commits claiming more than one identity`,
    `origins      ${result.summary.ambiguousOrigins} commits with more than one claimed origin`,
    `findings     ${result.summary.errors} errors, ${result.summary.warnings} warnings`,
  ];
  for (const item of result.findings) {
    lines.push(`  ${item.severity === "error" ? "!" : "?"} ${item.code}: ${item.message}`);
  }
  lines.push(
    "",
    result.summary.clean
      ? "No identity collisions or ambiguous origins were found."
      : "Review the findings above; logical identity is not unambiguous in this repository.",
  );
  return lines.join("\n");
}

function formatProofVerification(result) {
  const lines = [
    "Proof bundle verification",
    `bundle       ${result.bundleSchema}`,
    `integrity    ${result.integrity.intact ? "intact" : "BROKEN"} (${result.integrity.algorithm ?? "unknown"})`,
    `changes      ${result.classification.reproduced}/${result.classification.changes} reproduced from the evidence the bundle states`,
    `counts       ${result.classification.counts.agrees ? "agree" : "DO NOT AGREE"} with the supplied changes`,
    `inventory    ${result.classification.uniqueCommits ? "unique commits" : "DUPLICATE commits"}`,
    `evidence     ${
      result.repository.checked
        ? result.repository.matches
          ? "matches this repository"
          : "DOES NOT MATCH this repository"
        : `not checked against a repository (${result.repository.reason})`
    }`,
  ];
  for (const [check, matches] of Object.entries(result.repository.checks ?? {})) {
    if (!matches) lines.push(`  ! repository ${check} does not match`);
  }
  for (const item of result.classification.disagreements) {
    lines.push(
      `  ! ${short(item.commit)} ${item.changeId}: claimed ` +
      `${item.claimed.status}/${item.claimed.proof ?? "none"}, recomputed ` +
      `${item.recomputed.status}/${item.recomputed.proof ?? "none"}`,
    );
  }
  lines.push(
    "",
    result.ok
      ? "The classification follows from the evidence the bundle states."
      : "The bundle does not verify.",
    result.trust.statement,
  );
  return lines.join("\n");
}

/**
 * Render trust state from the record instead of asserting it as fixed prose,
 * so the human line cannot contradict the JSON it summarizes (FR-GIT-06;
 * issue #11 item 5). The status and envelope records name the signature field
 * differently, so read either.
 */
function formatTrustState(trust) {
  if (!trust || typeof trust !== "object") return "trust not reported";
  const signed = trust.cryptographicallyTrusted ?? trust.cryptographicallySigned ?? false;
  return `${signed ? "signed" : "not signed"}; ${trust.authorized ? "authorized" : "not authorized"}`;
}

function formatMetadataStatus(result, title = "Metadata status") {
  const lines = [
    title,
    `repository   ${result.repository.root}`,
    `object format ${result.repository.objectFormat}`,
    `lineage      ${short(result.repository.lineage.id)}`,
    `notes        ${result.scopes.sharedPortable.notes.targetCount} targets; ${result.scopes.sharedPortable.notes.acceptedCount} accepted, ${result.scopes.sharedPortable.notes.quarantinedCount} quarantined`,
    `resolutions  ${result.scopes.sharedPortable.resolutions.acceptedRefCount}/${result.scopes.sharedPortable.resolutions.refCount} refs accepted`,
    `specs        ${result.scopes.trackedPortable.consistentCount}/${result.scopes.trackedPortable.manifestCount} manifests consistent`,
    `local        ${result.scopes.sharedLocal.checkpoints.totalRefCount ?? result.scopes.sharedLocal.checkpoints.refCount} checkpoint refs; ${result.scopes.sharedLocal.workspaceRegistry.count} workspaces`,
    `private      ${result.scopes.worktreePrivate.pendingOperationCount} operations; ${result.scopes.worktreePrivate.forecastCount} forecasts`,
    `diagnostics  ${result.summary.errors} errors, ${result.summary.warnings} warnings`,
    `integrity    ${result.summary.valid ? "valid" : "invalid"}; ${formatTrustState(result.trust)}`,
  ];
  for (const diagnostic of result.diagnostics) {
    lines.push(`  ${diagnostic.severity === "error" ? "!" : "?"} ${diagnostic.code}: ${diagnostic.subject}`);
  }
  return lines.join("\n");
}

function formatMetadataTransfer(result) {
  if (result.schema === "vcs-lab.metadata-export/v1") {
    return [
      "Metadata exported",
      `path         ${result.path}`,
      `records      ${result.records}`,
      `refs         ${result.refs}`,
      `quarantined  ${result.quarantinedRecords} excluded`,
      `payload      ${result.bytes} bytes`,
      `trust        integrity only; ${formatTrustState(result.trust)}`,
    ].join("\n");
  }
  return [
    result.applied ? "Metadata import applied" : "Metadata import preview",
    `path         ${result.path}`,
    `lineage      ${result.repository.lineageRelation}`,
    `records      ${result.summary.addRecords} add, ${result.summary.noopRecords} unchanged`,
    `refs         ${result.summary.createRefs} create, ${result.summary.mergeRefs} merge, ${result.summary.noopRefs} unchanged`,
    `conflicts    ${result.summary.conflicts}`,
    `applicable   ${result.summary.applicable ? "yes" : "no"}`,
    `trust        integrity only; ${formatTrustState(result.trust)}`,
  ].join("\n");
}

function formatScaleBenchmark(result) {
  const fixture = result.fixture;
  const lines = [
    "Repository scale benchmark",
    `fixture      ${fixture.historyDepth} history, ${fixture.workspaces} workspaces, ${fixture.causalNotes} causal notes, ${fixture.resolutions} resolutions`,
    `samples      ${result.samples}; interactive budget ${result.analysis.interactiveBudgetMs} ms`,
    `setup        ${result.setup.durationMs} ms; ${result.setup.git.processes} Git processes`,
    "",
  ];
  for (const [name, measurement] of Object.entries(result.measurements)) {
    lines.push(
      `${name.padEnd(18)} ${measurement.medianMs.toFixed(2)} ms median (${measurement.coldMs.toFixed(2)} cold); ${measurement.medianProcesses} Git processes`,
    );
  }
  lines.push(
    "",
    `next action  ${result.analysis.nextAction}`,
    `index now    ${result.analysis.persistentIndex.recommendedNow ? "yes" : "no"} — ${result.analysis.persistentIndex.reason}`,
    `service now  ${result.analysis.residentService.recommendedNow ? "yes" : "no"} — ${result.analysis.residentService.reason}`,
  );
  if (result.analysis.recommendations.length) {
    lines.push("", "Recommendations");
    for (const recommendation of result.analysis.recommendations) {
      lines.push(
        `- ${recommendation.area}: ${recommendation.action} (${recommendation.evidence})`,
      );
    }
  }
  return lines.join("\n");
}

function formatSpecResult(result) {
  const { manifest, changes, manifestPath } = result;
  return [
    `artifact     ${manifest.artifactId}`,
    `source       ${manifest.source}`,
    `manifest     ${path.relative(process.cwd(), manifestPath)}`,
    `blocks       ${manifest.blocks.length}`,
    `index        ${result.cacheHit ? `cache hit (${result.cacheMode}); manifest unchanged` : "manifest written"}`,
    ...(result.migratedFrom ? [`migration    ${result.migratedFrom} -> ${manifest.schema}`] : []),
    `changes      ${changes.added.length} added, ${changes.changed.length} changed, ${changes.moved.length} moved, ${changes.removed.length} removed`,
  ].join("\n");
}

function formatSpecBatch(result) {
  return [
    "Specification index",
    `files        ${result.files}`,
    `entities     ${result.blocks}`,
    `cache hits   ${result.cacheHits}`,
    `blob hits    ${result.blobCacheHits}; ${result.contentReads} content reads`,
    `written      ${result.manifestsWritten}`,
    `changes      ${result.changes.added} added, ${result.changes.changed} changed, ${result.changes.moved} moved, ${result.changes.removed} removed`,
    `duration     ${result.totalDurationMs.toFixed(2)} ms (${result.preparationMs.toFixed(2)} ms Git preparation)`,
  ].join("\n");
}

function formatSpecMergePlan(plan) {
  const lines = [
    "Semantic specification merge",
    `status       ${plan.status}`,
    `source       ${plan.file}`,
    `artifact     ${plan.artifactId ?? "incompatible"}`,
    `signature    ${short(plan.signature)}`,
    `ordering     ${plan.ordering.decision}`,
  ];
  const decisions = Object.entries(plan.counts)
    .map(([name, count]) => `${count} ${name}`)
    .join(", ");
  if (decisions) lines.push(`blocks       ${decisions}`);
  for (const conflict of plan.conflicts) {
    lines.push(
      `! ${conflict.type}${conflict.title ? `: ${conflict.title}` : ""}`,
    );
  }
  if (plan.status === "clean") {
    lines.push(
      `result       ${short(plan.result?.markdownHash)}`,
      "The plan is deterministic; no language model judgment was used.",
    );
  } else {
    lines.push("Ambiguous blocks remain for explicit review.");
  }
  return lines.join("\n");
}

function formatSpecMergeStatus(status) {
  if (!status.active) return "No semantic specification merge is pending.";
  const lines = [`operation    ${status.operationId}`];
  for (const plan of status.plans) {
    lines.push(
      "",
      `path         ${plan.path}`,
      `status       ${plan.status}`,
      `signature    ${short(plan.signature)}`,
      `ordering     ${plan.ordering}`,
    );
    for (const conflict of plan.conflicts) {
      lines.push(`  ! ${conflict.type}${conflict.title ? `: ${conflict.title}` : ""}`);
    }
  }
  if (status.plans.some((plan) => plan.status === "clean")) {
    lines.push("", "Apply deterministic suggestions with: vlab spec resolve --all");
  }
  return lines.join("\n");
}

function formatSpecMergeAction(result) {
  return [
    `Applied ${result.applied.length} deterministic spec merge${result.applied.length === 1 ? "" : "s"}.`,
    ...result.applied.map((item) => `  ${item.path}`),
    "Inspect the staged Markdown and sidecars, then run: vlab reconcile --continue",
  ].join("\n");
}

function short(value) {
  return value ? String(value).slice(0, 12) : "-";
}

function recordTitle(record) {
  return `${String(record.type ?? "record").toUpperCase()} ${record.id ?? "(no id)"}`;
}

function formatReceipt(record) {
  const lines = [recordTitle(record)];
  if (record.type === "landing") {
    lines.push(
      `  landing     ${short(record.landingCommit ?? record.attachedTo)}`,
      `  source      ${record.sourceRef ?? "-"} @ ${short(record.sourceHead)}`,
      `  mode        ${record.mode ?? "-"}`,
      `  absorbed    ${(record.absorbedChanges ?? []).length} changes in ${(record.absorbedCommits ?? []).length} commits`,
    );
  } else if (record.type === "application") {
    lines.push(
      `  applied     ${short(record.appliedCommit ?? record.attachedTo)} <= ${short(record.originCommit)}`,
      `  change      ${record.appliedChangeId ?? record.originChangeId ?? "-"}`,
      `  relation    ${record.relation ?? "-"}`,
    );
    if ((record.conflictedPaths ?? []).length) {
      lines.push(`  conflicts   ${record.conflictedPaths.join(", ")}`);
    }
    if ((record.resolutions ?? []).length) {
      const decisions = record.resolutions.map((item) => item.decision);
      lines.push(`  resolutions ${decisions.join(", ")}`);
    }
    if ((record.semanticMerges ?? []).length) {
      lines.push(
        `  spec merges ${record.semanticMerges.map((item) => `${item.decision ?? "recorded"}:${item.path}`).join(", ")}`,
      );
    }
  } else if (record.type === "rebase-application") {
    lines.push(
      `  replayed    ${short(record.appliedCommit ?? record.attachedTo)} <= ${short(record.originCommit)}`,
      `  change      ${record.appliedChangeId ?? record.originChangeId ?? "-"}`,
      `  relation    ${record.relation ?? "-"}`,
      `  trees       ${short(record.targetBeforeTree)} -> ${short(record.resultTree)}`,
    );
    if ((record.conflictedPaths ?? []).length) {
      lines.push(`  conflicts   ${record.conflictedPaths.join(", ")}`);
    }
  } else if (record.type === "resolution") {
    lines.push(
      `  signature   ${short(record.signature)}`,
      `  result      ${short(record.resultBlob)}`,
      `  path        ${record.originalPath ?? "-"}`,
      `  decision    ${record.decision ?? "-"}`,
    );
  } else if (record.type === "reconciliation") {
    lines.push(
      `  result      ${short(record.resultCommit ?? record.attachedTo)}`,
      `  source      ${record.sourceRef ?? "-"} @ ${short(record.sourceHead)}`,
      `  covered     ${(record.absorbedChanges ?? []).length} changes; ${(record.applied ?? []).length} applied now`,
    );
    if (record.forecastId) lines.push(`  forecast    ${record.forecastId}`);
    if (record.timings?.activeApplicationMs !== undefined) {
      lines.push(
        `  active time ${record.timings.activeApplicationMs.toFixed(2)} ms`,
      );
    }
    if (record.timings?.git?.count !== undefined) {
      const activity = formatGitActivity(record.timings.git);
      lines.push(`  ${activity}`);
    }
    if (record.exactStateEqualityAfter !== undefined) {
      lines.push(
        `  same before ${record.exactStateEqualityBefore ? "yes" : "no"}`,
        `  same after  ${record.exactStateEqualityAfter ? "yes" : "no"}`,
      );
    } else if (record.exactStateEquality !== undefined) {
      lines.push(
        `  same before ${record.exactStateEquality ? "yes" : "no"}`,
        "  same after  not recorded by v1 receipt",
      );
    } else {
      lines.push("  same state  not recorded");
    }
  } else if (record.type === "rebase") {
    lines.push(
      `  result      ${short(record.resultCommit ?? record.attachedTo)}`,
      `  source      ${record.sourceRef ?? "-"} @ ${short(record.sourceHead)}`,
      `  onto        ${record.ontoRef ?? "-"} @ ${short(record.ontoHead)}`,
      `  coverage    ${(record.absorbedChanges ?? []).length} changes; ${(record.applications ?? []).length} replayed`,
      `  same state  ${record.exactStateEqualityAfter ? "yes" : "no"}`,
    );
    if (record.forecastId) lines.push(`  forecast    ${record.forecastId}`);
    if (record.timings?.activeApplicationMs !== undefined) {
      lines.push(`  active time ${record.timings.activeApplicationMs.toFixed(2)} ms`);
    }
  } else {
    lines.push(`  attached    ${short(record.attachedTo)}`);
  }
  if (record.createdAt) lines.push(`  created     ${record.createdAt}`);
  return lines.join("\n");
}

function formatReceipts(records) {
  if (records.length === 0) return "No causal records found.";
  return `${records.length} causal record${records.length === 1 ? "" : "s"}\n\n${records
    .map(formatReceipt)
    .join("\n\n")}`;
}

function formatGitActivity(git, label = "git work") {
  if (!git) return null;
  const processes = git.processes ?? git.count;
  return `${label.padEnd(12)} ${processes} processes; ${git.count} queries (${git.totalMs.toFixed(2)} ms)`;
}

function formatCausalEdges(records) {
  const lines = [];
  const consumedReconciliations = new Set();
  const reconciliationsByApplication = new Map();
  for (const record of records) {
    if (record.type !== "reconciliation" || record.applied?.length !== 1) continue;
    const application = record.applied[0];
    if (
      application.sourceCommit === record.sourceHead &&
      application.appliedCommit === record.resultCommit
    ) {
      reconciliationsByApplication.set(
        `${record.resultCommit}:${record.sourceHead}`,
        record,
      );
    }
  }
  for (const record of records) {
    if (record.type === "landing") {
      lines.push(
        `${short(record.landingCommit ?? record.attachedTo)} <= ${short(record.sourceHead)}  ${record.mode}; ${(record.absorbedChanges ?? []).length} changes absorbed`,
      );
    } else if (record.type === "application") {
      const relation = record.relation ?? "application";
      const reconciliation = reconciliationsByApplication.get(
        `${record.appliedCommit ?? record.attachedTo}:${record.originCommit}`,
      );
      const suffix = reconciliation
        ? `; reconciliation ${reconciliation.absorbedChanges?.length ?? 0} covered`
        : "";
      if (reconciliation) consumedReconciliations.add(reconciliation.id);
      lines.push(
        `${short(record.appliedCommit ?? record.attachedTo)} <= ${short(record.originCommit)}  ${relation} ${record.appliedChangeId ?? record.originChangeId ?? "unknown"}${suffix}`,
      );
    } else if (record.type === "rebase-application") {
      lines.push(
        `${short(record.appliedCommit ?? record.attachedTo)} <= ${short(record.originCommit)}  ${record.relation ?? "causal-rebase"} ${record.appliedChangeId ?? record.originChangeId ?? "unknown"}`,
      );
    } else if (record.type === "reconciliation") {
      if (consumedReconciliations.has(record.id)) continue;
      lines.push(
        `${short(record.resultCommit ?? record.attachedTo)} <= ${short(record.sourceHead)}  reconcile; ${(record.absorbedChanges ?? []).length} covered, ${(record.applied ?? []).length} applied`,
      );
    } else if (record.type === "rebase") {
      lines.push(
        `${short(record.resultCommit ?? record.attachedTo)} <= ${short(record.sourceHead)}  rebase onto ${short(record.ontoHead)}; ${(record.absorbedChanges ?? []).length} covered, ${(record.applications ?? []).length} replayed`,
      );
    }
  }
  if (lines.length === 0) return "  (none)";
  return lines.map((line) => `  ${line}`).join("\n");
}

function formatReconciliationResult(result) {
  const { receipt } = result;
  const contextual = receipt.applied.filter((item) =>
    item.relation?.startsWith("contextual-"),
  );
  const decisions = receipt.applied
    .flatMap((item) => item.resolutions ?? [])
    .reduce((counts, item) => {
      counts[item.decision] = (counts[item.decision] ?? 0) + 1;
      return counts;
    }, {});
  const decisionText = Object.entries(decisions)
    .map(([name, count]) => `${count} ${name}`)
    .join(", ");
  const semanticMerges = receipt.applied.reduce(
    (count, item) => count + (item.semanticMerges?.length ?? 0),
    0,
  );
  return [
    "Reconciliation complete.",
    `operation    ${result.operationId}`,
    `result       ${short(receipt.resultCommit)}`,
    `source       ${receipt.sourceRef} @ ${short(receipt.sourceHead)}`,
    `coverage     ${receipt.absorbedChanges.length} covered; ${receipt.applied.length} applied`,
    `contextual   ${contextual.length}`,
    `same state   ${receipt.exactStateEqualityAfter ? "yes" : "no"}`,
    receipt.forecastId ? `forecast     ${receipt.forecastId}` : null,
    receipt.timings
      ? `active time  ${receipt.timings.activeApplicationMs.toFixed(2)} ms`
      : null,
    receipt.timings?.git
      ? formatGitActivity(receipt.timings.git)
      : null,
    semanticMerges ? `spec merges  ${semanticMerges} deterministic` : null,
    decisionText ? `resolutions  ${decisionText}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatRebaseResult(result) {
  const receipt = result.receipt;
  const forked = receipt.applications.filter(
    (application) => application.relation === "contextual-fork",
  ).length;
  const contextual = receipt.applications.filter(
    (application) => application.relation === "contextual-rebase",
  ).length;
  return [
    "Causal rebase complete.",
    `operation    ${result.operationId}`,
    `branch       ${receipt.sourceRef}`,
    `source       ${short(receipt.sourceHead)}`,
    `onto         ${receipt.ontoRef} @ ${short(receipt.ontoHead)}`,
    `result       ${short(receipt.resultCommit)}`,
    `coverage     ${receipt.omitted.length} exact omit; ${receipt.acceptedCandidates.length} accepted candidate; ${receipt.applications.length} replayed`,
    `contextual   ${contextual}`,
    `forked       ${forked}`,
    `same state   ${receipt.exactStateEqualityAfter ? "yes" : "no"}`,
    receipt.forecastId ? `forecast     ${receipt.forecastId}` : null,
    receipt.timings
      ? `active time  ${receipt.timings.activeApplicationMs.toFixed(2)} ms`
      : null,
    receipt.timings?.git
      ? formatGitActivity(receipt.timings.git)
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatForecast(forecast) {
  const counts = forecast.counts;
  const scope = forecast.scope === "source-checkpoint"
    ? "immutable source checkpoint"
    : "committed heads only";
  const lines = [
    "Reconciliation forecast",
    `forecast     ${forecast.id}`,
    `status       ${forecast.status}`,
    `target       ${short(forecast.targetHead)}`,
    `source       ${forecast.sourceRef} @ ${short(forecast.sourceHead)}`,
    `scope        ${scope}`,
    `plan         ${forecast.plan.counts.covered} covered, ${forecast.plan.counts["candidate-equivalent"]} candidate, ${forecast.plan.counts.new} new`,
    `simulation   ${counts.clean} clean, ${counts.exactResolution} exact-resolved, ${counts.semanticSpec ?? 0} spec-merged, ${counts.blocked} blocked`,
    `predicted    ${short(forecast.predictedResultTree)}`,
    `partial      ${short(forecast.partialResultTree)}`,
    `same state   ${forecast.exactStateEqualityAfter === null ? "unknown" : forecast.exactStateEqualityAfter ? "yes" : "no"}`,
    `forecast time ${forecast.timings.forecastMs.toFixed(2)} ms`,
    forecast.timings.git
      ? formatGitActivity(forecast.timings.git)
      : null,
    ...formatForecastEngine(forecast),
  ].filter(Boolean);
  if (forecast.ignoredTargetDirtyFiles) {
    lines.push(`target dirty ${forecast.ignoredTargetDirtyFiles} files ignored`);
  }
  if (forecast.workspaceComparison) {
    const comparison = forecast.workspaceComparison;
    lines.push(
      `workspaces   ${comparison.target.name} <= ${comparison.source.name}`,
    );
    const dirty = [comparison.target, comparison.source].filter(
      (workspace) => workspace.ignoredDirtyFiles,
    );
    if (dirty.length) {
      lines.push(
        `dirty ignored ${dirty.map((workspace) => `${workspace.name}:${workspace.ignoredDirtyFiles}`).join(", ")}`,
      );
    }
    const checkpoint = comparison.source.checkpoint;
    if (checkpoint) {
      lines.push(
        `checkpoint   ${short(checkpoint.id)} tree ${short(checkpoint.tree)}`,
        `draft change ${checkpoint.draftChangeId}`,
      );
    }
  }
  lines.push("");
  if (forecast.steps.length === 0) {
    lines.push("No new source changes require simulation.");
  }
  for (const step of forecast.steps) {
    if (step.outcome === "clean") {
      lines.push(`C ${short(step.sourceCommit)} ${step.subject} [clean]`);
    } else if (!step.outcome.startsWith("blocked")) {
      const labels = [];
      if (step.semanticMerges?.length) {
        labels.push(`${step.semanticMerges.length} deterministic spec merge${step.semanticMerges.length === 1 ? "" : "s"}`);
      }
      if (step.resolutions?.length) {
        labels.push(`${step.resolutions.length} exact resolution${step.resolutions.length === 1 ? "" : "s"}`);
      }
      lines.push(
        `R ${short(step.sourceCommit)} ${step.subject} [${labels.join(", ")}]`,
      );
      for (const merge of step.semanticMerges ?? []) {
        lines.push(`  ${merge.path} <= stable block IDs`);
      }
      for (const resolution of step.resolutions ?? []) {
        lines.push(
          `  ${resolution.path} <= ${resolution.selectedResolutionId}`,
        );
      }
    } else {
      lines.push(`! ${short(step.sourceCommit)} ${step.subject} [blocked]`);
      for (const conflict of step.conflicts ?? []) {
        lines.push(
          `  ${conflict.path}: ${conflict.candidates.length} exact candidate${conflict.candidates.length === 1 ? "" : "s"}`,
        );
        for (const semantic of conflict.semanticSpec?.conflicts ?? []) {
          lines.push(`    semantic blocker: ${semantic.type}`);
        }
      }
    }
  }
  if (forecast.blockedReason) lines.push("", `blocked by   ${forecast.blockedReason}`);
  lines.push(
    "",
    "The current HEAD, index, and working files were not changed.",
  );
  if (forecast.candidateDecisionRequired) {
    const reviewCommand = forecast.workspaceComparison
      ? [
          "vlab workspace forecast",
          forecast.workspaceComparison.target.name,
          forecast.workspaceComparison.source.name,
          forecast.scope === "source-checkpoint" ? "--source-checkpoint" : null,
          "--accept-candidates",
        ].filter(Boolean).join(" ")
      : `vlab forecast ${forecast.sourceRef} --accept-candidates`;
    lines.push(
      "Review the heuristic candidates, then regenerate with:",
      `  ${reviewCommand}`,
    );
    return lines.join("\n");
  }
  if (forecast.workspaceComparison) {
    lines.push(
      `Run from target worktree: ${forecast.workspaceComparison.target.path}`,
    );
  }
  lines.push(
    "Start the pinned reconciliation with:",
    `  vlab reconcile ${forecast.sourceRef} --use-forecast ${forecast.id}`,
  );
  return lines.join("\n");
}

function formatResolutionStatus(status) {
  if (!status.active) return "No reusable conflict resolution is pending.";
  const lines = [`operation    ${status.operationId}`];
  for (const conflict of status.conflicts) {
    lines.push(
      "",
      `path         ${conflict.path}`,
      `signature    ${short(conflict.signature)}`,
      `candidates   ${conflict.candidates.length}`,
    );
    for (const candidate of conflict.candidates) {
      lines.push(
        `  ${candidate.id} result ${short(candidate.resultBlob)} from ${candidate.originalPath ?? "unknown path"}`,
      );
    }
  }
  if (status.conflicts.some((conflict) => conflict.candidates.length)) {
    lines.push("", "Apply a suggestion with: vlab resolve apply --all");
  }
  return lines.join("\n");
}

function formatResolutionAction(result, action) {
  const items = result[action] ?? [];
  return [
    `${action === "applied" ? "Applied" : "Rejected"} ${items.length} resolution suggestion${items.length === 1 ? "" : "s"}.`,
    ...items.map((item) => `  ${item.path}`),
    action === "applied"
      ? "Continue with: vlab reconcile --continue"
      : "Resolve the files manually, stage them, then continue reconciliation.",
  ].join("\n");
}

function formatResolutionCatalog(records) {
  if (!records.length) return "No reusable resolutions have been recorded.";
  return [
    `${records.length} reusable resolution${records.length === 1 ? "" : "s"}`,
    "",
    ...records.flatMap((record) => [
      `${record.id}  ${short(record.signature)} -> ${short(record.resultBlob)}`,
      `  original path ${record.originalPath ?? "-"}; ${record.createdAt ?? "unknown time"}`,
    ]),
  ].join("\n");
}

function positiveInteger(value, fallback, name, minimum = 1) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > 100) {
    throw new CliError(`${name} must be an integer between ${minimum} and 100.`,
      { code: "usage-invalid-option-value" });
  }
  return parsed;
}

function percentile(sorted, fraction) {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function gitBenchmark(options = {}) {
  const sampleCount = positiveInteger(options.samples, 3, "--samples");
  const warmupCount = positiveInteger(options.warmup, 1, "--warmup", 0);
  const probes = [
    { name: "head", args: ["rev-parse", "HEAD"] },
    { name: "status", args: ["status", "--porcelain=v1"] },
    { name: "history", args: ["log", "-20", "--format=%H"] },
    { name: "notes", args: ["notes", "--ref=vcs-lab", "list"], allowFailure: true },
  ];
  // These probes measure the raw cost of one Git process on this host, so
  // they deliberately bypass the engine seam (`rawProbe`).
  return probes.map((probe) => {
    for (let index = 0; index < warmupCount; index += 1) {
      runGit(probe.args, { allowFailure: probe.allowFailure, rawProbe: true });
    }
    const samples = [];
    for (let index = 0; index < sampleCount; index += 1) {
      samples.push(
        runGit(probe.args, { allowFailure: probe.allowFailure, rawProbe: true })
          .durationMs,
      );
    }
    const sorted = [...samples].sort((left, right) => left - right);
    return {
      name: probe.name,
      warmup: warmupCount,
      samplesMs: samples.map((sample) => Number(sample.toFixed(2))),
      averageMs: Number(
        (samples.reduce((sum, sample) => sum + sample, 0) / samples.length).toFixed(2),
      ),
      medianMs: Number(percentile(sorted, 0.5).toFixed(2)),
      p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
      minMs: Number(Math.min(...samples).toFixed(2)),
      maxMs: Number(Math.max(...samples).toFixed(2)),
    };
  });
}

/**
 * Windows can start a process inside an 8.3 alias of its directory
 * (`C:\Users\RUNNER~1\...`), and `process.cwd()` then keeps the alias while
 * Git reports the long form from `rev-parse --show-toplevel`. Every check
 * that relates a caller-supplied path to the repository root — spec
 * containment, workspace path equality — would compare the two spellings and
 * refuse a path that is inside the repository. Canonicalizing once at entry
 * gives the rest of the CLI the same view of the directory Git has. On POSIX
 * `process.cwd()` is already the physical path, so this changes nothing.
 */
function canonicalizeWorkingDirectory() {
  try {
    const current = process.cwd();
    const canonical = fs.realpathSync.native(current);
    if (canonical !== current) process.chdir(canonical);
  } catch {
    // A directory that cannot be resolved is reported by the first Git call.
  }
}

function gitObjectSessionBenchmark(options = {}, cwd = process.cwd()) {
  const sampleCount = positiveInteger(options.samples, 3, "--samples");
  const collector = beginGitMetrics("doctor-object-session");
  const started = performance.now();
  withGitObjectSession(cwd, () => {
    for (let index = 0; index < sampleCount; index += 1) {
      const head = currentHead(cwd);
      treeId(head, cwd);
      commitSubject(head, cwd);
    }
  });
  return {
    enabled: gitObjectSessionEnabled(),
    rounds: sampleCount,
    logicalReads: sampleCount * 3,
    durationMs: Number((performance.now() - started).toFixed(2)),
    git: endGitMetrics(collector),
  };
}

function formatReconciliationStatus(status) {
  if (!status.active) return "No reconciliation is in progress in this worktree.";
  const lines = [
    `operation    ${status.operationId}`,
    `state        ${status.state}`,
    `source       ${status.sourceRef} @ ${short(status.sourceHead)}`,
    `target start ${short(status.targetBefore)}`,
    `progress     ${status.progress.completed}/${status.progress.total} applied`,
  ];
  if (status.current) {
    lines.push(
      `current      ${short(status.current.sourceCommit)} ${status.current.sourceChangeId}`,
    );
    const paths = status.current.unresolvedPaths?.length
      ? status.current.unresolvedPaths
      : status.current.conflictedPaths;
    if (paths?.length) lines.push(`conflicts    ${paths.join(", ")}`);
  }
  lines.push(
    "",
    status.state === "conflicted"
      ? "Resolve and stage the conflicts, then run: vlab reconcile --continue"
      : status.state === "forecast-mismatch"
        ? "The applied tree diverged from its forecast and cannot be published."
        : "The operation is resumable in this worktree.",
    "Abort and restore the starting commit with: vlab reconcile --abort",
  );
  return lines.join("\n");
}

function formatRebaseStatus(status) {
  if (!status.active) return "No causal rebase is in progress in this worktree.";
  const lines = [
    `operation    ${status.operationId}`,
    `state        ${status.state}`,
    `branch       ${status.sourceRef}`,
    `source start ${short(status.sourceHead)}`,
    `onto         ${status.ontoRef} @ ${short(status.ontoHead)}`,
    `progress     ${status.progress.completed}/${status.progress.total} replayed`,
  ];
  if (status.current) {
    lines.push(
      `current      ${short(status.current.sourceCommit)} ${status.current.sourceChangeId}`,
    );
    const paths = status.current.unresolvedPaths?.length
      ? status.current.unresolvedPaths
      : status.current.conflictedPaths;
    if (paths?.length) lines.push(`conflicts    ${paths.join(", ")}`);
  }
  if (!status.recovery.branchMatches) {
    lines.push(
      "",
      `branch mismatch: switch back to ${status.sourceRef} before recovery.`,
    );
  }
  lines.push(
    "",
    status.state === "conflicted"
      ? "Resolve and stage the conflicts, then run: vlab rebase --continue"
      : ["forecast-mismatch", "identity-mismatch", "blocked"].includes(status.state)
        ? "The operation is blocked and cannot publish receipts."
        : "The operation is resumable in this worktree.",
    "Abort and restore the original branch tip with: vlab rebase --abort",
  );
  return lines.join("\n");
}

export async function main(rawArgs) {
  canonicalizeWorkingDirectory();
  const forceSession = rawArgs.includes("--git-session");
  const disableSession = rawArgs.includes("--no-git-session");
  if (forceSession && disableSession) {
    throw new CliError("Choose only one of --git-session or --no-git-session.",
      { code: "usage-conflicting-options" });
  }
  if (rawArgs.includes("--trace-git")) process.env.VLAB_TRACE = "1";
  if (forceSession) process.env.VLAB_GIT_SESSION = "1";
  if (disableSession) process.env.VLAB_GIT_SESSION = "0";
  const args = [];
  for (let index = 0; index < rawArgs.length; index += 1) {
    const item = rawArgs[index];
    if (["--trace-git", "--git-session", "--no-git-session"].includes(item)) continue;
    if (item === "--forecast-engine" || item.startsWith("--forecast-engine=")) {
      const inline = item.includes("=");
      const value = inline
        ? item.slice("--forecast-engine=".length)
        : rawArgs[index + 1];
      if (!inline) index += 1;
      if (!FORECAST_ENGINES.includes(value)) {
        throw new CliError(
          `--forecast-engine requires one of: ${FORECAST_ENGINES.join(", ")}.`,
            { code: "usage-invalid-option-value" },
        );
      }
      process.env.VLAB_FORECAST_ENGINE = value;
      continue;
    }
    if (item === "--engine" || item.startsWith("--engine=")) {
      const inline = item.includes("=");
      const value = inline ? item.slice("--engine=".length) : rawArgs[index + 1];
      if (!inline) index += 1;
      if (!READ_ENGINES.includes(value)) {
        throw new CliError(
          `--engine requires one of: ${READ_ENGINES.join(", ")}.`,
            { code: "usage-invalid-option-value" },
        );
      }
      process.env.VLAB_ENGINE = value;
      continue;
    }
    args.push(item);
  }
  // Validate the environment selections on every command, as the flags are.
  forecastEngine();
  readEngine();
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (command === "version" || command === "--version" || command === "-V") {
    console.log(`vcs-lab ${VERSION}`);
    return;
  }

  const { positionals, options } = parseArgs(rest);
  // From here on the invocation's output mode is known, so a failure can be
  // reported as a machine-readable envelope (ADR-0021). Everything above this
  // line — an unknown global flag, a conflicting session flag — fails before
  // any `--json` is in scope and keeps prose on stderr.
  requestJsonErrors(options.json);
  switch (command) {
    case "init": {
      const context = initLab();
      print(`Initialized vcs-lab metadata in ${context.root}`);
      return;
    }
    case "commit": {
      const message = requireValue(options.message, "vlab commit -m <message>");
      const result = createCommit(message, {
        all: options.all,
        allowEmpty: options.allowEmpty,
        actors: declaredActors(options),
      });
      print(result, options.json);
      return;
    }
    case "branch": {
      const name = requireValue(positionals[0], "vlab branch <name> [from]");
      const from = positionals[1] ?? "HEAD";
      runGit(["switch", "-c", name, from]);
      print(`Created and switched to ${name} from ${from}`);
      return;
    }
    case "merge":
    case "compact-merge":
    case "hard-squash": {
      const source = requireValue(positionals[0], `vlab ${command} <source>`);
      let mode = command === "hard-squash" || options.hardSquash ? "hard-squash" : "compact";
      if (options.compact) mode = "compact";
      const receipt = land(source, mode, { message: options.message });
      print(receipt, options.json);
      return;
    }
    case "proof-bundle": {
      const source = requireValue(positionals[0], "vlab proof-bundle <source>");
      // Always JSON: the bundle exists to be handed to another tool, and a
      // human rendering of it would be the very prose a verifier must not
      // trust (FR-PLAN-08).
      print(buildProofBundle(source), true);
      return;
    }
    case "verify-proof": {
      const file = requireValue(positionals[0], "vlab verify-proof <file>");
      const bundlePath = path.resolve(file);
      let raw;
      try {
        // The bundle is another party's document, so its size is checked
        // against the published bound before any of it is read (ADR-0020).
        assertWithinBound("proofBundleBytes", fs.statSync(bundlePath).size, `Proof bundle '${file}'`);
        raw = fs.readFileSync(bundlePath, "utf8");
      } catch (error) {
        if (error instanceof CliError) throw error;
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
          throw new CliError(`Proof bundle not found: ${file}`, { code: "not-found" });
        }
        throw new CliError(`Proof bundle '${file}' could not be read.`,
          { code: "malformed-input", details: error?.message ?? "" });
      }
      let bundle;
      try {
        bundle = JSON.parse(raw);
      } catch {
        throw new CliError(`Proof bundle '${file}' is not valid JSON.`,
          { code: "malformed-input" });
      }
      // Refuse malformed documents before attempting repository reads.
      assertProofBundleDocument(bundle);
      // Check the evidence against this repository unless asked not to. A
      // verifier holding only the file can still run with --offline; the
      // difference is reported rather than hidden, because only the
      // repository-backed check can catch fabricated evidence.
      let repository = null;
      if (!options.offline) {
        try {
          repoContext();
        } catch {
          repository = { checked: false, reason: "not-a-repository", matches: null };
        }
        // Once a repository is found, a failed read must fail verification;
        // it cannot silently downgrade the command to an offline success.
        if (!repository) repository = verifyAgainstRepository(bundle);
      }
      const result = verifyProofBundle(bundle, repository);
      print(options.json ? result : formatProofVerification(result), options.json);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "merge-plan": {
      const source = requireValue(positionals[0], "vlab merge-plan <source>");
      const plan = buildMergePlan(source);
      print(options.json ? plan : formatMergePlan(plan), options.json);
      return;
    }
    case "rebase-plan": {
      const onto = requireValue(
        positionals[0],
        "vlab rebase-plan <onto> [<source>]",
      );
      if (positionals.length > 2) {
        throw new CliError("Usage: vlab rebase-plan <onto> [<source>]",
          { code: "usage-missing-argument" });
      }
      const plan = buildRebasePlan(onto, positionals[1]);
      print(options.json ? plan : formatRebasePlan(plan), options.json);
      return;
    }
    case "rebase-forecast": {
      const onto = requireValue(
        positionals[0],
        "vlab rebase-forecast <onto> [<source>]",
      );
      if (positionals.length > 2) {
        throw new CliError(
          "Usage: vlab rebase-forecast <onto> [<source>]",
            { code: "usage-missing-argument" },
        );
      }
      const forecast = forecastRebase(onto, positionals[1], {
        acceptCandidates: options.acceptCandidates,
      });
      print(
        options.json ? forecast : formatRebaseForecast(forecast),
        options.json,
      );
      return;
    }
    case "rebase": {
      const actions = [options.status, options.continue, options.abort].filter(Boolean);
      if (actions.length > 1) {
        throw new CliError("Choose only one of --status, --continue, or --abort.",
          { code: "usage-conflicting-options" });
      }
      if (options.status) {
        const status = rebaseStatus();
        print(options.json ? status : formatRebaseStatus(status), options.json);
        return;
      }
      if (options.continue) {
        const result = continueRebase({ fork: options.fork });
        print(options.json ? result : formatRebaseResult(result), options.json);
        return;
      }
      if (options.abort) {
        const result = abortRebase();
        print(result, options.json);
        return;
      }
      const onto = requireValue(positionals[0], "vlab rebase <onto>");
      if (positionals.length > 1) {
        throw new CliError("Usage: vlab rebase <onto>",
          { code: "usage-missing-argument" });
      }
      const result = startRebase(onto, {
        acceptCandidates: options.acceptCandidates,
        forecastId: options.useForecast,
      });
      print(options.json ? result : formatRebaseResult(result), options.json);
      return;
    }
    case "forecast": {
      const source = requireValue(positionals[0], "vlab forecast <source>");
      const forecast = forecastReconciliation(source, {
        acceptCandidates: options.acceptCandidates,
      });
      print(options.json ? forecast : formatForecast(forecast), options.json);
      return;
    }
    case "reconcile": {
      const actions = [options.status, options.continue, options.abort].filter(Boolean);
      if (actions.length > 1) {
        throw new CliError("Choose only one of --status, --continue, or --abort.",
          { code: "usage-conflicting-options" });
      }
      if (options.status) {
        const status = reconciliationStatus();
        print(options.json ? status : formatReconciliationStatus(status), options.json);
        return;
      }
      if (options.continue) {
        const result = continueReconciliation({ fork: options.fork });
        print(options.json ? result : formatReconciliationResult(result), options.json);
        return;
      }
      if (options.abort) {
        const result = abortReconciliation();
        print(result, options.json);
        return;
      }
      const source = requireValue(positionals[0], "vlab reconcile <source>");
      const result = reconcile(source, {
        acceptCandidates: options.acceptCandidates,
        forecastId: options.useForecast,
      });
      print(options.json ? result : formatReconciliationResult(result), options.json);
      return;
    }
    case "resolve": {
      const subcommand = positionals[0] ?? "status";
      if (subcommand === "status") {
        const result = pendingResolutionStatus();
        print(options.json ? result : formatResolutionStatus(result), options.json);
        return;
      }
      if (subcommand === "apply") {
        const result = applyResolution({
          path: positionals[1],
          all: options.all,
          resolutionId: options.resolution,
        });
        print(options.json ? result : formatResolutionAction(result, "applied"), options.json);
        return;
      }
      if (subcommand === "reject") {
        const result = rejectResolution({
          path: positionals[1],
          all: options.all,
          resolutionId: options.resolution,
        });
        print(options.json ? result : formatResolutionAction(result, "rejected"), options.json);
        return;
      }
      if (subcommand === "list") {
        const records = listResolutionRecords();
        print(options.json ? records : formatResolutionCatalog(records), options.json);
        return;
      }
      throw new CliError("Unknown resolve command. Use status, apply, reject, or list.",
        { code: "usage-unknown-command" });
    }
    case "cherry-pick": {
      const value = requireValue(positionals[0], "vlab cherry-pick <commit-or-change-id>");
      const result = cherryPick(value, { fork: options.fork, repeat: options.repeat });
      print(result, options.json);
      return;
    }
    case "graph": {
      const graph = historyGraph();
      const records = listNoteRecords();
      print(`Project history\n${graph}\n\nCausal edges\n${formatCausalEdges(records)}`);
      return;
    }
    case "audit": {
      const subcommand = positionals[0];
      if (subcommand !== "identity") {
        throw new CliError("Unknown audit command. Use identity.",
          { code: "usage-unknown-command" });
      }
      const result = auditIdentity();
      print(options.json ? result : formatIdentityAudit(result), options.json);
      if (result.summary.errors > 0) process.exitCode = 1;
      return;
    }
    case "provenance": {
      // Reads the declared record; it never derives one. A commit with no
      // record reports nothing rather than falling back to the Git author,
      // because "who committed this" is a different claim from "who produced
      // this" and conflating them is the inference FR-TRUST-04 forbids.
      const revision = positionals[0] ?? "HEAD";
      const commits = options.all
        ? reachableCommits(revision)
        : [resolveRevision(revision)];
      const found = provenanceFor(commits);
      const entries = [];
      for (const commit of commits) {
        for (const record of found.get(commit) ?? []) {
          entries.push({
            commit,
            subject: commitSubject(commit),
            id: record.id,
            changeId: record.changeId ?? null,
            actors: record.actors ?? [],
            origin: record.origin,
            carriedFrom: record.carriedFrom ?? [],
            createdAt: record.createdAt ?? null,
          });
        }
      }
      print(
        options.json
          ? { revision, inspected: commits.length, entries }
          : formatProvenance(entries),
        options.json,
      );
      return;
    }
    case "receipts": {
      const records = listNoteRecords();
      print(options.json ? records : formatReceipts(records), options.json);
      return;
    }
    case "metadata": {
      const subcommand = positionals[0];
      if (subcommand === "retain") {
        const result = retainMetadata({ dryRun: options.dryRun, apply: options.apply });
        print(options.json ? result : formatRetention(result), options.json);
        if (result.quarantinedRecords || result.diagnostics.some(entry => entry.severity === "error")) process.exitCode = 1;
        return;
      }
      if (subcommand === "status") {
        const result = metadataStatus();
        print(options.json ? result : formatMetadataStatus(result), options.json);
        return;
      }
      if (subcommand === "validate") {
        const result = validateMetadata({ strict: options.strict });
        print(options.json ? result : formatMetadataStatus(result, "Metadata validation"), options.json);
        if (!result.summary.valid) process.exitCode = 1;
        return;
      }
      if (subcommand === "export") {
        const destination = requireValue(positionals[1], "vlab metadata export <directory>");
        const result = exportMetadata(destination);
        print(options.json ? result : formatMetadataTransfer(result), options.json);
        return;
      }
      if (subcommand === "import") {
        const source = requireValue(positionals[1], "vlab metadata import <directory> --dry-run|--apply");
        const result = importMetadata(source, {
          dryRun: options.dryRun,
          apply: options.apply,
        });
        print(options.json ? result : formatMetadataTransfer(result), options.json);
        if (!result.summary.applicable) process.exitCode = 1;
        return;
      }
      if (subcommand === "benchmark") {
        const result = benchmarkRepositoryScale({
          history: options.history,
          workspaces: options.workspaces,
          notes: options.notes,
          resolutions: options.resolutions,
          samples: options.samples,
          budgetMs: options.budgetMs,
          areas: options.areas,
          filesPerArea: options.filesPerArea,
        });
        print(options.json ? result : formatScaleBenchmark(result), options.json);
        return;
      }
      throw new CliError("Unknown metadata command. Use status, validate, retain, export, import, or benchmark.",
        { code: "usage-unknown-command" });
    }
    case "workspace": {
      const subcommand = positionals[0];
      if (subcommand === "create") {
        const name = requireValue(positionals[1], "vlab workspace create <name>");
        const workspace = createWorkspace(name, options);
        print(workspace, options.json);
        return;
      }
      if (subcommand === "list") {
        print(listWorkspaces(), true);
        return;
      }
      if (subcommand === "checkpoint") {
        const checkpoint = checkpointWorkspace(options.label);
        print(checkpoint, options.json);
        return;
      }
      if (subcommand === "move") {
        const name = requireValue(positionals[1], "vlab workspace move <name> <directory>");
        const destination = requireValue(
          positionals[2],
          "vlab workspace move <name> <directory>",
        );
        print(moveWorkspace(name, destination), options.json);
        return;
      }
      if (subcommand === "archive") {
        const name = requireValue(positionals[1], "vlab workspace archive <name>");
        print(archiveWorkspace(name), options.json);
        return;
      }
      if (subcommand === "restore") {
        const name = requireValue(positionals[1], "vlab workspace restore <name>");
        print(restoreWorkspace(name, { path: options.path }), options.json);
        return;
      }
      if (subcommand === "repair") {
        const name = requireValue(positionals[1], "vlab workspace repair <name> --path <directory>");
        const repairPath = requireValue(
          options.path,
          "vlab workspace repair <name> --path <directory>",
        );
        print(repairWorkspace(name, repairPath), options.json);
        return;
      }
      if (subcommand === "prune") {
        print(pruneWorkspaces({
          apply: options.apply,
          dryRun: options.dryRun,
        }), options.json);
        return;
      }
      if (subcommand === "forecast") {
        const target = requireValue(
          positionals[1],
          "vlab workspace forecast <target> <source>",
        );
        const source = requireValue(
          positionals[2],
          "vlab workspace forecast <target> <source>",
        );
        const forecast = forecastWorkspaces(target, source, {
          acceptCandidates: options.acceptCandidates,
          sourceCheckpoint: options.sourceCheckpoint,
        });
        print(options.json ? forecast : formatForecast(forecast), options.json);
        return;
      }
      throw new CliError(
        "Unknown workspace command. Use create, list, checkpoint, move, archive, restore, repair, prune, or forecast.",
          { code: "usage-unknown-command" },
      );
    }
    case "spec": {
      const subcommand = positionals[0];
      if (subcommand === "index") {
        if (options.all) {
          const result = indexAllSpecs(process.cwd(), { force: options.force });
          print(options.json ? result : formatSpecBatch(result), options.json);
          return;
        }
        const file = requireValue(positionals[1], "vlab spec index <file>");
        const result = indexSpec(file, process.cwd(), { force: options.force });
        print(options.json ? result : formatSpecResult(result), options.json);
        return;
      }
      if (subcommand === "show") {
        const file = requireValue(positionals[1], "vlab spec show <file>");
        print(readSpecManifest(file), true);
        return;
      }
      if (subcommand === "merge-plan") {
        const file = requireValue(
          positionals[1],
          "vlab spec merge-plan <file> <base> <ours> <theirs>",
        );
        const base = requireValue(positionals[2], "vlab spec merge-plan <file> <base> <ours> <theirs>");
        const ours = requireValue(positionals[3], "vlab spec merge-plan <file> <base> <ours> <theirs>");
        const theirs = requireValue(positionals[4], "vlab spec merge-plan <file> <base> <ours> <theirs>");
        const result = planSpecMerge(file, base, ours, theirs);
        print(options.json ? result : formatSpecMergePlan(result), options.json);
        return;
      }
      if (subcommand === "status") {
        const result = pendingSpecMergeStatus();
        print(options.json ? result : formatSpecMergeStatus(result), options.json);
        return;
      }
      if (subcommand === "resolve") {
        const result = applyPendingSpecMerges({
          path: positionals[1],
          all: options.all,
        });
        print(options.json ? result : formatSpecMergeAction(result), options.json);
        return;
      }
      if (subcommand === "benchmark") {
        const result = benchmarkSpecIndex({
          documents: options.documents,
          blocks: options.blocks,
        });
        print(result, true);
        return;
      }
      throw new CliError("Unknown spec command. Use index, show, merge-plan, status, resolve, or benchmark.",
        { code: "usage-unknown-command" });
    }
    case "doctor": {
      // A diagnostic must not change what it diagnoses: the doctor reads the
      // repository context and never runs `vlab init`'s configuration writes.
      const context = repoContext();
      print({
        ok: true,
        // `vlab version` is text-only, so the doctor is the machine-readable
        // home for the build identity a peer needs to apply the per-family
        // compatibility rules of ADR-0020 (FR-GIT-06; issue #11 item 5).
        version: VERSION,
        git: gitVersion().raw,
        node: process.version,
        repository: context.root,
        notesRef: "refs/notes/vcs-lab",
        engine: describeReadEngines(),
        forecastEngine: forecastEngine(),
        differential: options.differential ? runDifferential(context.root) : undefined,
        benchmark: options.benchmark ? gitBenchmark(options) : undefined,
        objectSession: options.benchmark
          ? gitObjectSessionBenchmark(options, context.root)
          : undefined,
      }, true);
      return;
    }
    default:
      throw new CliError(`Unknown command '${command}'.\n\n${HELP}`,
        { code: "usage-unknown-command" });
  }
}
