# ADR-0038: Deliver the Rust CLI through per-platform npm packages, linked without Node

- **Status:** Proposed
- **Date:** 2026-09-27
- **Owners:** Repository maintainers
- **Implementation:** [#138](https://github.com/jwh3times/vcs-lab/issues/138) (this decision),
  [#150](https://github.com/jwh3times/vcs-lab/issues/150) (CI build and publish),
  [#139](https://github.com/jwh3times/vcs-lab/issues/139) (npm account and trusted publishing,
  a human action)
- **Related:** [ADR-0015](0015-adopt-a-phased-native-core-program-with-rust.md),
  [ADR-0027](0027-bound-native-read-engine-entry-by-the-resolution-catalog-budget.md),
  [ADR-0037](0037-reimplement-the-cli-in-rust-as-a-semantics-preserving-port.md)
- **Related requirements:** NFR-PORT-01, NFR-PORT-02, NFR-SEC-03

## Context

[ADR-0037](0037-reimplement-the-cli-in-rust-as-a-semantics-preserving-port.md) makes `vlab` a
Rust executable. Its target (#152) is an `npm install -g` that yields a `vlab` needing no Node.js
**to run**. Node is still present to *install*, because npm is a Node program. This ADR decides how
the executable reaches the user, and how the `vlab` command reaches the executable.

Three constraints shape the answer.

1. **The performance point of the program is startup.** Checkpoint 0 measured a bare `node -e 0`
   at 44.9 ms on `lab-windows-a`, and `vlab --version` at 108.5 ms. A JavaScript launcher in front
   of the binary would add back at least the first figure to every command.
   (Checkpoint 0 is on the wiki's [Performance testing](https://github.com/jwh3times/vcs-lab/wiki/Performance-testing)
   page.)
2. **The package promise.** Installation "never downloads a binding or runs a compiler"
   (`docs/native-engine.md`). Nothing in this ADR relaxes that.
3. **Windows is the reference platform.** A mechanism that only removes Node on POSIX misses the
   host where process startup costs most.

### How npm links a `bin`

These facts were verified from npm's own sources on 2026-09-27.

- **`bin` must name a file inside the package itself.**
  [`npm-normalize-package-bin`](https://github.com/npm/npm-normalize-package-bin/blob/main/lib/index.js)
  rewrites every target with `join('/', target).slice(1)`, so `../` cannot escape the package
  root. The `bin` of a main package cannot point into one of its dependencies.
- **On POSIX, npm symlinks the target and makes it executable.**
  [`bin-links`](https://github.com/npm/bin-links/blob/main/lib/link-bins.js) uses `link-bin.js`
  (a symlink, then `fix-bin.js`'s `chmod`) everywhere except Windows. A native executable then
  runs directly.
- **On Windows, npm writes `.cmd`, `.ps1` and `sh` shims with
  [`cmd-shim`](https://github.com/npm/cmd-shim/blob/main/lib/index.js).** It reads the target's
  first line.
  - With a `#!` line, the shims run the named interpreter: `node` for a JavaScript target.
  - With **no** `#!` line ("assume it's something that'll be compiled … and just call it
    directly"), the `.cmd` shim is `"%dp0%\<target>" %*`. The `sh` shim `exec`s the target, and
    the `.ps1` shim invokes it with `&`. No Node process is started.
  - [npm's `package.json` documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json)
    says the same from the other side: a `bin` file without `#!/usr/bin/env node` is "started
    without the node executable".
- **The order npm installs in.** [Arborist's `rebuild.js`](https://github.com/npm/cli/blob/latest/workspaces/arborist/lib/arborist/rebuild.js)
  builds the packages it has already unpacked in this order: `preinstall` scripts, then **link
  bins**, then `install` and `postinstall` scripts. A `preinstall` script can therefore change a
  `bin` target before its shim is written. A `postinstall` script cannot.

### How comparable tools do it

- **esbuild** ([`lib/npm/node-install.ts`](https://github.com/evanw/esbuild/blob/main/lib/npm/node-install.ts)):
  - It ships one package per platform as `optionalDependencies`, and its `bin` is a JavaScript
    launcher.
  - A `postinstall` step replaces that launcher with the native binary, but only off Windows. Its
    comment says this "does not work on Windows because on Windows the binary executable must be
    called 'esbuild.exe'". The real reason is the ordering above: the Windows shim was already
    written, pointing at `node`.
  - The step is skipped under Yarn and `--ignore-scripts`.
  - When the platform package is missing, esbuild falls back to a nested `npm install`, then an
    HTTP download from the registry.
- **Biome** ([`packages/@biomejs/biome/bin/biome`](https://github.com/biomejs/biome/blob/main/packages/%40biomejs/biome/bin/biome)):
  - It uses eight platform packages, including Linux musl, with `os`, `cpu` and `libc` fields (for
    example `@biomejs/cli-linux-x64-musl` declares `"libc": ["musl"]`).
  - Its `bin` is a JavaScript launcher that `spawnSync`s the binary on every invocation, and it has
    no install scripts.

npm's `package.json` documentation defines `os` and `cpu`, and `libc`, which "only applies if `os`
is `linux`". For `optionalDependencies`, "build failures do not cause installation to fail … It is
still your program's responsibility to handle the lack of the dependency."

## Decision

### 1. Layout: one main package, plus one package per platform as `optionalDependencies`

- **The main package** owns the `vlab` command. It contains the JavaScript CLI as long as
  ADR-0037 keeps it: the delegation target during the transition, and the oracle afterwards. It
  lists every platform package in `optionalDependencies`, pinned to its own exact version.
- **Each platform package** contains one prebuilt `vlab` executable and its third-party notices.
  It declares `os`, `cpu` and, on Linux, `libc`, so npm installs only the matching one. It has no
  scripts and no dependencies.
- **Nothing is downloaded or compiled.** There is no fallback to a nested `npm install` or an HTTP
  fetch, unlike esbuild. The promise in `docs/native-engine.md` stands as written.

### 2. `vlab` reaches the binary without Node: a `preinstall` copy onto a fixed `bin` target

- **The main package declares `"bin": { "vlab": "bin/native/vlab.exe" }` on every platform.**
  - The `.exe` suffix is what Windows needs.
  - POSIX ignores it: the symlink is named `vlab`, and the kernel runs an ELF or Mach-O file
    whatever it is called.
- **As published, `bin/native/vlab.exe` is a small Node launcher** with a `#!/usr/bin/env node`
  line. The launcher finds the installed platform package's executable and runs it with the same
  arguments and standard streams, then exits with its code.
- **The launcher's directory holds a `package.json` of `{ "type": "commonjs" }`.** This package is
  `"type": "module"`, and under that Node refuses to run a `.exe` file with
  `ERR_UNKNOWN_FILE_EXTENSION`. With the nested `package.json`, Node runs it as CommonJS; both
  behaviors were checked on Node 26.4. The launcher gets its own directory because the JavaScript
  CLI's ESM entry point, `bin/vlab.js`, must stay under the module type.
- **A `preinstall` script in the main package replaces that file with a copy of the platform
  executable,** after checking that the executable's `--version` output equals the main
  package's version. Because `preinstall` runs before bins are linked, npm then finds a target
  with no `#!` line:
  - on POSIX, `vlab` is a symlink to the native executable;
  - on Windows, `vlab.cmd` is `"%dp0%\…\bin\native\vlab.exe" %*`.

  Either way, **no Node process is started when `vlab` runs.**
- **When scripts do not run** (`--ignore-scripts`, a package manager that blocks dependency
  scripts, or a failed copy), the launcher stays in place. `vlab` still works, paying the Node
  startup cost on every command, and `vlab doctor` says so.
- **This is a measured claim, not an assumed one.** Checkpoint 8 on the Performance testing page
  (#150) measures `vlab --version` through the npm-installed command on each platform. It
  measures both paths: with scripts, and with `--ignore-scripts`. On Windows the `.cmd` shim still
  costs one `cmd.exe` start, which checkpoint 0 did not isolate. Checkpoint 8 records it against a
  direct launch of the executable.

### 3. Platform matrix

| Wave | Platform packages | Rust target | Build and qualification runner |
| --- | --- | --- | --- |
| **First release** | `win32-x64` | `x86_64-pc-windows-msvc` | `windows-latest`; latency reference `lab-windows-a` |
| **First release** | `linux-x64` (glibc) | `x86_64-unknown-linux-gnu` | `ubuntu-latest` |
| Second wave | `linux-arm64` (glibc) | `aarch64-unknown-linux-gnu` | `ubuntu-24.04-arm` |
| Second wave | `win32-arm64` | `aarch64-pc-windows-msvc` | `windows-11-arm` |
| Second wave | `linux-x64-musl`, `linux-arm64-musl` | `x86_64-` / `aarch64-unknown-linux-musl` | built and tested in an Alpine container; GitHub has no musl runner |
| Third wave | `darwin-arm64`, `darwin-x64` | `aarch64-` / `x86_64-apple-darwin` | `macos-latest` / `macos-15-intel`. There is no qualification host, so CI evidence only |

- **The first release ships only what is qualified today.** Those are the two targets
  `scripts/build-native.mjs` builds. Each later wave needs its CI jobs (#150) passing the full
  `VLAB_CLI` suite on its own runner before its package is published.
- **The runner labels** are taken from GitHub's
  [hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
  which states that standard runners are free on public repositories.
- **On a platform with no package:**
  - While the main package still contains the JavaScript CLI (until ADR-0037's oracle period
    ends), the launcher runs the JavaScript CLI and warns once per invocation.
  - After that, it exits with an error that names the supported platforms and the issue for
    requesting another.

### 4. Names

- **The main package keeps the name it already has, `causal-vcs-lab`.** The command stays
  `vlab`.
- **Platform packages go under an organization scope, `@vcs-lab/`.** Examples:
  `@vcs-lab/cli-win32-x64`, `@vcs-lab/cli-linux-x64-gnu`, `@vcs-lab/cli-linux-x64-musl`,
  `@vcs-lab/cli-darwin-arm64`. A scope groups them, stops anyone squatting a sibling name, and is
  where trusted publishing is configured.
- **If the `vcs-lab` organization cannot be created, the fallback is unscoped names:**
  `causal-vcs-lab-<platform>`.
- **Availability, checked with `npm view` on 2026-09-27 at 22:00 UTC.** `causal-vcs-lab`,
  `@vcs-lab/cli`, `@vcs-lab/vlab`, `vcs-lab`, `vlab` and `@jwh3times/vlab` all return 404: nothing
  is published under those names. That does not prove any of them can be registered. npm may
  refuse a name as too similar to an existing one, and organization availability can only be
  checked while signed in, which is part of #139.

### 5. Supply chain

- **Publishing uses npm trusted publishing from GitHub Actions only.**
  [npm's documentation](https://docs.npmjs.com/trusted-publishers) sets these conditions:
  - npm CLI 11.5.1 or later and Node 22.14 or later;
  - a trusted publisher configured **per package** (each package can have up to 10);
  - **GitHub-hosted runners only**: "Self-hosted runners are not currently supported".

  Provenance attestations are generated automatically when publishing a public package from a
  public repository. This repository is public, so every package, main and platform, carries
  provenance. No long-lived token exists.
- **Checksums.** The release workflow records a SHA-256 for every executable. The main package
  lists them, and the `preinstall` copy and the launcher both refuse an executable whose digest
  does not match, as esbuild's `binaryIntegrityCheck` does.
- **Code signing is not required for the first release.**
  - Windows Authenticode needs a certificate, and macOS notarization needs an Apple Developer
    account. Both are human actions with a recurring cost.
  - The first release covers Windows and Linux only, and provenance with checksums already binds
    each executable to the commit and workflow that built it.
  - Revisit before the third wave (macOS), or earlier if Windows Defender or SmartScreen friction
    is observed on an npm-installed `vlab`. Each certificate becomes its own human-action issue.

### 6. Versioning: lockstep, with a refusal on mismatch

- Every platform package is published at exactly the main package's version, from the same
  workflow run and the same commit.
- The main package pins each one with an exact version (`"@vcs-lab/cli-win32-x64": "0.19.0"`, not
  a range).
- The `preinstall` copy and the launcher both compare the executable's `--version` output with the
  main package's version, and **refuse** to run a mismatched executable, naming both versions.

### 7. GitHub releases

Each release also attaches:
- one archive per platform (`vlab-<version>-<rust-target>.zip` for Windows and `.tar.gz`
  elsewhere);
- a `SHA256SUMS` file;
- the packed npm tarballs.

A user without npm can download the executable directly. Release assets and npm packages come
from the same workflow run, so their digests match.

## Constraints

- **Installation never downloads or compiles anything.** The only install-time action is copying a
  file from one installed package into another, after checking its version and digest.
- **Git stays a runtime requirement** (ADR-0037). No package bundles Git.
- **A platform package is published only when its target passes the full `VLAB_CLI` suite** in CI
  on its own runner (#150).
- **The launcher path must keep working,** because `--ignore-scripts` is common in hardened
  environments. It is slower, never broken.
- **Every published package carries npm provenance.** A publish that cannot produce it is not
  made.

## Consequences

### Positive

- With scripts enabled, `vlab` starts with no Node process on Windows and POSIX alike. That is the
  cost ADR-0037 exists to remove, and checkpoint 8 measures it.
- Offline and mirrored installs work, because nothing is fetched outside npm's own resolution.
- One command name and one main package throughout the transition, the oracle period, and after.

### Negative

- The main package has a `preinstall` script. Users who audit install scripts see one, although it
  only copies a file between packages already on disk.
- Under `--ignore-scripts` or a script-blocking package manager, every command pays Node startup
  until the user reinstalls with scripts. `vlab doctor` makes this visible.
- Each platform added costs a CI job and a published package per release.
- The `cmd.exe` hop on Windows remains. It is cheaper than Node, but it is not zero, and no npm
  mechanism removes it.

## Rejected alternatives

- **A JavaScript launcher always, as Biome does.** This is the simplest option and needs no
  scripts, but it puts Node's startup (44.9 ms at checkpoint 0) in front of every command, which
  is the cost the program exists to remove.
- **A `postinstall` swap, as esbuild does.** It cannot help Windows, because npm has already
  written a shim that calls `node` by then, and Windows is the reference platform.
- **A download at install time** (a `postinstall` fetch of the right binary). It breaks the "never
  downloads" promise, offline installs, and registry mirrors.
- **Separate per-platform main packages** (`npm i -g @vcs-lab/cli-win32-x64`). Users would have to
  know their platform, and the command would differ between machines.
- **Bundling every platform's executable in the main package.** Every install would download every
  platform, which is several times the size for no benefit.

## What the owner must decide

1. **Layout:** a main package plus per-platform `optionalDependencies`, with no download or
   compile at install time.
2. **The `bin` mechanism:** `bin/native/vlab.exe`, replaced by a `preinstall` copy, with the
   Node launcher as the fallback when scripts do not run.
3. **The matrix:** Windows x64 and Linux x64 glibc first. Then Linux arm64, Windows arm64 and musl.
   Then macOS, qualified only by CI.
4. **Names:** `causal-vcs-lab` for the main package, and the `@vcs-lab/` scope for platform
   packages, with unscoped names as the fallback.
5. **Signing:** not required for the first release. Revisit before macOS, or on observed
   Defender or SmartScreen friction.
6. **Lockstep versioning,** with a refusal on mismatch.
7. **GitHub release assets:** archives, `SHA256SUMS`, and npm tarballs.

## Implementation map

- **#150:** the per-platform build jobs, the platform `package.json` files, the main package's
  `optionalDependencies` and `bin`, the launcher and `preinstall` script, digest and version
  checks, trusted publishing, release assets, and checkpoint 8.
- **#139:** creating the `vcs-lab` organization and the packages, and configuring a trusted
  publisher per package (the wiki's `Human-action-139` procedure).
- **At cutover (#152):** `README.md` install instructions and `docs/native-engine.md`'s packaging
  section.
