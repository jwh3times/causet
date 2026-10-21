/**
 * The invocations `test/native-cli.test.js` runs outside any repository, in
 * groups. Until #243 each ran through both CLIs and had to agree byte for
 * byte; the JavaScript CLI's results for exactly these cases are frozen in
 * `test/fixtures/oracle/native-cli.json`, normalized by `frozenForm`. Any
 * change here invalidates those answers.
 *
 * A case is `{ args, env }`; `env` is laid over the neutral selectors, and an
 * `undefined` member removes a variable from the spawned environment.
 */

const valueFlags = [
  "--message", "-m", "--from", "--path", "--owner", "--focus", "--cone", "--against",
  "--anchors-from", "--label", "--reason", "--resolution", "--use-forecast", "--samples",
  "--warmup", "--documents", "--blocks", "--history", "--workspaces", "--notes",
  "--resolutions", "--budget-ms", "--areas", "--files-per-area",
  "--authored-by", "--generated-by", "--reviewed-by", "--reword", "--edit", "--squash", "--fixup",
];

// Each command's argument-only refusals, in the order the front end checks them.
const usageFailures = [
  ["commit"], ["commit", "-m", ""], ["commit", "--all"],
  ["branch"], ["branch", ""],
  ["merge"], ["merge", "--compact"], ["compact-merge"], ["hard-squash", "-m", "x"],
  ["proof-bundle"], ["verify-proof", "--offline"], ["merge-plan"],
  ["rebase-plan"], ["rebase-plan", "a", "b", "c"], ["rebase-plan", "", "b", "c"],
  ["rebase-forecast"], ["rebase-forecast", "a", "b", "c"],
  ["rebase"], ["rebase", "a", "b"], ["rebase", "--status", "--continue"],
  ["rebase", "--continue", "--abort", "--status", "x"],
  ["forecast"], ["reconcile"], ["reconcile", "--status", "--abort"],
  ["resolve", "bogus"], ["resolve", ""],
  ["cherry-pick"], ["cherry-pick", "--fork"],
  ["audit"], ["audit", "bogus"],
  ["metadata"], ["metadata", "bogus"], ["metadata", "export"], ["metadata", "import", "--apply"],
  ["metadata", "dispose"], ["metadata", "dispose", "r"],
  ["metadata", "dispose", "r", "--keep-local", "--replace-local"],
  ["workspace"], ["workspace", "bogus"], ["workspace", "create"], ["workspace", "move"],
  ["workspace", "move", "n"], ["workspace", "archive"], ["workspace", "restore"],
  ["workspace", "repair"], ["workspace", "repair", "n"], ["workspace", "repair", "n", "--path", ""],
  ["workspace", "forecast"], ["workspace", "forecast", "t"],
  ["spec"], ["spec", "bogus"], ["spec", "index"], ["spec", "show"],
  ["spec", "merge-plan", "f", "b", "o"],
  // A first word `cst` does not answer is Git's since ADR-0040 (#256), so
  // "no-such-command", "UPPER", "Commit" and the like left this list;
  // `test/git-passthrough.test.js` compares them with Git instead.
  ["--json"],
];

const plain = (args, env = {}) => ({ args, env });

// The former names are ignored, set alone or beside the new ones (ADR-0039 §8).
const unset = { CAUSET_ENGINE: undefined, CAUSET_FORECAST_ENGINE: undefined };

// Every benchmark case pins the session, whose processes the counts include,
// and keeps a budget no run exceeds, since which phases are over budget
// depends on how long they took.
const small = ["--history", "6", "--workspaces", "2", "--notes", "8", "--resolutions", "3", "--samples", "2",
  "--areas", "2", "--files-per-area", "3"];
const benchmark = (args) => ({ args, env: { CAUSET_GIT_SESSION: "1" } });

/** The case groups; `outside` is the directory every case runs in. */
export function cliGroups(outside) {
  return {
    help: [
      [], [""], ["help"], ["--help"], ["-h"], ["help", "extra"], ["--trace-git"],
      ["--engine=native", "help"], ["--git-session", "--help"],
      ["version"], ["--version"], ["-V"], ["--no-git-session", "version", "--json"],
      ["--forecast-engine", "worktree", "-V"],
    ].map((args) => plain(args)),
    globalFailures: [
      ...[
        ["--git-session", "--no-git-session"], ["--git-session", "commit", "--no-git-session", "--json"],
        ["--engine"], ["--engine="], ["--engine", "bogus", "commit", "--json"],
        ["--engine", "--trace-git"], ["--forecast-engine=x"], ["--forecast-engine"],
        ["commit", "-m", "--git-session", "--no-git-session"],
      ].map((args) => plain(args)),
      plain(["version"], { CAUSET_ENGINE: "bogus" }),
      plain(["help"], { CAUSET_FORECAST_ENGINE: "bogus", CAUSET_ENGINE: "bogus" }),
      plain(["--engine=git", "version"], { CAUSET_ENGINE: "bogus" }),
      plain(["--forecast-engine=merge-tree", "x"], { CAUSET_FORECAST_ENGINE: "bogus" }),
      plain(["version"], { ...unset, VLAB_ENGINE: "bogus" }),
      plain(["version"], { ...unset, VLAB_FORECAST_ENGINE: "bogus" }),
      plain(["version"], { ...unset, VLAB_ENGINE: "bogus", CAUSET_ENGINE: "git" }),
      plain(["version"], { ...unset, VLAB_ENGINE: "native", CAUSET_ENGINE: "bogus" }),
    ],
    valueFlags: valueFlags.map((flag) => plain(["commit", "--json", flag])),
    usage: usageFailures.flatMap((args) => [plain(args), plain([...args, "--json"])]),
    // A repeatable flag spelled in camel case first left `true` under its
    // key, and spreading that was a TypeError the JavaScript CLI printed as
    // prose, even with --json (#152). A camel-case value option is refused
    // by name since #262; these answers were re-recorded then.
    accident: [
      ["commit", "--authoredBy", "--authored-by", "a"],
      ["--trace-git", "commit", "--authoredBy", "--authored-by", "a"],
      ["commit", "--json", "--generatedBy", "--generated-by", "a"],
    ].map((args) => plain(args)),
    // Outside a repository: Git's refusal, the build-scoped document, and the
    // record readers' refusals.
    outsideRepository: [
      ["doctor"], ["doctor", "--json"], ["doctor", "--benchmark", "--samples", "0"],
      ["graph"], ["receipts", "--json"], ["provenance"], ["metadata", "status"], ["metadata", "validate", "--json"],
      ["audit", "identity"], ["resolve"], ["resolve", "list", "--json"], ["spec", "show", "x.md"], ["spec", "status"],
      ["merge-plan", "main"], ["rebase-plan", "main", "feature", "--json"],
      ["proof-bundle", "main"], ["verify-proof", "missing.json"],
    ].map((args) => plain(args)),
    capabilities: [
      ["capabilities"], ["capabilities", "--json"],
      ["capabilities", "--against", `${outside}/absent.json`, "--json"],
    ].map((args) => plain(args)),
    benchmarks: [
      ["spec", "benchmark", "--documents", "3", "--blocks", "4"],
      ["spec", "benchmark", "--documents", "1", "--blocks", "1", "--json"],
      ["spec", "benchmark", "--documents", "0"],
      ["spec", "benchmark", "--documents", "1000", "--blocks", "1000", "--json"],
      ["metadata", "benchmark", ...small, "--json"],
      ["metadata", "benchmark", ...small],
      ["metadata", "benchmark", "--history", "2", "--workspaces", "0", "--notes", "0", "--resolutions", "0",
        "--samples", "1", "--areas", "1", "--files-per-area", "1", "--budget-ms", "60000", "--json"],
      ["metadata", "benchmark", "--samples", "0"],
      ["metadata", "benchmark", "--notes", "5000", "--resolutions", "1", "--json"],
    ].map(benchmark),
  };
}

/**
 * Durations, and the Git activity lists ordered by them, differ run to run;
 * `environment` names the platform, the Git version and the implementation;
 * and the compressed sizes are estimates from each implementation's own zlib
 * (ADR-0037 §5).
 */
function steadyBenchmark(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return text
      .replace(/[\d.]+ ms/g, "<ms> ms")
      .replace(/\([\d.]+ cold\)/g, "(<ms> cold)");
  }
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.byCommand)) {
      node.byCommand.sort((left, right) => String(left.command).localeCompare(String(right.command)));
    }
    for (const [key, value] of Object.entries(node)) {
      if (/Ms$/.test(key) && (typeof value === "number" || value === null)) node[key] = "<ms>";
      else if (/^estimatedCompressed/.test(key)) node[key] = "<estimate>";
      else visit(value);
    }
  };
  visit(document);
  if (document?.environment) document.environment = "<environment>";
  return `${JSON.stringify(document, null, 2)}\n`;
}

// Git's refusal outside a repository depends on where the directory is
// mounted: "(or any of the parent directories): .git", or, when discovery
// stops at a filesystem boundary, "(or any parent up to mount point <path>)"
// and a second line saying so. Raw in stderr, or escaped inside JSON.
const NOT_A_REPOSITORY = /fatal: not a git repository \((?:or any of the parent directories\): \.git|or any parent up to mount point [^)\n"]*\))(?:(?:\n|\\n)Stopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.)?/g;

/**
 * A result as it is frozen: the package version, the directory the cases ran
 * in (in either separator), Git's wording of "not a git repository" and trace
 * timings are masked, and so is each group's own volatile part.
 */
export function frozenForm(result, { group, outside, version }) {
  // The directory as given, with forward slashes, and escaped inside JSON; a
  // path below it uses `/`, as the oracle's host wrote it.
  const forms = [outside.replaceAll("\\", "\\\\"), outside, outside.replaceAll("\\", "/")];
  const mask = (text) => forms
    .reduce((value, form) => value.replaceAll(form, "<outside>"), text ?? "")
    .replace(/<outside>[^\s"']*/g, (below) => below.replace(/\\\\|\\/g, "/"))
    .replaceAll(version, "<version>")
    .replace(NOT_A_REPOSITORY, "fatal: not a git repository <discovery>")
    .replace(/^(\[cst trace\]) [\d.]+ms /gm, "$1 <ms> ");
  let stdout = mask(result.stdout);
  if (group === "capabilities") stdout = stdout.replace(/\b[0-9a-f]{64}\b/g, "<sha256>");
  if (group === "benchmarks") stdout = steadyBenchmark(stdout);
  return { status: result.status, stdout, stderr: mask(result.stderr) };
}
