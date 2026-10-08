import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MODES = [
  "default", "session-on", "session-off", "forecast-worktree",
  "forecast-merge-tree", "engine-native",
];

function documentationOnly(file) {
  return ["README.md", "CHANGELOG.md", "AGENTS.md", "CLAUDE.md"].includes(file)
    || (file.startsWith("docs/") && file.endsWith(".md"))
    || ((file.startsWith(".agents/skills/") || file.startsWith(".claude/skills/"))
      && file.endsWith(".md"));
}

export function planCi(eventName, changedFiles) {
  if (eventName === "workflow_dispatch") {
    return {
      reason: "Explicit full qualification",
      include: [
        ...["ubuntu-latest", "windows-latest"].flatMap((os) =>
          MODES.map((mode) => ({ os, node: 24, mode }))),
        { os: "ubuntu-latest", node: 20, mode: "default" },
        { os: "ubuntu-latest", node: 20, mode: "session-on" },
      ],
    };
  }
  if (!["push", "pull_request"].includes(eventName)) {
    throw new Error(`Unsupported CI event: ${eventName}`);
  }
  // Only known documentation paths can omit the suite. Missing comparison
  // commits, empty diffs and new file types conservatively run it.
  if (changedFiles?.length && changedFiles.every(documentationOnly)) {
    return { reason: "Documentation-only change", include: [] };
  }
  return {
    reason: eventName === "pull_request" ? "Routine pull request" : "Main integration",
    include: (eventName === "pull_request"
      ? ["ubuntu-latest", "windows-latest"]
      : ["ubuntu-latest"]
    ).map((os) => ({ os, node: 24, mode: "default" })),
  };
}

export function changedPaths(eventName, event, cwd = process.cwd()) {
  const base = eventName === "pull_request" ? event.pull_request?.base?.sha : event.before;
  if (typeof base !== "string" || !/^[a-f0-9]{40,64}$/.test(base) || /^0+$/.test(base)) {
    return null;
  }
  try {
    // HEAD is the checked-out PR merge commit or pushed commit. Disable rename
    // detection so both a removed code path and its new doc path are considered.
    return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, "HEAD", "--"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const plan = planCi(eventName, eventName === "workflow_dispatch" ? null : changedPaths(eventName, event));
  fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `run-suite=${plan.include.length > 0}\nmatrix=${JSON.stringify({ include: plan.include })}\n`);
  console.log(`${plan.reason}: ${plan.include.length} suite jobs`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `CI selection: **${plan.reason}** (${plan.include.length} suite jobs).\n`);
  }
}
