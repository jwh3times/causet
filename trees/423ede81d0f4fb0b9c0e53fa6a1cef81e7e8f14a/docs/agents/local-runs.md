# Local runs

How to run the suites, demos and measurements on a development machine without corrupting their
results or this checkout. `docs/testing.md` says which modes a change needs; this file says how to
run them.

## Never in this checkout

This repository dogfoods `cst`: its notes and retention refs are published data
([workspace](workspace.md#never-remove-paths)). Check what a command does in a disposable
repository under the OS temporary directory, never here. A command that initializes causet state
writes `notes.displayRef` and `notes.rewriteRef` into `.git/config` and creates `.git/causet/`,
including commands that only look like reads; the end-session cleanup in [workspace](workspace.md)
lists what to look for.

Independent reviews follow the same rule: give the reviewer a disposable repository, never this one.

## Catching up on a machine

The owner works on two machines. When work resumes on one after time on the other:

- `cst fetch origin`, then `cst pull --ff-only`: they bring origin's notes in with the branches, and
  a plain `git pull` doesn't.
- `npm run build:native` (about 35 s) before any test run. A stale `cst` fails the version checks
  in install-script, integration, native-cli and release-packaging, which looks like a regression.
- On Windows, `cargo` comes from `%USERPROFILE%\.cargo\bin`, which has to be on the user `PATH`.

## Qualification chains

A full suite takes about 5 minutes on the Windows machine and under a minute in a Linux container,
and a change can need six or more modes. Run several modes as one detached script that appends one
line per mode to a summary file, and watch that file:

- **Check the launch within seconds.** Confirm the redirect log exists and `node --test` processes
  are running. A launcher that silently never started once cost 45 minutes of waiting. Give any wait
  on the summary a deadline that prints a line, so silence can't pass for progress.
- **Pass the chain's arguments in a launcher script.** On Windows, a `Start-Process` argument list
  splits a `-c` string at spaces, so a script given arguments that way ran with none and finished at
  once. Put the arguments in a small launcher script and pass only its path.
- **Don't change what the chain runs.** Each suite file is a separate `node` process that loads
  `test-support/` when it starts, so editing `test-support/` or a test mid-chain changes what later
  files load. Never run `npm run build:native` while a chain runs: it replaces the binary under test.
  Never run `npm run sync:architecture` or edit a module's `//!` doc either: the architecture-tables
  test compares them mid-run. Rust source edits are safe. Make the other edits afterwards, then
  rerun on the final code.
- **Never stop a running chain partway.** Killing it kills its `git` children and leaves garbage
  results.
- **An ended shell isn't an ended chain.** When the shell that launched a detached chain is stopped,
  the chain and its `node --test` children keep running as orphans. List `node`, `bash` and `cst`
  processes before cleaning fixtures or starting another suite: `npm run demo:clean -- --all --apply`
  once deleted a live chain's fixtures. To end an orphan on Windows, kill the chain's `bash` first,
  or it starts the next mode, then the `node --test` process itself: `taskkill /T` on the `bash`
  doesn't reach it.
- **Match processes precisely.** This machine runs the owner's other projects. Match `--test` and
  this repository's paths, never a bare project-name fragment.
- **Recognize a torn-down run.** Hundreds of failures with millisecond durations,
  `Error: Command failed: git init -b main`, or Windows `0xC0000142` process-start failures mean the
  environment died, not the code. Rerun those modes on a quiet machine.

## Known environmental failures

- **`Get-FileHash` is not recognized** in `test/install-script.test.js`, and only there: the suite
  was started from PowerShell 7, whose `PSModulePath` leaks into the Windows PowerShell 5.1 that
  `install.ps1` runs under. Rerun with `env -u PSModulePath`, or start the chain that way.
- **Native reads all fall back.** The native core refuses to read under `GIT_CONFIG_COUNT` or
  `GIT_CONFIG_PARAMETERS` (`native/core/src/lib.rs`), and some agent launchers export
  `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*` and `GIT_CONFIG_VALUE_*`. Unset them for any native-mode
  run or manual differential, as CI does.
- **A path-length failure that looks unrelated.** A resolution ref costs about 145 characters below
  the repository root, and agent scratch directories are often deeper than the 114-character root
  Windows allows without long paths ("Windows resolution retention paths" in `docs/testing.md`).
  Point `TEMP` at a short root, never at a deep scratch directory.
- **A fresh linked worktree runs its own build.** A chain run from a worktree uses that worktree's
  `native/target`, so build there first.

## Measurements

- Never run `npm run test:benchmark`, `cst metadata benchmark` or the Git-session demo while a
  suite or another agent is running. Windows pays about 35-45 ms per Git process, so wall times from
  a loaded machine are noise, and they end up in ADRs and the committed baseline.
- Load on this machine is not only CPU: it also runs games. To make a timing bug deterministic,
  slow the one Git subcommand involved with a shim on `PATH`; extra CPU threads changed nothing.
- Prefer a count over a timing for a regression test: process counts, or read-byte and read-call
  counts at the store's seam (`Store::bytes_read`).
- Small samples mislead: 7 samples gave 107% where 15 gave 120% for the same phase.
- Host-specific evidence (raw benchmark JSON, process counts) goes in an issue comment, never in a
  commit.

## Linux evidence from Windows

Docker Desktop is installed. `node:22-alpine3.22` has Git 2.49; `ubuntu:24.04` with
`ppa:git-core/ppa` and a Node tarball gives current Git. `node:22-trixie`'s Git 2.47 is too old for
the merge-tree engine.

- `docker run --init`, as the image's unprivileged user with `HOME` set.
- Clone from a `git bundle` of `HEAD` and carry uncommitted work as a `git diff HEAD --binary`
  patch. Bind mounts distort timings and line endings.
- Keep log file names free of `:`, which `docker cp` to Windows can't write.

## Writing tests that pass on both platforms

- A fixture that stages a file mode must also `chmod` the worktree file. Otherwise Linux, with
  `core.filemode=true`, sees a dirty mode change. Windows hides this.
- A reftable ref lock holds the whole stack: every ref write fails with `cannot lock references`,
  Git's own included. A test that needs one ref locked while others move needs files storage
  (`FILES_REFS` in `test-support/git-environment.js`) or a `reference-transaction` hook that refuses
  only that ref.
- Comparison tests that pair two runs must sort per-command counts by name: `byCommand` is ordered
  by elapsed time.
