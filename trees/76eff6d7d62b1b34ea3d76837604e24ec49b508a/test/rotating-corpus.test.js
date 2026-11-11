import assert from "node:assert/strict";
import test from "node:test";
import { chooseSeed, failureIssue, fileIssue, weekSeed } from "../scripts/rotating-corpus.mjs";
import { corpusReport } from "../test-support/generated-histories.js";

test("the week's seed is its ISO week, so every run in one week uses the same seed", () => {
  assert.equal(weekSeed(new Date("2026-10-29T12:00:00Z")), "weekly-2026-W44");
  // Monday 00:00 starts a week and Sunday 23:59 ends it.
  assert.equal(weekSeed(new Date("2026-11-09T00:00:00Z")), "weekly-2026-W46");
  assert.equal(weekSeed(new Date("2026-11-15T23:59:59Z")), "weekly-2026-W46");
  assert.equal(weekSeed(new Date("2026-11-16T00:00:00Z")), "weekly-2026-W47");
  // An ISO week's year is the year of its Thursday.
  assert.equal(weekSeed(new Date("2027-01-01T08:00:00Z")), "weekly-2026-W53");
  assert.equal(weekSeed(new Date("2024-12-30T08:00:00Z")), "weekly-2025-W01");
  assert.equal(weekSeed(new Date("2021-01-03T08:00:00Z")), "weekly-2020-W53");
});

test("a dispatch's seed input is taken as given, and an empty one is the week's", () => {
  const now = new Date("2026-11-09T10:00:00Z");
  assert.equal(chooseSeed("", now), "weekly-2026-W46");
  assert.equal(chooseSeed("  ", now), "weekly-2026-W46");
  assert.equal(chooseSeed(undefined, now), "weekly-2026-W46");
  assert.equal(chooseSeed("weekly-2026-W44", now), "weekly-2026-W44");
  assert.equal(chooseSeed("causet-n1.v2_a", now), "causet-n1.v2_a");
  // The seed lands in a shell command and an issue title.
  for (const bad of ["a b", "x;rm", "$(id)", "`id`", "a\nb", "-".repeat(101)]) {
    assert.throws(() => chooseSeed(bad, now), /seed/, JSON.stringify(bad));
  }
});

test("a corpus report holds the seed, the count and each failing history", () => {
  const results = [
    { index: 0, format: "sha1", refStorage: "files", cases: ["merges"], problems: [] },
    { index: 1, format: "sha256", refStorage: "reftable", cases: ["renames"], problems: ["a", "b"] },
    { index: 2, format: "sha1", refStorage: "reftable", cases: [], problems: [], skipped: "old Git" },
  ];
  assert.deepEqual(corpusReport(results, { seed: "s", histories: 3 }), {
    seed: "s",
    histories: 3,
    checked: 2,
    skipped: 1,
    failures: [{ index: 1, format: "sha256", refStorage: "reftable", cases: ["renames"], problems: ["a", "b"] }],
  });
});

const RUN = "https://github.com/jwh3times/causet/actions/runs/42";
const failing = (index, problems = [`history ${index} differs`]) =>
  ({ index, format: "sha1", refStorage: "files", cases: ["merges"], problems });

test("a passing run files nothing", () => {
  const hosts = ["ubuntu-latest", "windows-latest"].map((os) => ({
    os, status: "success", report: { seed: "s", histories: 1000, checked: 1000, skipped: 0, failures: [] },
  }));
  assert.equal(failureIssue({ seed: "s", runUrl: RUN, hosts }), null);
});

test("a failing history becomes an issue naming the seed, the host, the index, its reproduce command and the run", () => {
  const issue = failureIssue({
    seed: "weekly-2026-W46",
    runUrl: RUN,
    hosts: [
      { os: "ubuntu-latest", status: "success", report: { seed: "weekly-2026-W46", histories: 1000, checked: 1000, skipped: 0, failures: [] } },
      {
        os: "windows-latest",
        status: "failure",
        report: { seed: "weekly-2026-W46", histories: 1000, checked: 1000, skipped: 0, failures: [failing(17), failing(503)] },
      },
    ],
  });
  assert.equal(issue.title, "Generated-history corpus fails on seed weekly-2026-W46");
  assert.match(issue.body, /weekly-2026-W46/);
  assert.ok(issue.body.includes(RUN));
  assert.match(issue.body, /windows-latest/);
  assert.doesNotMatch(issue.body, /ubuntu-latest/);
  for (const index of [17, 503]) {
    assert.ok(issue.body.includes(
      `CAUSET_GENERATED_SEED=weekly-2026-W46 CAUSET_GENERATED_ONLY=${index} node --test test/generated-histories.test.js`,
    ), `reproduce ${index}`);
    assert.ok(issue.body.includes(`history ${index} differs`));
  }
});

test("a host that failed outside a history check is named with the reason it gave none", () => {
  const issue = failureIssue({
    seed: "s",
    runUrl: RUN,
    hosts: [
      { os: "ubuntu-latest", status: "failure", report: null },
      { os: "windows-latest", status: "failure", report: { seed: "s", histories: 1000, checked: 1000, skipped: 0, failures: [] } },
      { os: "macos-latest", status: "cancelled", report: null },
    ],
  });
  assert.match(issue.body, /ubuntu-latest[^\n]*no report/);
  assert.match(issue.body, /windows-latest[^\n]*no history failed/);
  assert.match(issue.body, /macos-latest[^\n]*cancelled/);
});

test("a long problem is cut short, and the body stays within GitHub's limit", () => {
  const huge = "x".repeat(200_000);
  const issue = failureIssue({
    seed: "s",
    runUrl: RUN,
    hosts: [{
      os: "ubuntu-latest",
      status: "failure",
      report: { seed: "s", histories: 1000, checked: 1000, skipped: 0, failures: Array.from({ length: 300 }, (_, i) => failing(i, [huge, "```"])) },
    }],
  });
  assert.ok(issue.body.length <= 60_000, String(issue.body.length));
  assert.ok(issue.body.includes(RUN));
  assert.match(issue.body, /more failing histories/);
  // A problem's backticks cannot close the block that holds it: its fence is
  // longer than any run of backticks inside.
  assert.match(issue.body, /^````\n/m);
});

/** A `gh` stand-in that records its calls and answers the listing. */
function fakeGh(listed) {
  const calls = [];
  const gh = (args, input) => {
    calls.push({ args, input });
    if (args[0] === "issue" && args[1] === "list") {
      assert.deepEqual(args.slice(args.indexOf("--state"), args.indexOf("--state") + 2), ["--state", "all"]);
      return JSON.stringify(listed);
    }
    if (args[0] === "issue" && args[1] === "create") return "https://github.com/o/r/issues/9\n";
    return "";
  };
  return { gh, calls };
}

test("the first failure of a seed opens a needs-triage issue", () => {
  const { gh, calls } = fakeGh([{ number: 3, title: "Generated-history corpus fails on seed other", state: "OPEN" }]);
  const result = fileIssue({ repository: "o/r", issue: { title: "Generated-history corpus fails on seed s", body: "B" }, gh });
  assert.equal(result.action, "opened");
  const create = calls.find((call) => call.args[1] === "create");
  assert.deepEqual(create.args, [
    "issue", "create", "--repo", "o/r", "--title", "Generated-history corpus fails on seed s",
    "--label", "needs-triage", "--body-file", "-",
  ]);
  assert.equal(create.input, "B");
});

test("a later failure of the same seed comments on its open issue instead of opening another", () => {
  const { gh, calls } = fakeGh([
    { number: 7, title: "Generated-history corpus fails on seed s-2", state: "OPEN" },
    { number: 8, title: "Generated-history corpus fails on seed s", state: "OPEN" },
  ]);
  const result = fileIssue({ repository: "o/r", issue: { title: "Generated-history corpus fails on seed s", body: "B" }, gh });
  assert.deepEqual(result, { action: "updated", number: 8 });
  assert.equal(calls.some((call) => call.args[1] === "create" || call.args[1] === "reopen"), false);
  const comment = calls.find((call) => call.args[1] === "comment");
  assert.deepEqual(comment.args, ["issue", "comment", "8", "--repo", "o/r", "--body-file", "-"]);
  assert.equal(comment.input, "B");
});

test("a failure of a seed whose issue was closed reopens that issue with the new failure", () => {
  const { gh, calls } = fakeGh([
    { number: 4, title: "Generated-history corpus fails on seed s", state: "CLOSED" },
    { number: 11, title: "Generated-history corpus fails on seed s", state: "CLOSED" },
  ]);
  const result = fileIssue({ repository: "o/r", issue: { title: "Generated-history corpus fails on seed s", body: "B" }, gh });
  // The most recent issue of the title is the seed's.
  assert.deepEqual(result, { action: "reopened", number: 11 });
  assert.equal(calls.some((call) => call.args[1] === "create"), false);
  assert.deepEqual(calls.filter((call) => call.args[1] !== "list").map((call) => call.args.slice(0, 3)),
    [["issue", "comment", "11"], ["issue", "reopen", "11"]]);
});
