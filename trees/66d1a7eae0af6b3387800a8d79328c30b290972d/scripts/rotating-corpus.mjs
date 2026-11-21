/**
 * The rotating generated-history corpus (#336,
 * `.github/workflows/rotating-corpus.yml`): each week a new seed's 1,000
 * histories, checked like `corpora.yml`'s fixed `causet-n1`, but never
 * gating anything. A failure opens one `needs-triage` issue per seed, or
 * comments on the seed's issue, reopening it if it was closed.
 *
 * `node scripts/rotating-corpus.mjs seed` prints the run's seed, the
 * `SEED_INPUT` environment variable or the current ISO week's, and writes it
 * to `GITHUB_OUTPUT` as `seed`.
 *
 * `node scripts/rotating-corpus.mjs file <directory>` files the issue of a
 * failed run. The directory holds one directory per host, `outcome-<os>` as
 * the run's artifacts download, each with the host's `outcome.json`
 * (`{ os, status }`) and, when the corpus test got as far as writing it,
 * `report.json` (`corpusReport` of `test-support/generated-histories.js`).
 * It reads `SEED`, `RUN_URL` and `GITHUB_REPOSITORY`, and runs `gh` with
 * `GH_TOKEN`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The hosts the workflow checks the corpus on: its `generated` job's matrix.
 * A host listed here whose job left no outcome is reported as such.
 */
export const HOSTS = ["ubuntu-latest", "windows-latest"];

const TITLE = "Generated-history corpus fails on seed ";
/** What one problem may take of the issue. */
const PROBLEM_LIMIT = 2_000;
/** GitHub refuses a body over 65,536 characters; this leaves room for the rest. */
const BODY_LIMIT = 55_000;

/** `weekly-<ISO year>-W<ISO week>` of `date`, in UTC. */
export function weekSeed(date) {
  // The ISO week's year is the year of its Thursday.
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
  const year = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * 86_400_000));
  return `weekly-${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * The run's seed: a dispatch's input, or the week's when there is none. The
 * seed is written into a shell command and an issue title, so it is limited
 * to letters, digits, `.`, `_` and `-`.
 */
export function chooseSeed(input, now = new Date()) {
  const given = (input ?? "").trim();
  if (given === "") return weekSeed(now);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(given)) {
    throw new Error(`the seed must be 1 to 100 letters, digits, '.', '_' or '-', not ${JSON.stringify(given)}`);
  }
  return given;
}

/** The command that checks history `index` of `seed` alone. */
function reproduce(seed, index) {
  return `CAUSET_GENERATED_SEED=${seed} CAUSET_GENERATED_ONLY=${index} node --test test/generated-histories.test.js`;
}

/** `text` in a fenced block no run of backticks inside it can close. */
function fenced(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** `text`, cut short to `PROBLEM_LIMIT` characters with a note of the rest. */
function shortened(text) {
  return text.length <= PROBLEM_LIMIT ? text : `${text.slice(0, PROBLEM_LIMIT)}\n… (${text.length - PROBLEM_LIMIT} more characters)`;
}

/** Why a failed host lists no failing history. */
function whyNoFailingHistory({ status, report }) {
  if (status !== "failure" && status !== "success") return `the job ended ${status ?? "with no outcome"}`;
  if (!report) return "no report: it failed before its histories were checked (the build, a shard that crashed, or the timeout)";
  return "no history failed: another test of the suite did";
}

/**
 * The issue a run's outcome files: `{ title, body }`, or null when every
 * host passed. `hosts` is `[{ os, status, report }]`, `status` being the
 * host job's (`success`, `failure`, `cancelled`), and `report` its
 * `corpusReport` or null.
 */
export function failureIssue({ seed, runUrl, hosts }) {
  const failed = hosts.filter((host) => host.status !== "success" || (host.report?.failures.length ?? 0) > 0);
  if (failed.length === 0) return null;
  const head = [
    `The rotating generated-history corpus (\`.github/workflows/rotating-corpus.yml\`) failed on seed \`${seed}\`.`,
    "",
    `Run: ${runUrl}`,
    "",
    "Each failing history reproduces alone with its command. Triage decides whether it becomes a fixed",
    "regression case or a fix (docs/testing.md, \"The generated-history corpus\").",
    "",
  ];
  const sections = [];
  let omitted = 0;
  let length = head.join("\n").length;
  for (const host of failed) {
    const failures = host.report?.failures ?? [];
    const lines = [`## ${host.os}`, ""];
    if (failures.length === 0) lines.push(`${host.os}: ${whyNoFailingHistory(host)}.`, "");
    else lines.push(`${failures.length} of ${host.report.checked} histories checked failed.`, "");
    sections.push(lines.join("\n"));
    length += sections.at(-1).length;
    for (const failure of failures) {
      const entry = [
        `### History ${failure.index} (${failure.format}, ${failure.refStorage}${failure.cases.length ? `: ${failure.cases.join(", ")}` : ""})`,
        "",
        fenced(reproduce(seed, failure.index)),
        "",
        fenced(failure.problems.map(shortened).join("\n\n")),
        "",
      ].join("\n");
      if (length + entry.length > BODY_LIMIT) {
        omitted++;
        continue;
      }
      sections.push(entry);
      length += entry.length;
    }
  }
  if (omitted > 0) sections.push(`${omitted} more failing histories are in the run's logs.\n`);
  return { title: `${TITLE}${seed}`, body: [...head, ...sections].join("\n") };
}

/**
 * Opens the issue, or comments on the seed's issue, the most recent of the
 * same title, and reopens it if triage had closed it. `gh` runs the GitHub
 * CLI with its arguments and standard input, and returns its standard output.
 */
export function fileIssue({ repository, issue, gh }) {
  const listed = JSON.parse(gh([
    "issue", "list", "--repo", repository, "--state", "all", "--search", `"${issue.title}" in:title`,
    "--limit", "100", "--json", "number,title,state",
  ]));
  const seedIssue = listed.filter((each) => each.title === issue.title)
    .reduce((latest, each) => (latest && latest.number > each.number ? latest : each), null);
  if (seedIssue) {
    const number = String(seedIssue.number);
    gh(["issue", "comment", number, "--repo", repository, "--body-file", "-"], issue.body);
    if (seedIssue.state === "OPEN") return { action: "updated", number: seedIssue.number };
    gh(["issue", "reopen", number, "--repo", repository]);
    return { action: "reopened", number: seedIssue.number };
  }
  const url = gh([
    "issue", "create", "--repo", repository, "--title", issue.title, "--label", "needs-triage", "--body-file", "-",
  ], issue.body).trim();
  return { action: "opened", url };
}

/** The outcome of each host, as its job left it under `directory`. */
function readHosts(directory) {
  const read = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
  return HOSTS.map((os) => {
    const outcome = read(path.join(directory, `outcome-${os}`, "outcome.json"));
    return { os, status: outcome?.status ?? null, report: read(path.join(directory, `outcome-${os}`, "report.json")) };
  });
}

function summarize(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  console.log(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, directory] = process.argv.slice(2);
  if (command === "seed") {
    const seed = chooseSeed(process.env.SEED_INPUT);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `seed=${seed}\n`);
    summarize(`Seed: \`${seed}\``);
  } else if (command === "file" && directory) {
    // The seed job's seed, never one chosen again here.
    if (!process.env.SEED) throw new Error("SEED must name the run's seed");
    const seed = chooseSeed(process.env.SEED);
    const issue = failureIssue({ seed, runUrl: process.env.RUN_URL, hosts: readHosts(directory) });
    if (!issue) {
      summarize("Every host passed; no issue filed.");
    } else {
      const gh = (args, input) => execFileSync("gh", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
      const result = fileIssue({ repository: process.env.GITHUB_REPOSITORY, issue, gh });
      summarize(result.action === "opened" ? `Opened ${result.url}`
        : `Commented on #${result.number}${result.action === "reopened" ? " and reopened it" : ""}`);
    }
  } else {
    console.error("usage: rotating-corpus.mjs seed | file <directory>");
    process.exit(2);
  }
}
