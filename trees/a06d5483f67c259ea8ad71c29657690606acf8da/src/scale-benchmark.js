import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  beginGitMetrics,
  endGitMetrics,
  runGit,
} from "./git.js";
import { countCommits, gitVersion, listWorktrees } from "./engine.js";
import { appendNote, listNoteRecords } from "./notes.js";
import { metadataStatus } from "./metadata.js";
import {
  listResolutionRecords,
  publishResolution,
} from "./resolutions.js";
import {
  RESOLUTION_SIGNATURE_ALGORITHM,
  resolutionSignatureFor,
} from "./schemas.js";
import {
  createWorkspace,
  listWorkspaces,
  readWorkspaces,
} from "./workspaces.js";
import { CliError } from "./errors.js";
import { temporaryDirectory } from "./store.js";

const SCALE_BENCHMARK_SCHEMA = "vcs-lab.repository-scale-benchmark/v1";
// A batched scan costs a small fixed number of processes regardless of entity
// count, so a processes-per-entity ratio only indicates per-entity launches
// once the fixture holds enough entities for that fixed cost to be diluted.
const MINIMUM_ENTITIES_FOR_AMPLIFICATION_DECISION = 10;

function integerOption(value, fallback, name, minimum, maximum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CliError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
        { code: "usage-invalid-option-value" },
    );
  }
  return parsed;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function fixedGitDate(index) {
  return new Date(Date.UTC(2000, 0, 1, 0, 0, index)).toISOString();
}

function createCommit(repo, tree, parent, subject, index) {
  const args = ["commit-tree", tree];
  if (parent) args.push("-p", parent);
  args.push("-F", "-");
  const gitDate = fixedGitDate(index);
  return runGit(args, {
    cwd: repo,
    env: {
      GIT_AUTHOR_DATE: gitDate,
      GIT_COMMITTER_DATE: gitDate,
    },
    input: `${subject}\n`,
  }).stdout;
}

function measurePhase(name, sampleCount, operation) {
  const samples = [];
  let expectedResult = null;
  for (let index = 0; index < sampleCount; index += 1) {
    const collector = beginGitMetrics(`scale-${name}-${index}`);
    const started = performance.now();
    let result;
    let failure;
    try {
      result = operation();
    } catch (error) {
      failure = error;
    }
    const durationMs = performance.now() - started;
    const git = endGitMetrics(collector);
    if (failure) throw failure;
    const serialized = JSON.stringify(result);
    if (expectedResult === null) {
      expectedResult = serialized;
    } else if (serialized !== expectedResult) {
      throw new CliError(
        `Scale benchmark phase '${name}' returned inconsistent semantic results.`,
          { code: "internal-invariant" },
      );
    }
    samples.push({
      durationMs: Number(durationMs.toFixed(2)),
      git,
    });
  }

  const durations = samples.map((sample) => sample.durationMs);
  const processes = samples.map((sample) => sample.git.processes);
  const warmDurations = durations.slice(1);
  return {
    result: JSON.parse(expectedResult),
    coldMs: durations[0],
    warmMedianMs: warmDurations.length
      ? Number(percentile(warmDurations, 0.5).toFixed(2))
      : null,
    medianMs: Number(percentile(durations, 0.5).toFixed(2)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(2)),
    medianProcesses: percentile(processes, 0.5),
    samples,
  };
}

/**
 * Files and bytes present in a materialized workspace, ignoring Git's own
 * directory. This is the "bytes materialized per workspace" the v2 profile
 * records: on a synced or metered filesystem it is the cost a sparse cone
 * removes, and it is what makes the cone's effect measurable rather than
 * assumed (issue #10).
 */
function materializedTree(worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        files += 1;
        bytes += fs.statSync(full).size;
      }
    }
  };
  walk(worktreePath);
  return { files, bytes };
}

function countWorktrees(repo) {
  return listWorktrees(repo).length;
}

function ratio(numerator, denominator) {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(3));
}

function amplificationRecommendation(area, perEntity, entities, entityLabel, batchAction) {
  if ((perEntity ?? 0) <= 1) return null;
  if (entities < MINIMUM_ENTITIES_FOR_AMPLIFICATION_DECISION) {
    return {
      area,
      priority: "increase-fixture-volume",
      evidence: `${perEntity} Git processes per ${entityLabel} across only ${entities} ${entityLabel}s, below the ${MINIMUM_ENTITIES_FOR_AMPLIFICATION_DECISION}-entity minimum for a per-entity decision`,
      action:
        `Rerun with at least ${MINIMUM_ENTITIES_FOR_AMPLIFICATION_DECISION} ${entityLabel}s before attributing a bounded batch cost to per-entity process launches.`,
    };
  }
  return {
    area,
    priority: "batch-first",
    evidence: `${perEntity} Git processes per ${entityLabel}`,
    action: batchAction,
  };
}

export function buildAnalysis(measurements, fixture, budgetMs) {
  const amplification = {
    workspaceStatusProcessesPerWorkspace: ratio(
      measurements.workspaceStatus.medianProcesses,
      fixture.workspaces,
    ),
    noteCatalogProcessesPerTarget: ratio(
      measurements.noteCatalog.medianProcesses,
      fixture.totalNoteTargets,
    ),
    resolutionCatalogProcessesPerResolution: ratio(
      measurements.resolutionCatalog.medianProcesses,
      fixture.resolutions,
    ),
    minimumEntitiesForDecision: MINIMUM_ENTITIES_FOR_AMPLIFICATION_DECISION,
    decidable: {
      workspaceStatus:
        fixture.workspaces >= MINIMUM_ENTITIES_FOR_AMPLIFICATION_DECISION,
      resolutionCatalog:
        fixture.resolutions >= MINIMUM_ENTITIES_FOR_AMPLIFICATION_DECISION,
    },
  };
  const phasesOverBudget = Object.entries(measurements)
    .filter(([, measurement]) => measurement.medianMs > budgetMs)
    .map(([name]) => name)
    .sort();
  const recommendations = [
    amplificationRecommendation(
      "workspace-status",
      amplification.workspaceStatusProcessesPerWorkspace,
      fixture.workspaces,
      "registered workspace",
      "Remove per-workspace Git process launches from status discovery before adding a persistent registry index.",
    ),
    amplificationRecommendation(
      "resolution-catalog",
      amplification.resolutionCatalogProcessesPerResolution,
      fixture.resolutions,
      "retained resolution",
      "Remove per-record Git process launches from catalog discovery and validation before adding a persistent index.",
    ),
  ].filter(Boolean);
  if (fixture.totalNoteTargets > 0) {
    recommendations.push({
      area: "note-catalog",
      priority: measurements.noteCatalog.medianMs > budgetMs
        ? "measure-index-after-batching"
        : "retain-batched-scan",
      evidence: `${measurements.noteCatalog.medianProcesses} median Git processes for ${fixture.totalNoteTargets} note targets`,
      action:
        "Keep the existing batched object read; consider an incremental catalog only if representative-host latency exceeds the budget.",
    });
  }

  const hasProcessAmplification = recommendations.some(
    (recommendation) => recommendation.priority === "batch-first",
  );
  return {
    interactiveBudgetMs: budgetMs,
    processAmplification: amplification,
    phasesOverBudget,
    recommendations,
    nextAction: hasProcessAmplification
      ? "batch-process-amplified-scans"
      : phasesOverBudget.length
        ? "evaluate-incremental-catalogs"
        : "increase-fixture-volume-and-collect-more-hosts",
    persistentIndex: {
      recommendedNow: !hasProcessAmplification && phasesOverBudget.length > 0,
      reason: hasProcessAmplification
        ? "Avoidable per-entity Git process amplification must be removed before attributing latency to missing persisted indexes."
        : phasesOverBudget.length
          ? "At least one already-batched scan exceeds the configured interactive budget."
          : "No measured median exceeds the configured interactive budget.",
    },
    residentService: {
      recommendedNow: false,
      gate: "not-reached",
      reason: hasProcessAmplification
        ? "The measured hot paths still have invocation-local batching opportunities."
        : "One local synthetic fixture is insufficient to justify service lifecycle, locking, security, and upgrade costs.",
      reconsiderAfter:
        "Rerun this schema on representative Windows and non-Windows repositories after batching and any justified incremental catalogs.",
    },
  };
}

export function benchmarkRepositoryScale(options = {}) {
  const historyDepth = integerOption(
    options.history,
    250,
    "--history",
    1,
    5_000,
  );
  const workspaceCount = integerOption(
    options.workspaces,
    12,
    "--workspaces",
    0,
    100,
  );
  const noteCount = integerOption(
    options.notes,
    250,
    "--notes",
    0,
    5_000,
  );
  const resolutionCount = integerOption(
    options.resolutions,
    50,
    "--resolutions",
    0,
    1_000,
  );
  const sampleCount = integerOption(
    options.samples,
    3,
    "--samples",
    1,
    10,
  );
  const interactiveBudgetMs = integerOption(
    options.budgetMs,
    1_000,
    "--budget-ms",
    1,
    60_000,
  );
  // The fixture's working tree. Until v2 every history commit carried the
  // empty tree, so a workspace materialized nothing and workspace creation
  // could not be measured at all.
  const areaCount = integerOption(options.areas, 10, "--areas", 1, 200);
  const filesPerArea = integerOption(
    options.filesPerArea,
    60,
    "--files-per-area",
    1,
    500,
  );
  if (noteCount + resolutionCount > 5_000) {
    throw new CliError(
      "The scale benchmark is limited to 5,000 total note and resolution records.",
        { code: "usage-invalid-option-value" },
    );
  }

  const benchmarkRoot = temporaryDirectory("vcs-lab-scale-benchmark-");
  const repo = path.join(benchmarkRoot, "repo");
  const worktreeRoot = path.join(benchmarkRoot, "worktrees");
  const setupCollector = beginGitMetrics("scale-fixture-setup");
  const setupStarted = performance.now();
  let setupGit = null;
  try {
    fs.mkdirSync(repo, { recursive: true });
    runGit(["init", "-q", "-b", "main"], { cwd: repo });
    runGit(["config", "user.name", "VCS Lab Scale Fixture"], { cwd: repo });
    runGit(
      ["config", "user.email", "vcs-lab-scale@example.invalid"],
      { cwd: repo },
    );
    runGit(["config", "core.autocrlf", "false"], { cwd: repo });
    const gitVersionText = gitVersion(repo).raw;
    const emptyTree = runGit(["mktree"], { cwd: repo, input: "" }).stdout;

    // The fixture's working tree, spread over several directories and carried
    // by every history commit. Until the reduced-local-v2 profile every commit
    // held the empty tree, so a materialized workspace contained no files and
    // workspace creation could not be measured at all (issue #10). Every file
    // is the same size, so materialized bytes are a function of the file count
    // and stay comparable between hosts.
    for (let area = 0; area < areaCount; area += 1) {
      const areaDir = path.join(repo, `area${String(area).padStart(3, "0")}`);
      fs.mkdirSync(areaDir, { recursive: true });
      for (let file = 0; file < filesPerArea; file += 1) {
        fs.writeFileSync(
          path.join(areaDir, `f${String(file).padStart(4, "0")}.txt`),
          `${"x".repeat(1024)}` + "\n",
        );
      }
    }
    runGit(["add", "-A"], { cwd: repo });
    const contentTree = runGit(["write-tree"], { cwd: repo }).stdout;
    const commits = [];
    let parent = null;
    for (let index = 0; index < historyDepth; index += 1) {
      parent = createCommit(
        repo,
        contentTree,
        parent,
        `Scale history ${index + 1}`,
        index,
      );
      commits.push(parent);
    }
    runGit(["update-ref", "refs/heads/main", parent], { cwd: repo });
    runGit(["reset", "--hard", "main"], { cwd: repo });

    const baseCommit = commits[0];
    for (let index = 0; index < noteCount; index += 1) {
      const target = commits[index] ?? createCommit(
        repo,
        emptyTree,
        baseCommit,
        `Detached note target ${index + 1}`,
        historyDepth + index,
      );
      appendNote(target, {
        schema: "vcs-lab.application/v1",
        type: "application",
        id: `scale_application_${String(index).padStart(6, "0")}`,
        originCommit: baseCommit,
        originChangeId: `scale_origin_${String(index).padStart(6, "0")}`,
        appliedCommit: target,
        appliedChangeId: `scale_applied_${String(index).padStart(6, "0")}`,
        targetBefore: baseCommit,
        relation: "scale-fixture",
        createdAt: fixedGitDate(historyDepth + noteCount + index),
      }, repo);
    }

    const sharedBaseBlob = runGit(["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: "base\n",
    }).stdout;
    const sharedOursBlob = runGit(["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: "ours\n",
    }).stdout;
    const sharedResultBlob = runGit(["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: "resolved\n",
    }).stdout;
    for (let index = 0; index < resolutionCount; index += 1) {
      const theirsBlob = runGit(["hash-object", "-w", "--stdin"], {
        cwd: repo,
        input: `theirs ${index}\n`,
      }).stdout;
      const stages = {
        base: { mode: "100644", blob: sharedBaseBlob },
        ours: { mode: "100644", blob: sharedOursBlob },
        theirs: { mode: "100644", blob: theirsBlob },
      };
      publishResolution({
        ...stages,
        signature: resolutionSignatureFor(stages),
        algorithm: RESOLUTION_SIGNATURE_ALGORITHM,
        path: `scale-${String(index).padStart(6, "0")}.txt`,
        resultBlob: sharedResultBlob,
        resultMode: "100644",
        decision: "created",
      }, {
        id: `scale_resolution_application_${String(index).padStart(6, "0")}`,
        appliedCommit: parent,
        appliedChangeId: `scale_resolution_change_${String(index).padStart(6, "0")}`,
      }, repo);
    }

    for (let index = 0; index < workspaceCount; index += 1) {
      const name = `scale-${String(index).padStart(3, "0")}`;
      createWorkspace(name, {
        cwd: repo,
        from: "main",
        path: path.join(worktreeRoot, name),
        owner: "scale-fixture",
        focus: "status-scan",
      });
    }

    setupGit = endGitMetrics(setupCollector);
    const setupDurationMs = Number(
      (performance.now() - setupStarted).toFixed(2),
    );
    const fixture = {
      profile:
        options.history === undefined &&
        options.workspaces === undefined &&
        options.notes === undefined &&
        options.resolutions === undefined
          ? "representative-local-v1"
          : "custom-v1",
      historyDepth,
      workspaces: workspaceCount,
      causalNotes: noteCount,
      resolutions: resolutionCount,
      totalNoteTargets: noteCount + resolutionCount,
      totalNoteRecords: noteCount + resolutionCount,
      areas: areaCount,
      filesPerArea,
      treeFiles: areaCount * filesPerArea,
    };
    const createdFull = [];
    const createdCone = [];
    const measurements = {
      history: measurePhase("history", sampleCount, () => ({
        commits: countCommits("refs/heads/main", repo),
      })),
      gitWorktrees: measurePhase("git-worktrees", sampleCount, () => ({
        worktrees: countWorktrees(repo),
      })),
      workspaceRegistry: measurePhase(
        "workspace-registry",
        sampleCount,
        () => ({ workspaces: readWorkspaces(repo).workspaces.length }),
      ),
      workspaceStatus: measurePhase("workspace-status", sampleCount, () => {
        const workspaces = listWorkspaces(repo);
        return {
          workspaces: workspaces.length,
          active: workspaces.filter((workspace) => workspace.status === "active").length,
          dirty: workspaces.filter((workspace) => workspace.dirtyFiles > 0).length,
        };
      }),
      noteCatalog: measurePhase("note-catalog", sampleCount, () => ({
        records: listNoteRecords(repo).length,
      })),
      resolutionCatalog: measurePhase(
        "resolution-catalog",
        sampleCount,
        () => ({ resolutions: listResolutionRecords(repo).length }),
      ),
      metadataStatus: measurePhase("metadata-status", sampleCount, () => {
        const status = metadataStatus({ cwd: repo });
        return {
          valid: status.summary.valid,
          acceptedPortableRecords: status.summary.acceptedPortableRecords,
          noteTargets: status.scopes.sharedPortable.notes.targetCount,
          resolutionRefs: status.scopes.sharedPortable.resolutions.refCount,
          registeredWorkspaces: status.scopes.sharedLocal.workspaceRegistry.count,
          materializedWorktrees: status.scopes.worktreePrivate.worktreeCount,
        };
      }),
      workspaceCreate: measurePhase("workspace-create", sampleCount, () => {
        createWorkspace(`scale-create-${createdFull.length}`, {
          cwd: repo,
          from: "main",
          path: path.join(worktreeRoot, `create-${createdFull.length}`),
        });
        createdFull.push(path.join(worktreeRoot, `create-${createdFull.length}`));
        return { created: 1 };
      }),
      workspaceCreateCone: measurePhase("workspace-create-cone", sampleCount, () => {
        createWorkspace(`scale-cone-${createdCone.length}`, {
          cwd: repo,
          from: "main",
          path: path.join(worktreeRoot, `cone-${createdCone.length}`),
          cone: ["area000"],
        });
        createdCone.push(path.join(worktreeRoot, `cone-${createdCone.length}`));
        return { created: 1 };
      }),
    };

    const materialization = {
      full: materializedTree(createdFull[0]),
      cone: materializedTree(createdCone[0]),
    };

    return {
      schema: SCALE_BENCHMARK_SCHEMA,
      environment: {
        platform: process.platform,
        node: process.version,
        git: gitVersionText,
      },
      fixture,
      coverage: {
        historyDepth: true,
        worktreeAndRegistryVolume: true,
        causalNoteVolume: true,
        resolutionVolume: true,
        documentationVolume: {
          companionSchema: "vcs-lab.spec-benchmark/v2",
          command: "vlab spec benchmark --documents <n> --blocks <n> --json",
        },
      },
      samples: sampleCount,
      setup: {
        durationMs: setupDurationMs,
        git: setupGit,
        expectedAbsentProbeFailures:
          noteCount + (resolutionCount * 2) + workspaceCount,
        unexpectedGitFailures: Math.max(
          0,
          setupGit.failed - noteCount - (resolutionCount * 2) - workspaceCount,
        ),
      },
      measurements,
      materialization,
      analysis: buildAnalysis(
        measurements,
        fixture,
        interactiveBudgetMs,
      ),
      privacy: {
        repositoryPathsIncluded: false,
        objectIdsIncluded: false,
        fileContentsIncluded: false,
        commitMessagesIncluded: false,
      },
      cleanup: {
        temporaryFixtureRemoved: true,
      },
    };
  } finally {
    if (!setupGit) endGitMetrics(setupCollector);
    fs.rmSync(benchmarkRoot, { recursive: true, force: true });
  }
}
