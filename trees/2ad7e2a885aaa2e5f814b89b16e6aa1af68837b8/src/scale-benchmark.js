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
 * The plain-Git work a reader would run to obtain what a phase produces, timed
 * the same way the phase is (issue #42). A duration only becomes a ratio when
 * something measures the denominator, and until now exactly one Git-equivalent
 * comparison existed anywhere in the project, derived by hand.
 *
 * Three properties keep the comparison honest:
 *
 * - **The floors run after every phase**, on the same fixture, so no phase
 *   measurement changes and the committed deterministic baseline stays
 *   comparable. Adding a denominator must not move the numerator.
 * - **They are `rawProbe` reads, deliberately outside the engine seam.**
 *   A floor is a measurement of Git, not a read of repository state, and its
 *   result never reaches domain logic; routing it through the seam would
 *   measure the seam rather than Git. This is the same exemption the doctor's
 *   process-cost probes carry, and it is enforced rather than conventional:
 *   without the marker the native engine refuses the read outright.
 * - **Each floor names the commands it ran.** Which Git commands count as
 *   "equivalent" is a judgement, not a fact, so the judgement is published with
 *   the number rather than buried in the harness. `workspaceRegistry` has no
 *   equivalent at all -- Git has no workspace registry -- and reports `null`
 *   rather than an invented denominator.
 */
function batchReadObjects(repo, oids) {
  if (!oids.length) return;
  runGit(["cat-file", "--batch"], { cwd: repo, input: `${oids.join("\n")}\n`, rawProbe: true });
}

function noteBlobOids(repo) {
  const listed = runGit(["notes", "--ref=vcs-lab", "list"], { cwd: repo, rawProbe: true }).stdout;
  return listed.split("\n").filter(Boolean).map((line) => line.split(" ")[0]);
}

function resolutionBlobOids(repo) {
  const listed = runGit(
    ["for-each-ref", "--format=%(objectname)", "refs/vcs-lab/resolutions/"],
    { cwd: repo, rawProbe: true },
  ).stdout;
  return listed.split("\n").filter(Boolean);
}

function linkedWorktreePaths(repo) {
  const listed = runGit(["worktree", "list", "--porcelain"], { cwd: repo, rawProbe: true }).stdout;
  const paths = [];
  for (const line of listed.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
  }
  // The first entry is the repository's own worktree, which no workspace owns.
  return paths.slice(1);
}

const GIT_EQUIVALENTS = {
  history: {
    equivalent: "git rev-list --count refs/heads/main",
    run: (repo) => runGit(["rev-list", "--count", "refs/heads/main"], { cwd: repo, rawProbe: true }),
  },
  gitWorktrees: {
    equivalent: "git worktree list --porcelain",
    run: (repo) => runGit(["worktree", "list", "--porcelain"], { cwd: repo, rawProbe: true }),
  },
  // Git has no workspace registry, so there is nothing to compare against.
  workspaceRegistry: null,
  workspaceStatus: {
    equivalent: "git status --porcelain in each registered workspace worktree",
    // The worktrees the phase actually saw. Floors run last, by which time the
    // creation floors have added their own worktrees; statusing those would
    // compare vlab's work over N workspaces with Git's over more than N.
    run: (repo, context) => {
      for (const worktree of context.statusWorktrees) {
        runGit(["status", "--porcelain"], { cwd: worktree, rawProbe: true });
      }
    },
  },
  noteCatalog: {
    equivalent: "git notes --ref=vcs-lab list, then git cat-file --batch over the note blobs",
    run: (repo) => batchReadObjects(repo, noteBlobOids(repo)),
  },
  resolutionCatalog: {
    equivalent:
      "git for-each-ref refs/vcs-lab/resolutions/, then git cat-file --batch over the result blobs",
    run: (repo) => batchReadObjects(repo, resolutionBlobOids(repo)),
  },
  metadataStatus: {
    equivalent:
      "git rev-parse --git-dir and git worktree list, then the note and resolution reads above",
    run: (repo) => {
      runGit(["rev-parse", "--git-dir"], { cwd: repo, rawProbe: true });
      runGit(["worktree", "list", "--porcelain"], { cwd: repo, rawProbe: true });
      batchReadObjects(repo, noteBlobOids(repo));
      batchReadObjects(repo, resolutionBlobOids(repo));
    },
  },
  workspaceCreate: {
    equivalent: "git worktree add --detach <path> main",
    run: (repo, context) => {
      const target = path.join(context.worktreeRoot, `floor-create-${context.next()}`);
      runGit(["worktree", "add", "--detach", target, "main"], { cwd: repo });
    },
  },
  workspaceCreateCone: {
    // The same three commands vlab issues in `addWorktree`, so the gap this
    // floor exposes is vlab's own work rather than a different checkout.
    equivalent:
      "git worktree add --no-checkout --detach <path> main, git sparse-checkout set --cone <dir>, git checkout",
    run: (repo, context) => {
      const target = path.join(context.worktreeRoot, `floor-cone-${context.next()}`);
      runGit(["worktree", "add", "--no-checkout", "--detach", target, "main"], { cwd: repo });
      runGit(["sparse-checkout", "set", "--cone", "area000"], { cwd: target });
      runGit(["checkout"], { cwd: target });
    },
  },
};

function measureFloor(name, sampleCount, repo, context) {
  const equivalent = GIT_EQUIVALENTS[name];
  if (!equivalent) return null;
  const durations = [];
  const processes = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const collector = beginGitMetrics(`floor-${name}-${index}`);
    const started = performance.now();
    try {
      equivalent.run(repo, context);
    } finally {
      const durationMs = performance.now() - started;
      const git = endGitMetrics(collector);
      durations.push(Number(durationMs.toFixed(2)));
      processes.push(git.processes);
    }
  }
  return {
    equivalent: equivalent.equivalent,
    medianMs: Number(percentile(durations, 0.5).toFixed(2)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(2)),
    medianProcesses: percentile(processes, 0.5),
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
    // Captured before any phase runs, so the status floor measures the same
    // worktrees the status phase does.
    const statusWorktrees = linkedWorktreePaths(repo);
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

    // Denominators last, so no phase measurement above is disturbed by the
    // worktrees the creation floors add (issue #42).
    let floorSequence = 0;
    const floorContext = {
      worktreeRoot,
      statusWorktrees,
      next: () => {
        floorSequence += 1;
        return floorSequence;
      },
    };
    for (const name of Object.keys(measurements)) {
      measurements[name].floor = measureFloor(name, sampleCount, repo, floorContext);
    }

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
