//! `cst metadata benchmark`: `benchmarkRepositoryScale` of
//! `src/scale-benchmark.js` and `formatScaleBenchmark` of `src/cli.js`.
//!
//! A generated repository, the phases a reader pays for measured over it, and
//! the plain-Git work that would obtain the same thing, timed the same way
//! (issue #42). Durations aside, the report is what the JavaScript CLI
//! produces, down to the Git process count of every sample.

use crate::notes_write::append_note;
use crate::reconcile::publish_resolution;
use crate::workspaces::{CreateOptions, create_workspace, list_workspaces, read_workspaces};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{names, ref_family};
use causet_engine::process::{GitOutput, RunOptions, run_git};
use causet_engine::{engine, metrics, text};
use causet_model::js::{get, text as js_text, to_fixed, truthy};
use causet_model::json::{Object, Value, number_to_string, string, stringify};
use causet_model::registry::RESOLUTION_SIGNATURE_ALGORITHM;
use std::time::Instant;

const SCHEMA: &str = "causet.repository-scale-benchmark/v1";
// A batched scan costs a small fixed number of processes whatever the entity
// count, so a processes-per-entity ratio only indicates per-entity launches
// once the fixture holds enough entities to dilute that fixed cost.
const MINIMUM_ENTITIES_FOR_DECISION: usize = 10;

fn owned(args: &[&str]) -> Vec<String> {
  args.iter().map(|arg| (*arg).to_string()).collect()
}

fn git(args: &[&str], cwd: &str) -> GitResult<GitOutput> {
  run_git(&owned(args), &RunOptions::new(cwd))
}

fn git_with_input(args: &[&str], cwd: &str, input: &str) -> GitResult<GitOutput> {
  run_git(&owned(args), &RunOptions::new(cwd).input(input))
}

/// A read made to measure Git, deliberately outside the engine seam.
fn probe(args: &[&str], cwd: &str, input: Option<&str>) -> GitResult<GitOutput> {
  let mut options = RunOptions::new(cwd);
  options.raw_probe = true;
  if let Some(input) = input {
    options = options.input(input);
  }
  run_git(&owned(args), &options)
}

fn elapsed(started: Instant) -> f64 {
  started.elapsed().as_secs_f64() * 1000.0
}

/// `Number(value.toFixed(digits))`.
fn rounded(value: f64, digits: u32) -> Value {
  match to_fixed(value, digits).parse::<f64>() {
    Ok(number) => Value::Number(number),
    Err(_) => Value::Null,
  }
}

fn count(value: usize) -> Value {
  Value::Number(value as f64)
}

fn io(error: &std::io::Error, call: &str, path: &str) -> GitError {
  crate::envelope::io_failure(error, call, path)
}

/// `integerOption(value, fallback, name, minimum, maximum)`.
fn integer_option(value: Option<&str>, fallback: usize, name: &str, minimum: usize, maximum: usize) -> GitResult<usize> {
  let parsed = value.map_or(fallback as f64, text::number);
  if parsed.fract() != 0.0 || !parsed.is_finite() || parsed < minimum as f64 || parsed > maximum as f64 {
    return Err(GitError::new(
      "usage-invalid-option-value",
      format!("{name} must be an integer between {minimum} and {maximum}."),
    ));
  }
  Ok(parsed as usize)
}

/// `percentile(values, fraction)`.
fn percentile(values: &[f64], fraction: f64) -> f64 {
  let mut sorted = values.to_vec();
  sorted.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
  let index = ((sorted.len() as f64 * fraction).ceil() as usize).max(1) - 1;
  sorted.get(index).copied().unwrap_or(f64::NAN)
}

/// `fixedGitDate(index)`: `index` seconds into the year 2000, as
/// `Date.prototype.toISOString` writes it.
fn fixed_git_date(index: usize) -> String {
  let seconds = 946_684_800u64 + index as u64;
  let days = (seconds / 86_400) as i64;
  let rest = seconds % 86_400;
  // Days since 1970-01-01 to a civil date (proleptic Gregorian).
  let shifted = days + 719_468;
  let era = shifted.div_euclid(146_097);
  let day_of_era = shifted.rem_euclid(146_097);
  let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
  let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
  let month_index = (5 * day_of_year + 2) / 153;
  let day = day_of_year - (153 * month_index + 2) / 5 + 1;
  let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
  let year = year_of_era + era * 400 + i64::from(month <= 2);
  format!(
    "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
    rest / 3_600,
    rest % 3_600 / 60,
    rest % 60
  )
}

/// `createCommit(repo, tree, parent, subject, index)`.
fn create_commit(repo: &str, tree: &str, parent: Option<&str>, subject: &str, index: usize) -> GitResult<String> {
  let mut args = vec!["commit-tree", tree];
  if let Some(parent) = parent {
    args.extend(["-p", parent]);
  }
  args.extend(["-F", "-"]);
  let date = fixed_git_date(index);
  let options = RunOptions::new(repo)
    .env("GIT_AUTHOR_DATE", &date)
    .env("GIT_COMMITTER_DATE", &date)
    .input(format!("{subject}\n"));
  Ok(run_git(&owned(&args), &options)?.stdout)
}

/// `measurePhase(name, sampleCount, operation)`: the operation run once per
/// sample, each with its duration and Git activity, and refused if two runs
/// disagree about what they found.
fn measure_phase(
  name: &str,
  sample_count: usize,
  mut operation: impl FnMut() -> GitResult<Value>,
) -> GitResult<Object> {
  let mut samples = Vec::new();
  let mut durations = Vec::new();
  let mut processes = Vec::new();
  let mut expected: Option<(String, Value)> = None;
  for index in 0..sample_count {
    let collector = metrics::begin(&format!("scale-{name}-{index}"));
    let started = Instant::now();
    let outcome = operation();
    let duration = elapsed(started);
    let activity = metrics::end(collector);
    let result = outcome?;
    let serialized = stringify(&result);
    match &expected {
      None => expected = Some((serialized, result)),
      Some((first, _)) if *first != serialized => {
        return Err(GitError::new(
          "internal-invariant",
          format!("Scale benchmark phase '{name}' returned inconsistent semantic results."),
        ));
      }
      Some(_) => {}
    }
    let duration = rounded(duration, 2);
    if let Value::Number(duration) = duration {
      durations.push(duration);
    }
    processes.push(activity.processes as f64);
    let mut sample = Object::new();
    sample.set("durationMs", duration);
    sample.set("git", activity.to_value());
    samples.push(Value::Object(sample));
  }
  let mut measurement = Object::new();
  measurement.set("result", expected.map_or(Value::Null, |(_, result)| result));
  measurement.set("coldMs", durations.first().map_or(Value::Null, |first| Value::Number(*first)));
  measurement.set(
    "warmMedianMs",
    if durations.len() > 1 { rounded(percentile(&durations[1..], 0.5), 2) } else { Value::Null },
  );
  measurement.set("medianMs", rounded(percentile(&durations, 0.5), 2));
  measurement.set("p95Ms", rounded(percentile(&durations, 0.95), 2));
  measurement.set("medianProcesses", Value::Number(percentile(&processes, 0.5)));
  measurement.set("samples", Value::Array(samples));
  Ok(measurement)
}

/// `batchReadObjects(repo, oids)`.
fn batch_read_objects(repo: &str, oids: &[String]) -> GitResult<()> {
  if oids.is_empty() {
    return Ok(());
  }
  probe(&["cat-file", "--batch"], repo, Some(&format!("{}\n", oids.join("\n"))))?;
  Ok(())
}

fn lines(output: &str) -> impl Iterator<Item = &str> {
  output.split('\n').filter(|line| !line.is_empty())
}

/// `noteBlobOids(repo)`.
fn note_blob_oids(repo: &str) -> GitResult<Vec<String>> {
  let notes = format!("--ref={}", names(repo)?.notes_name);
  let listed = probe(&["notes", &notes, "list"], repo, None)?.stdout;
  Ok(
    lines(&listed)
      .map(|line| line.split(' ').next().unwrap_or_default().to_string())
      .collect(),
  )
}

/// `resolutionBlobOids(repo)`.
fn resolution_blob_oids(repo: &str) -> GitResult<Vec<String>> {
  let family = format!("{}/", ref_family("resolutions", repo)?);
  let listed = probe(&["for-each-ref", "--format=%(objectname)", &family], repo, None)?.stdout;
  Ok(lines(&listed).map(str::to_string).collect())
}

/// `linkedWorktreePaths(repo)`: every worktree but the repository's own,
/// which no workspace owns.
fn linked_worktree_paths(repo: &str) -> GitResult<Vec<String>> {
  let listed = probe(&["worktree", "list", "--porcelain"], repo, None)?.stdout;
  Ok(
    listed
      .split('\n')
      .filter_map(|line| line.strip_prefix("worktree "))
      .map(|path| text::trim(path).to_string())
      .skip(1)
      .collect(),
  )
}

/// What the floors share: where the creation floors put their worktrees, the
/// worktrees the status phase saw, and the next floor worktree's number.
struct FloorContext {
  worktree_root: String,
  status_worktrees: Vec<String>,
  sequence: usize,
}

/// `GIT_EQUIVALENTS[name]`: what the floor says it ran. Which Git commands
/// count as equivalent is a judgement, so it is published with the number.
/// Git has no workspace registry, so that phase has no floor.
fn equivalent(name: &str) -> Option<&'static str> {
  Some(match name {
    "history" => "git rev-list --count refs/heads/main",
    "gitWorktrees" => "git worktree list --porcelain",
    "workspaceStatus" => "git status --porcelain in each registered workspace worktree",
    "noteCatalog" => "git notes --ref=causet list, then git cat-file --batch over the note blobs",
    "resolutionCatalog" => {
      "git for-each-ref refs/causet/resolutions/, then git cat-file --batch over the result blobs"
    }
    "metadataStatus" => {
      "git rev-parse --git-dir and git worktree list, then the note and resolution reads above"
    }
    "workspaceCreate" => "git worktree add --detach <path> main",
    "workspaceCreateCone" => {
      "git worktree add --no-checkout --detach <path> main, git sparse-checkout set --cone <dir>, git checkout"
    }
    _ => return None,
  })
}

/// `GIT_EQUIVALENTS[name].run(repo, context)`.
fn run_floor(name: &str, repo: &str, context: &mut FloorContext) -> GitResult<()> {
  match name {
    "history" => {
      probe(&["rev-list", "--count", "refs/heads/main"], repo, None)?;
    }
    "gitWorktrees" => {
      probe(&["worktree", "list", "--porcelain"], repo, None)?;
    }
    // The worktrees the phase saw: by now the creation floors have added
    // their own, and statusing those would compare over more workspaces.
    "workspaceStatus" => {
      for worktree in &context.status_worktrees {
        probe(&["status", "--porcelain"], worktree, None)?;
      }
    }
    "noteCatalog" => batch_read_objects(repo, &note_blob_oids(repo)?)?,
    "resolutionCatalog" => batch_read_objects(repo, &resolution_blob_oids(repo)?)?,
    "metadataStatus" => {
      probe(&["rev-parse", "--git-dir"], repo, None)?;
      probe(&["worktree", "list", "--porcelain"], repo, None)?;
      batch_read_objects(repo, &note_blob_oids(repo)?)?;
      batch_read_objects(repo, &resolution_blob_oids(repo)?)?;
    }
    "workspaceCreate" => {
      context.sequence += 1;
      let target = text::join(&context.worktree_root, &format!("floor-create-{}", context.sequence));
      git(&["worktree", "add", "--detach", &target, "main"], repo)?;
    }
    // The three commands `cst workspace create --cone` issues, so the gap
    // this floor exposes is the CLI's own work, not a different checkout.
    "workspaceCreateCone" => {
      context.sequence += 1;
      let target = text::join(&context.worktree_root, &format!("floor-cone-{}", context.sequence));
      git(&["worktree", "add", "--no-checkout", "--detach", &target, "main"], repo)?;
      git(&["sparse-checkout", "set", "--cone", "area000"], &target)?;
      git(&["checkout"], &target)?;
    }
    _ => {}
  }
  Ok(())
}

/// `measureFloor(name, sampleCount, repo, context)`.
fn measure_floor(name: &str, sample_count: usize, repo: &str, context: &mut FloorContext) -> GitResult<Value> {
  let Some(equivalent) = equivalent(name) else {
    return Ok(Value::Null);
  };
  let mut durations = Vec::new();
  let mut processes = Vec::new();
  for index in 0..sample_count {
    let collector = metrics::begin(&format!("floor-{name}-{index}"));
    let started = Instant::now();
    let outcome = run_floor(name, repo, context);
    let duration = elapsed(started);
    let activity = metrics::end(collector);
    if let Value::Number(duration) = rounded(duration, 2) {
      durations.push(duration);
    }
    processes.push(activity.processes as f64);
    outcome?;
  }
  let mut floor = Object::new();
  floor.set("equivalent", string(equivalent));
  floor.set("medianMs", rounded(percentile(&durations, 0.5), 2));
  floor.set("p95Ms", rounded(percentile(&durations, 0.95), 2));
  floor.set("medianProcesses", Value::Number(percentile(&processes, 0.5)));
  Ok(Value::Object(floor))
}

/// `materializedTree(worktreePath)`: the files and bytes present in a
/// materialized workspace, Git's own directory aside. On a synced or metered
/// file system this is the cost a sparse cone removes (issue #10).
fn materialized_tree(worktree: Option<&String>) -> GitResult<Value> {
  fn walk(directory: &std::path::Path, files: &mut f64, bytes: &mut f64) -> std::io::Result<()> {
    for entry in std::fs::read_dir(directory)? {
      let entry = entry?;
      if entry.file_name() == ".git" {
        continue;
      }
      if entry.file_type()?.is_dir() {
        walk(&entry.path(), files, bytes)?;
      } else {
        *files += 1.0;
        *bytes += std::fs::metadata(entry.path())?.len() as f64;
      }
    }
    Ok(())
  }
  let (mut files, mut bytes) = (0.0, 0.0);
  if let Some(worktree) = worktree.filter(|worktree| std::path::Path::new(worktree).exists()) {
    walk(std::path::Path::new(worktree), &mut files, &mut bytes).map_err(|error| io(&error, "scandir", worktree))?;
  }
  let mut tree = Object::new();
  tree.set("files", Value::Number(files));
  tree.set("bytes", Value::Number(bytes));
  Ok(Value::Object(tree))
}

/// `ratio(numerator, denominator)`.
fn ratio(numerator: f64, denominator: usize) -> Value {
  if denominator == 0 {
    return Value::Null;
  }
  rounded(numerator / denominator as f64, 3)
}

/// `amplificationRecommendation(...)`.
fn amplification_recommendation(
  area: &str,
  per_entity: &Value,
  entities: usize,
  label: &str,
  batch_action: &str,
) -> Option<Value> {
  let amount = match per_entity {
    Value::Number(amount) => *amount,
    _ => 0.0,
  };
  if amount <= 1.0 {
    return None;
  }
  let per_entity = number_to_string(amount);
  let mut recommendation = Object::new();
  recommendation.set("area", string(area));
  if entities < MINIMUM_ENTITIES_FOR_DECISION {
    recommendation.set("priority", string("increase-fixture-volume"));
    recommendation.set(
      "evidence",
      string(&format!(
        "{per_entity} Git processes per {label} across only {entities} {label}s, below the {MINIMUM_ENTITIES_FOR_DECISION}-entity minimum for a per-entity decision"
      )),
    );
    recommendation.set(
      "action",
      string(&format!(
        "Rerun with at least {MINIMUM_ENTITIES_FOR_DECISION} {label}s before attributing a bounded batch cost to per-entity process launches."
      )),
    );
  } else {
    recommendation.set("priority", string("batch-first"));
    recommendation.set("evidence", string(&format!("{per_entity} Git processes per {label}")));
    recommendation.set("action", string(batch_action));
  }
  Some(Value::Object(recommendation))
}

/// The sizes of the generated fixture.
struct Fixture {
  workspaces: usize,
  resolutions: usize,
  note_targets: usize,
}

/// `buildAnalysis(measurements, fixture, budgetMs)`.
fn build_analysis(measurements: &Object, fixture: &Fixture, budget: usize) -> Value {
  let median = |name: &str, member: &str| match get(measurements.get(name), member) {
    Some(Value::Number(value)) => *value,
    _ => f64::NAN,
  };
  let status_ratio = ratio(median("workspaceStatus", "medianProcesses"), fixture.workspaces);
  let resolution_ratio = ratio(median("resolutionCatalog", "medianProcesses"), fixture.resolutions);
  let mut decidable = Object::new();
  decidable.set(
    "workspaceStatus",
    Value::Bool(fixture.workspaces >= MINIMUM_ENTITIES_FOR_DECISION),
  );
  decidable.set(
    "resolutionCatalog",
    Value::Bool(fixture.resolutions >= MINIMUM_ENTITIES_FOR_DECISION),
  );
  let mut amplification = Object::new();
  amplification.set("workspaceStatusProcessesPerWorkspace", status_ratio.clone());
  amplification.set(
    "noteCatalogProcessesPerTarget",
    ratio(median("noteCatalog", "medianProcesses"), fixture.note_targets),
  );
  amplification.set("resolutionCatalogProcessesPerResolution", resolution_ratio.clone());
  amplification.set("minimumEntitiesForDecision", count(MINIMUM_ENTITIES_FOR_DECISION));
  amplification.set("decidable", Value::Object(decidable));

  let mut over_budget: Vec<String> = measurements
    .keys()
    .into_iter()
    .map(|name| causet_model::json::lossy(name))
    .filter(|name| median(name, "medianMs") > budget as f64)
    .collect();
  text::sort(&mut over_budget);
  let mut recommendations: Vec<Value> = [
    amplification_recommendation(
      "workspace-status",
      &status_ratio,
      fixture.workspaces,
      "registered workspace",
      "Remove per-workspace Git process launches from status discovery before adding a persistent registry index.",
    ),
    amplification_recommendation(
      "resolution-catalog",
      &resolution_ratio,
      fixture.resolutions,
      "retained resolution",
      "Remove per-record Git process launches from catalog discovery and validation before adding a persistent index.",
    ),
  ]
  .into_iter()
  .flatten()
  .collect();
  if fixture.note_targets > 0 {
    let mut recommendation = Object::new();
    recommendation.set("area", string("note-catalog"));
    recommendation.set(
      "priority",
      string(if median("noteCatalog", "medianMs") > budget as f64 {
        "measure-index-after-batching"
      } else {
        "retain-batched-scan"
      }),
    );
    recommendation.set(
      "evidence",
      string(&format!(
        "{} median Git processes for {} note targets",
        number_to_string(median("noteCatalog", "medianProcesses")),
        fixture.note_targets
      )),
    );
    recommendation.set(
      "action",
      string(
        "Keep the existing batched object read; consider an incremental catalog only if representative-host latency exceeds the budget.",
      ),
    );
    recommendations.push(Value::Object(recommendation));
  }
  let amplified = recommendations
    .iter()
    .any(|recommendation| js_text(get(Some(recommendation), "priority")) == "batch-first");
  let over = !over_budget.is_empty();

  let mut index = Object::new();
  index.set("recommendedNow", Value::Bool(!amplified && over));
  index.set(
    "reason",
    string(if amplified {
      "Avoidable per-entity Git process amplification must be removed before attributing latency to missing persisted indexes."
    } else if over {
      "At least one already-batched scan exceeds the configured interactive budget."
    } else {
      "No measured median exceeds the configured interactive budget."
    }),
  );
  let mut service = Object::new();
  service.set("recommendedNow", Value::Bool(false));
  service.set("gate", string("not-reached"));
  service.set(
    "reason",
    string(if amplified {
      "The measured hot paths still have invocation-local batching opportunities."
    } else {
      "One local synthetic fixture is insufficient to justify service lifecycle, locking, security, and upgrade costs."
    }),
  );
  service.set(
    "reconsiderAfter",
    string(
      "Rerun this schema on representative Windows and non-Windows repositories after batching and any justified incremental catalogs.",
    ),
  );
  let mut analysis = Object::new();
  analysis.set("interactiveBudgetMs", count(budget));
  analysis.set("processAmplification", Value::Object(amplification));
  analysis.set(
    "phasesOverBudget",
    Value::Array(over_budget.iter().map(|name| string(name)).collect()),
  );
  analysis.set("recommendations", Value::Array(recommendations));
  analysis.set(
    "nextAction",
    string(if amplified {
      "batch-process-amplified-scans"
    } else if over {
      "evaluate-incremental-catalogs"
    } else {
      "increase-fixture-volume-and-collect-more-hosts"
    }),
  );
  analysis.set("persistentIndex", Value::Object(index));
  analysis.set("residentService", Value::Object(service));
  Value::Object(analysis)
}

/// What `cst metadata benchmark` was asked for.
pub struct Options<'a> {
  pub history: Option<&'a str>,
  pub workspaces: Option<&'a str>,
  pub notes: Option<&'a str>,
  pub resolutions: Option<&'a str>,
  pub samples: Option<&'a str>,
  pub budget_ms: Option<&'a str>,
  pub areas: Option<&'a str>,
  pub files_per_area: Option<&'a str>,
}

/// The validated sizes of a run.
struct Sizes {
  history: usize,
  workspaces: usize,
  notes: usize,
  resolutions: usize,
  samples: usize,
  budget: usize,
  areas: usize,
  files_per_area: usize,
  custom: bool,
}

/// `benchmarkRepositoryScale(options)`.
pub fn benchmark_repository_scale(options: &Options) -> GitResult<Value> {
  let sizes = Sizes {
    history: integer_option(options.history, 250, "--history", 1, 5_000)?,
    workspaces: integer_option(options.workspaces, 12, "--workspaces", 0, 100)?,
    notes: integer_option(options.notes, 250, "--notes", 0, 5_000)?,
    resolutions: integer_option(options.resolutions, 50, "--resolutions", 0, 1_000)?,
    samples: integer_option(options.samples, 3, "--samples", 1, 10)?,
    budget: integer_option(options.budget_ms, 1_000, "--budget-ms", 1, 60_000)?,
    // The fixture's working tree. Without one a workspace materializes
    // nothing and workspace creation cannot be measured at all.
    areas: integer_option(options.areas, 10, "--areas", 1, 200)?,
    files_per_area: integer_option(options.files_per_area, 60, "--files-per-area", 1, 500)?,
    custom: options.history.is_some()
      || options.workspaces.is_some()
      || options.notes.is_some()
      || options.resolutions.is_some(),
  };
  if sizes.notes + sizes.resolutions > 5_000 {
    return Err(GitError::new(
      "usage-invalid-option-value",
      "The scale benchmark is limited to 5,000 total note and resolution records.",
    ));
  }
  let root = crate::export::temporary_directory("vcs-lab-scale-benchmark-")?;
  let mut setup = Some(metrics::begin("scale-fixture-setup"));
  let outcome = benchmark_in(&root, &sizes, &mut setup);
  if let Some(setup) = setup {
    metrics::end(setup);
  }
  match std::fs::remove_dir_all(&root) {
    Err(error) if error.kind() != std::io::ErrorKind::NotFound => outcome.and(Err(io(&error, "rm", &root))),
    _ => outcome,
  }
}

fn benchmark_in(
  root: &str,
  sizes: &Sizes,
  setup: &mut Option<metrics::CollectorId>,
) -> GitResult<Value> {
  let repo = text::join(root, "repo");
  let worktree_root = text::join(root, "worktrees");
  let setup_started = Instant::now();
  std::fs::create_dir_all(&repo).map_err(|error| io(&error, "mkdir", &repo))?;
  git(&["init", "-q", "-b", "main"], &repo)?;
  git(&["config", "user.name", "VCS Lab Scale Fixture"], &repo)?;
  git(&["config", "user.email", "vcs-lab-scale@example.invalid"], &repo)?;
  git(&["config", "core.autocrlf", "false"], &repo)?;
  let git_version = engine::git_version(&repo)?.raw;
  let empty_tree = git_with_input(&["mktree"], &repo, "")?.stdout;

  // The working tree, spread over several directories and carried by every
  // history commit. Every file is the same size, so materialized bytes are a
  // function of the file count and stay comparable between hosts.
  let content = format!("{}\n", "x".repeat(1024));
  for area in 0..sizes.areas {
    let directory = text::join(&repo, &format!("area{area:03}"));
    std::fs::create_dir_all(&directory).map_err(|error| io(&error, "mkdir", &directory))?;
    for file in 0..sizes.files_per_area {
      let path = text::join(&directory, &format!("f{file:04}.txt"));
      std::fs::write(&path, &content).map_err(|error| io(&error, "open", &path))?;
    }
  }
  git(&["add", "-A"], &repo)?;
  let content_tree = git(&["write-tree"], &repo)?.stdout;
  let mut commits: Vec<String> = Vec::new();
  for index in 0..sizes.history {
    let commit = create_commit(
      &repo,
      &content_tree,
      commits.last().map(String::as_str),
      &format!("Scale history {}", index + 1),
      index,
    )?;
    commits.push(commit);
  }
  let tip = commits.last().cloned().unwrap_or_default();
  git(&["update-ref", "refs/heads/main", &tip], &repo)?;
  git(&["reset", "--hard", "main"], &repo)?;

  let base_commit = commits.first().cloned().unwrap_or_default();
  for index in 0..sizes.notes {
    let target = match commits.get(index) {
      Some(commit) => commit.clone(),
      None => create_commit(
        &repo,
        &empty_tree,
        Some(&base_commit),
        &format!("Detached note target {}", index + 1),
        sizes.history + index,
      )?,
    };
    let mut record = Object::new();
    record.set("schema", string("causet.application/v1"));
    record.set("type", string("application"));
    record.set("id", string(&format!("scale_application_{index:06}")));
    record.set("originCommit", string(&base_commit));
    record.set("originChangeId", string(&format!("scale_origin_{index:06}")));
    record.set("appliedCommit", string(&target));
    record.set("appliedChangeId", string(&format!("scale_applied_{index:06}")));
    record.set("targetBefore", string(&base_commit));
    record.set("relation", string("scale-fixture"));
    record.set(
      "createdAt",
      string(&fixed_git_date(sizes.history + sizes.notes + index)),
    );
    append_note(&target, &Value::Object(record), &repo, &[])?;
  }

  let hash = |input: &str| -> GitResult<String> {
    Ok(git_with_input(&["hash-object", "-w", "--stdin"], &repo, input)?.stdout)
  };
  let base_blob = hash("base\n")?;
  let ours_blob = hash("ours\n")?;
  let result_blob = hash("resolved\n")?;
  for index in 0..sizes.resolutions {
    let theirs_blob = hash(&format!("theirs {index}\n"))?;
    let stage = |blob: &str| {
      let mut stage = Object::new();
      stage.set("mode", string("100644"));
      stage.set("blob", string(blob));
      Value::Object(stage)
    };
    let mut outcome = Object::new();
    outcome.set("base", stage(&base_blob));
    outcome.set("ours", stage(&ours_blob));
    outcome.set("theirs", stage(&theirs_blob));
    let signature = causet_model::schemas::resolution_signature(Some(&Value::Object(outcome.clone())))
      .map_err(|_| GitError::new("internal-invariant", "The scale fixture could not sign a resolution."))?;
    outcome.set("signature", string(&signature));
    outcome.set("algorithm", string(RESOLUTION_SIGNATURE_ALGORITHM));
    outcome.set("path", string(&format!("scale-{index:06}.txt")));
    outcome.set("resultBlob", string(&result_blob));
    outcome.set("resultMode", string("100644"));
    outcome.set("decision", string("created"));
    let mut application = Object::new();
    application.set("id", string(&format!("scale_resolution_application_{index:06}")));
    application.set("appliedCommit", string(&tip));
    application.set(
      "appliedChangeId",
      string(&format!("scale_resolution_change_{index:06}")),
    );
    publish_resolution(&Value::Object(outcome), &Value::Object(application), &repo)?;
  }

  for index in 0..sizes.workspaces {
    let name = format!("scale-{index:03}");
    let path = text::join(&worktree_root, &name);
    create_workspace(
      &name,
      &CreateOptions {
        from: Some("main"),
        path: Some(&path),
        owner: Some("scale-fixture"),
        focus: Some("status-scan"),
        cone: None,
      },
      &repo,
    )?;
  }

  let Some(collector) = setup.take() else {
    return Err(GitError::new(
      "internal-invariant",
      "The scale benchmark's setup was measured twice.",
    ));
  };
  let setup_git = metrics::end(collector);
  let setup_duration = rounded(elapsed(setup_started), 2);
  let fixture_sizes = Fixture {
    workspaces: sizes.workspaces,
    resolutions: sizes.resolutions,
    note_targets: sizes.notes + sizes.resolutions,
  };
  let mut fixture = Object::new();
  fixture.set(
    "profile",
    string(if sizes.custom { "custom-v1" } else { "representative-local-v1" }),
  );
  fixture.set("historyDepth", count(sizes.history));
  fixture.set("workspaces", count(sizes.workspaces));
  fixture.set("causalNotes", count(sizes.notes));
  fixture.set("resolutions", count(sizes.resolutions));
  fixture.set("totalNoteTargets", count(fixture_sizes.note_targets));
  fixture.set("totalNoteRecords", count(fixture_sizes.note_targets));
  fixture.set("areas", count(sizes.areas));
  fixture.set("filesPerArea", count(sizes.files_per_area));
  fixture.set("treeFiles", count(sizes.areas * sizes.files_per_area));

  let mut created_full: Vec<String> = Vec::new();
  let mut created_cone: Vec<String> = Vec::new();
  // Captured before any phase runs, so the status floor measures the same
  // worktrees the status phase does.
  let status_worktrees = linked_worktree_paths(&repo)?;
  let single = |name: &str, value: Value| {
    let mut result = Object::new();
    result.set(name, value);
    Ok(Value::Object(result))
  };
  let samples = sizes.samples;
  let mut measurements = Object::new();
  measurements.set(
    "history",
    Value::Object(measure_phase("history", samples, || {
      single("commits", Value::Number(engine::count_commits("refs/heads/main", &repo)?))
    })?),
  );
  measurements.set(
    "gitWorktrees",
    Value::Object(measure_phase("git-worktrees", samples, || {
      single("worktrees", count(engine::list_worktrees(&repo)?.len()))
    })?),
  );
  measurements.set(
    "workspaceRegistry",
    Value::Object(measure_phase("workspace-registry", samples, || {
      let registry = read_workspaces(&repo)?;
      let registered = match registry.get("workspaces") {
        Some(Value::Array(workspaces)) => workspaces.len(),
        _ => 0,
      };
      single("workspaces", count(registered))
    })?),
  );
  measurements.set(
    "workspaceStatus",
    Value::Object(measure_phase("workspace-status", samples, || {
      let listed = list_workspaces(&repo)?;
      let workspaces = match &listed {
        Value::Array(workspaces) => workspaces.as_slice(),
        _ => &[],
      };
      let mut result = Object::new();
      result.set("workspaces", count(workspaces.len()));
      result.set(
        "active",
        count(
          workspaces
            .iter()
            .filter(|workspace| js_text(get(Some(workspace), "status")) == "active")
            .count(),
        ),
      );
      result.set(
        "dirty",
        count(
          workspaces
            .iter()
            .filter(|workspace| matches!(get(Some(workspace), "dirtyFiles"), Some(Value::Number(files)) if *files > 0.0))
            .count(),
        ),
      );
      Ok(Value::Object(result))
    })?),
  );
  measurements.set(
    "noteCatalog",
    Value::Object(measure_phase("note-catalog", samples, || {
      single("records", count(crate::notes::list_note_records(&repo)?.len()))
    })?),
  );
  measurements.set(
    "resolutionCatalog",
    Value::Object(measure_phase("resolution-catalog", samples, || {
      single(
        "resolutions",
        count(crate::resolve::list_resolution_records(&repo)?.len()),
      )
    })?),
  );
  measurements.set(
    "metadataStatus",
    Value::Object(measure_phase("metadata-status", samples, || {
      let status = crate::metadata::metadata_report(&repo, crate::metadata::METADATA_STATUS_SCHEMA)?;
      let summary = get(Some(&status), "summary");
      let scopes = get(Some(&status), "scopes");
      let portable = get(scopes, "sharedPortable");
      let mut result = Object::new();
      for (name, value) in [
        ("valid", get(summary, "valid")),
        ("acceptedPortableRecords", get(summary, "acceptedPortableRecords")),
        ("noteTargets", get(get(portable, "notes"), "targetCount")),
        ("resolutionRefs", get(get(portable, "resolutions"), "refCount")),
        (
          "registeredWorkspaces",
          get(get(get(scopes, "sharedLocal"), "workspaceRegistry"), "count"),
        ),
        (
          "materializedWorktrees",
          get(get(scopes, "worktreePrivate"), "worktreeCount"),
        ),
      ] {
        if let Some(value) = value {
          result.set(name, value.clone());
        }
      }
      Ok(Value::Object(result))
    })?),
  );
  let plain = |cone: Option<&'static str>| CreateOptions {
    from: Some("main"),
    path: None,
    owner: None,
    focus: None,
    cone,
  };
  measurements.set(
    "workspaceCreate",
    Value::Object(measure_phase("workspace-create", samples, || {
      let path = text::join(&worktree_root, &format!("create-{}", created_full.len()));
      create_workspace(
        &format!("scale-create-{}", created_full.len()),
        &CreateOptions { path: Some(&path), ..plain(None) },
        &repo,
      )?;
      created_full.push(path);
      single("created", count(1))
    })?),
  );
  measurements.set(
    "workspaceCreateCone",
    Value::Object(measure_phase("workspace-create-cone", samples, || {
      let path = text::join(&worktree_root, &format!("cone-{}", created_cone.len()));
      create_workspace(
        &format!("scale-cone-{}", created_cone.len()),
        &CreateOptions { path: Some(&path), ..plain(Some("area000")) },
        &repo,
      )?;
      created_cone.push(path);
      single("created", count(1))
    })?),
  );

  // Denominators last, so no phase measurement above is disturbed by the
  // worktrees the creation floors add (issue #42).
  let mut floor_context = FloorContext {
    worktree_root: worktree_root.clone(),
    status_worktrees,
    sequence: 0,
  };
  for name in measurements.keys().into_iter().cloned().collect::<Vec<_>>() {
    let label = causet_model::json::lossy(&name);
    let floor = measure_floor(&label, samples, &repo, &mut floor_context)?;
    if let Some(Value::Object(measurement)) = measurements.get_units(&name).cloned() {
      let mut measurement = measurement;
      measurement.set("floor", floor);
      measurements.insert(name, Value::Object(measurement));
    }
  }

  let mut materialization = Object::new();
  materialization.set("full", materialized_tree(created_full.first())?);
  materialization.set("cone", materialized_tree(created_cone.first())?);

  // Which implementation answered, and its runtime: the Rust CLI has no
  // Node.js to name (ADR-0037 §5).
  let mut environment = Object::new();
  // `process.platform`.
  let platform = if cfg!(windows) {
    "win32"
  } else if cfg!(target_os = "macos") {
    "darwin"
  } else {
    "linux"
  };
  environment.set("platform", string(platform));
  environment.set("implementation", string("rust"));
  environment.set("node", Value::Null);
  environment.set("git", string(&git_version));
  let mut documentation = Object::new();
  documentation.set("companionSchema", string("causet.spec-benchmark/v3"));
  documentation.set(
    "command",
    string("cst spec benchmark --documents <n> --blocks <n> --json"),
  );
  let mut coverage = Object::new();
  for name in [
    "historyDepth",
    "worktreeAndRegistryVolume",
    "causalNoteVolume",
    "resolutionVolume",
  ] {
    coverage.set(name, Value::Bool(true));
  }
  coverage.set("documentationVolume", Value::Object(documentation));
  let expected_failures = sizes.notes + sizes.resolutions * 2 + sizes.workspaces;
  let mut setup_report = Object::new();
  setup_report.set("durationMs", setup_duration);
  setup_report.set("git", setup_git.to_value());
  setup_report.set("expectedAbsentProbeFailures", count(expected_failures));
  setup_report.set(
    "unexpectedGitFailures",
    count((setup_git.failed as usize).saturating_sub(expected_failures)),
  );
  let analysis = build_analysis(&measurements, &fixture_sizes, sizes.budget);
  let mut privacy = Object::new();
  for name in [
    "repositoryPathsIncluded",
    "objectIdsIncluded",
    "fileContentsIncluded",
    "commitMessagesIncluded",
  ] {
    privacy.set(name, Value::Bool(false));
  }
  let mut cleanup = Object::new();
  cleanup.set("temporaryFixtureRemoved", Value::Bool(true));
  let mut report = Object::new();
  report.set("schema", string(SCHEMA));
  report.set("environment", Value::Object(environment));
  report.set("fixture", Value::Object(fixture));
  report.set("coverage", Value::Object(coverage));
  report.set("samples", count(samples));
  report.set("setup", Value::Object(setup_report));
  report.set("measurements", Value::Object(measurements));
  report.set("materialization", Value::Object(materialization));
  report.set("analysis", analysis);
  report.set("privacy", Value::Object(privacy));
  report.set("cleanup", Value::Object(cleanup));
  Ok(Value::Object(report))
}

/// `formatScaleBenchmark(result)`.
pub fn format_scale_benchmark(result: &Value) -> String {
  let member = |name: &str| get(Some(result), name);
  let fixture = member("fixture");
  let analysis = member("analysis");
  let setup = member("setup");
  let fixed = |value: Option<&Value>| match value {
    Some(Value::Number(number)) => to_fixed(*number, 2),
    other => js_text(other),
  };
  let mut lines = vec![
    "Repository scale benchmark".to_string(),
    format!(
      "fixture      {} history, {} workspaces, {} causal notes, {} resolutions",
      js_text(get(fixture, "historyDepth")),
      js_text(get(fixture, "workspaces")),
      js_text(get(fixture, "causalNotes")),
      js_text(get(fixture, "resolutions"))
    ),
    format!(
      "samples      {}; interactive budget {} ms",
      js_text(member("samples")),
      js_text(get(analysis, "interactiveBudgetMs"))
    ),
    format!(
      "setup        {} ms; {} Git processes",
      js_text(get(setup, "durationMs")),
      js_text(get(get(setup, "git"), "processes"))
    ),
    String::new(),
  ];
  if let Some(Value::Object(measurements)) = member("measurements") {
    for name in measurements.keys() {
      let measurement = measurements.get_units(name);
      lines.push(format!(
        "{:<18} {} ms median ({} cold); {} Git processes",
        causet_model::json::lossy(name),
        fixed(get(measurement, "medianMs")),
        fixed(get(measurement, "coldMs")),
        js_text(get(measurement, "medianProcesses"))
      ));
    }
  }
  let now = |name: &str| {
    let entry = get(analysis, name);
    format!(
      "{} — {}",
      if truthy(get(entry, "recommendedNow")) { "yes" } else { "no" },
      js_text(get(entry, "reason"))
    )
  };
  lines.push(String::new());
  lines.push(format!("next action  {}", js_text(get(analysis, "nextAction"))));
  lines.push(format!("index now    {}", now("persistentIndex")));
  lines.push(format!("service now  {}", now("residentService")));
  if let Some(Value::Array(recommendations)) = get(analysis, "recommendations") {
    if !recommendations.is_empty() {
      lines.push(String::new());
      lines.push("Recommendations".to_string());
      for recommendation in recommendations {
        lines.push(format!(
          "- {}: {} ({})",
          js_text(get(Some(recommendation), "area")),
          js_text(get(Some(recommendation), "action")),
          js_text(get(Some(recommendation), "evidence"))
        ));
      }
    }
  }
  lines.join("\n")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fixture_dates_are_seconds_into_the_year_2000() {
    assert_eq!(fixed_git_date(0), "2000-01-01T00:00:00.000Z");
    assert_eq!(fixed_git_date(86_399), "2000-01-01T23:59:59.000Z");
    assert_eq!(fixed_git_date(59 * 86_400), "2000-02-29T00:00:00.000Z");
    assert_eq!(fixed_git_date(366 * 86_400 + 61), "2001-01-01T00:01:01.000Z");
  }

  #[test]
  fn percentiles_take_the_nearest_rank() {
    assert_eq!(percentile(&[3.0, 1.0, 2.0], 0.5), 2.0);
    assert_eq!(percentile(&[3.0, 1.0, 2.0], 0.95), 3.0);
    assert_eq!(percentile(&[5.0], 0.5), 5.0);
  }
}
