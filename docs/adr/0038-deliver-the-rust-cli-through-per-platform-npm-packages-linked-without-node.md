# ADR-0038: Deliver the Rust CLI through per-platform npm packages, linked without Node

- **Status:** Accepted; amended 2026-09-28 (platform package scope, first publishes; main package name) and 2026-10-08 (primary install channel)
- **Decided:** 2026-09-27
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

- **The main package, `causet`,** owns the `cst` command (and `vlab` as a transition alias, §4).
  It contains the JavaScript CLI as long as ADR-0037 keeps it: the delegation target during the
  transition, and the oracle afterwards. It lists every platform package in
  `optionalDependencies`, pinned to its own exact version.
- **Each platform package** contains one prebuilt `cst` executable and its third-party notices.
  It declares `os`, `cpu` and, on Linux, `libc`, so npm installs only the matching one. It has no
  scripts and no dependencies.
- **Nothing is downloaded or compiled.** There is no fallback to a nested `npm install` or an HTTP
  fetch, unlike esbuild. The promise in `docs/native-engine.md` stands as written.

### 2. `cst` reaches the binary without Node: a `preinstall` copy onto a fixed `bin` target

- **The main package declares `"bin": { "cst": "bin/native/cst.exe" }` on every platform,**
  plus `"vlab": "bin/native/cst.exe"` while the transition alias lasts (§4).
  - The `.exe` suffix is what Windows needs.
  - POSIX ignores it: the symlink is named `cst`, and the kernel runs an ELF or Mach-O file
    whatever it is called.
- **As published, `bin/native/cst.exe` is a small Node launcher** with a `#!/usr/bin/env node`
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
  - on POSIX, `cst` is a symlink to the native executable;
  - on Windows, `cst.cmd` is `"%dp0%\…\bin\native\cst.exe" %*`.

  Either way, **no Node process is started when `cst` runs.**
- **When scripts do not run** (`--ignore-scripts`, a package manager that blocks dependency
  scripts, or a failed copy), the launcher stays in place. `cst` still works, paying the Node
  startup cost on every command, and `cst doctor` says so.
- **This is a measured claim, not an assumed one.** Checkpoint 8 on the Performance testing page
  (#150) measures `cst --version` through the npm-installed command on each platform. It
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

### 4. Names: `causet` and `cst` (owner decision, 2026-09-27)

The owner chose the name on 2026-09-27, because an npm name is permanent and should mean
something. "vcs-lab" was the experiment's working title: a version-control-system *laboratory*.

- **The npm package is `causet`.** A *causal set* is physics' model of history as a partial order
  of events, each knowing what preceded and caused it. That is this tool's model: a commit graph
  whose changes keep a stable identity and carry verifiable receipts of what caused what.
- **The command is `cst`.** It is short, easy to type, and collides with nothing on the
  qualification hosts. Common tools already own `cs` (Coursier) and `cz` (Commitizen), so neither
  was a candidate.
- **Platform packages go under the `@causet/` organization scope,** for example
  `@causet/cli-win32-x64`, `@causet/cli-linux-x64-gnu`, `@causet/cli-linux-x64-musl` and
  `@causet/cli-darwin-arm64`. A scope groups them, stops anyone squatting a sibling name, and is
  where trusted publishing is configured. If the organization cannot be created, the fallback is
  unscoped `causet-<platform>`.
- **Availability, checked with `npm view` on 2026-09-27:** `causet`, `causet-cli`,
  `causet-win32-x64`, `causet-linux-x64-gnu`, `@causet/cli` and `@causet/cli-win32-x64` all return
  404. That does not prove they can be registered: npm may refuse a name as too similar to an
  existing one, and organization availability is checked only while signed in (#139). Until the
  names are claimed (#139's placeholder publish), they are not ours. Claim them promptly.

**What this ADR does not change.** The name here belongs to the distribution and the command.
These persisted identifiers are left as they are by this ADR:
- the `vcs-lab.*` record families and schema identifiers;
- `refs/notes/vcs-lab` and `refs/vcs-lab/*`;
- `.git/vcs-lab/`, `.vcs-lab/specs`;
- the `VLAB_*` environment variables;
- the repository name.

They already exist in repositories and exchanged envelopes, so renaming them is a migration, not an
edit. On 2026-09-27 the owner directed that they, and the repository, move to `causet` as well.
That is [#159](https://github.com/jwh3times/vcs-lab/issues/159), whose migration contract is its
own ADR. Until #159 lands, they keep their current names.

**The command transition.** Renaming the command is a change to the CLI contract, so under
ADR-0037 it happens in the JavaScript CLI first:
1. The JavaScript CLI ships `cst` as its command, keeps `vlab` as an alias for the same entry
   point, and prints `cst` in help, usage and messages. The alias changes no output, so `--json`
   output and exit codes stay identical under both names.
2. The Rust executable answers to both names during the transition, because npm links both.
3. The `vlab` alias is removed no earlier than the end of ADR-0037's oracle period, two minor
   releases after cutover, and only with a changelog notice one release ahead.

This rename is its own issue, and it can land before any Rust code exists.

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
    is observed on an npm-installed `cst`. Each certificate becomes its own human-action issue.

### 6. Versioning: lockstep, with a refusal on mismatch

- Every platform package is published at exactly the main package's version, from the same
  workflow run and the same commit.
- The main package pins each one with an exact version (`"@causet/cli-win32-x64": "0.19.0"`, not
  a range).
- The `preinstall` copy and the launcher both compare the executable's `--version` output with the
  main package's version, and **refuse** to run a mismatched executable, naming both versions.

### 7. GitHub releases

Each release also attaches:
- one archive per platform (`cst-<version>-<rust-target>.zip` for Windows and `.tar.gz`
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

- With scripts enabled, `cst` starts with no Node process on Windows and POSIX alike. That is the
  cost ADR-0037 exists to remove, and checkpoint 8 measures it.
- Offline and mirrored installs work, because nothing is fetched outside npm's own resolution.
- One command name and one main package throughout the transition, the oracle period, and after.

### Negative

- The main package has a `preinstall` script. Users who audit install scripts see one, although it
  only copies a file between packages already on disk.
- Under `--ignore-scripts` or a script-blocking package manager, every command pays Node startup
  until the user reinstalls with scripts. `cst doctor` makes this visible.
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
- **Separate per-platform main packages** (`npm i -g @causet/cli-win32-x64`). Users would have to
  know their platform, and the command would differ between machines.
- **Bundling every platform's executable in the main package.** Every install would download every
  platform, which is several times the size for no benefit.

## What the owner decided

1. **Layout:** a main package plus per-platform `optionalDependencies`, with no download or
   compile at install time.
2. **The `bin` mechanism:** `bin/native/cst.exe`, replaced by a `preinstall` copy, with the
   Node launcher as the fallback when scripts do not run.
3. **The matrix:** Windows x64 and Linux x64 glibc first. Then Linux arm64, Windows arm64 and musl.
   Then macOS, qualified only by CI.
4. **Names: decided by the owner on 2026-09-27.** The package is `causet`, the command is
   `cst` (with `vlab` as a transition alias), and platform packages go under `@causet/`, with
   unscoped `causet-<platform>` as the fallback. Persisted identifiers keep `vcs-lab`.
5. **Signing:** not required for the first release. Revisit before macOS, or on observed
   Defender or SmartScreen friction.
6. **Lockstep versioning,** with a refusal on mismatch.
7. **GitHub release assets:** archives, `SHA256SUMS`, and npm tarballs.

## Owner decision (2026-09-27)

The owner chose the names (decision 4) and then accepted the other six decisions as written. The
same day the owner also directed a full rename of the `vcs-lab` identifiers and the repository.
That is tracked as #159 and does not change this ADR's decisions.

## Implementation map

- **#150:** the per-platform build jobs, the platform `package.json` files, the main package's
  `optionalDependencies` and `bin`, the launcher and `preinstall` script, digest and version
  checks, trusted publishing, release assets, and checkpoint 8.
- **#139:** creating the `causet` organization, claiming `causet` and the platform package names
  with placeholder publishes, and configuring a trusted publisher per package (the wiki's
  `Human-action-139` procedure).
- **The command rename:** a separate issue makes `cst` the JavaScript CLI's command, with `vlab`
  kept as an alias, before any Rust code depends on the name (§4).
- **At cutover (#152):** `README.md` install instructions and `docs/native-engine.md`'s packaging
  section.

## Amendment 2026-09-28: `@holland-vip/` scope, and no placeholder publishes

**The `causet` organization name is unavailable on npm.** npm treats organization names,
usernames and package names as first come, first served. It "does not resolve squatting claims on
demand" and transfers a name only on a trademark claim
([dispute policy](https://docs.npmjs.com/policies/disputes)). The package name `causet` is still
free: packages and organizations are separate namespaces.

The same policy forbids publishing "a package … simply for the purposes of reserving it for future
use". So the placeholder publishes that #139's procedure first described are withdrawn.

Decided by the owner on 2026-09-28:

- **Platform packages go under the owner's existing `@holland-vip/` organization,** named
  `@holland-vip/causet-<platform>`, for example `@holland-vip/causet-win32-x64` and
  `@holland-vip/causet-linux-x64-gnu`.
  - This replaces `@causet/cli-<platform>` everywhere §4, §6 and the owner decisions name it.
  - It also replaces the unscoped `causet-<platform>` fallback, because an owned scope protects
    sibling names and an unscoped name does not.
  - If `@causet/` is ever obtained, moving to it is an ordinary release change. The main
    package's `optionalDependencies` name the new packages, and the old ones are deprecated.
    Users only ever type `causet`.
- **The main package stays `causet`, unscoped.** Its first publish is a real release: v0.19.0, the
  JavaScript CLI with `cst` and the `vlab` alias. §1 already has the main package carry the
  JavaScript CLI until cutover, so shipping it before the Rust binaries exist changes nothing
  about the layout. Every later release adds the platform packages when #150 produces them.
- **First publishes are manual, and every later one is trusted.** npm configures a trusted
  publisher only on a package that already exists:
  - `causet` is first published by the owner from the v0.19.0 tarball (#139, step 3);
  - each platform package is first published once from #150's CI artifacts (#139, step 4).

  From then on, the release workflow publishes through trusted publishing with provenance, and
  tokens are disallowed.
- **No name is published before it has real content.** Scoped platform names need no early claim,
  because only `holland-vip` can publish under `@holland-vip/`.

## Amendment 2026-09-28 (second): the main package is `@holland-vip/causet`

npm refused the first publish of `causet` with
`E403 … Package name too similar to existing packages case,faucet`. This is npm's typosquatting
check. It applies only to unscoped names and cannot be detected before a publish: the name was
unregistered, and `npm publish --dry-run` passed.

Decided by the owner on 2026-09-28:

- **The main package is `@holland-vip/causet`,** installed with
  `npm install -g @holland-vip/causet`. It sits under the same organization scope as the
  platform packages, so no similarity or squatting rule applies.
- **The product name `causet` and the command `cst` do not change.** npm's `bin` field sets the
  command whatever the package is called, so `cst` (and the `vlab` alias) are installed exactly
  as before.
- **If the `causet` organization is ever obtained,** the package can move to `@causet/causet`, with
  the old name deprecated and pointing to the new one.
- `package.json` gains `repository`, `homepage` and `bugs`, which npm provenance needs for
  trusted publishing (#150), and `publishConfig.access: public`, so a scoped publish cannot
  default to private.
- **Released as v0.19.1.** v0.19.0 was tagged with the name `causet` and was never published.
  Publishing it under another name would have made the published package differ from its tag.

## Amendment 2026-10-08: GitHub releases become the primary install channel

**Accepted by the owner on 2026-10-08**, as recorded at the end of this section. It takes effect
with the release that delivers [#218](https://github.com/jwh3times/causet/issues/218); v0.21.0
ships through npm as prepared.

### What changed since 2026-09-27

1. **npm 12 runs no install script unless told to.** §2 puts the executable at the `bin` target
   with a `preinstall` copy, and names "a package manager that blocks dependency scripts" as the
   case where the Node launcher stays. Measured while building #150, with npm 12.2.0:
   - `npm install -g @holland-vip/causet` succeeds, warns that the script was blocked, and leaves
     the launcher. Every command then starts through Node;
   - `npm install -g --allow-scripts=@holland-vip/causet @holland-vip/causet` runs the copy.

   The fallback case is now the default one for anyone on a current npm. The first of this
   ADR's three constraints, that startup is the point of the program, is therefore not met by
   the default install.
2. **npm offers no script-free route to the same result.** `bin` must name a file inside the
   top-level package (Context, "How npm links a `bin`"), and only a top-level package's `bin` is
   linked. The executable lives in a dependency. Without a script, the only layouts that work are
   the two this ADR already rejected: a JavaScript launcher always, or a separate main package
   per platform.
3. **The cutover happened.** From v0.21.0 `cst` needs no Node.js to run (ADR-0037, #152). npm
   is now the only reason a user needs Node.js at all.
4. **The other channel already exists.** §7 has every release attach one archive per platform and
   `SHA256SUMS`, and `.github/workflows/release.yml` builds them (#150).

### Decision

1. **The primary way to install `cst` is an install script over the GitHub release assets.**
   - `install.sh` (Linux, and macOS once built) and `install.ps1` (Windows) download the host's
     archive and `SHA256SUMS` from a release, refuse an archive whose SHA-256 is not the listed
     one, and place `cst` in a user-writable directory with no elevation.
   - Both scripts are themselves release assets, so a pinned version is installed by the script
     of that version.
   - The README leads with this method. It needs neither Node.js nor npm.
2. **npm stays, unchanged, as the second channel.** §1 to §3 and §6 stand as written: the same
   package set, the same `preinstall` copy, the same launcher, lockstep versions.
   - It suits a team that pins tools in a `package.json`, and it is the only channel that carries
     the JavaScript CLI: the oracle of ADR-0037 §6 (`CAUSET_DELEGATE=always`), and the
     implementation that runs on a platform with no published executable.
   - The README states its cost plainly: it works as installed, and
     `--allow-scripts=@holland-vip/causet` gives the Node-free command on npm 12 and later.
3. **Release archives carry build provenance.** The release workflow attests every archive with
   GitHub artifact attestations, and the README gives the `gh attestation verify` command. This
   is the download path's counterpart to the provenance npm's trusted publishing gives the
   packages (§5).
4. **Package managers follow, each as its own issue:** winget and Scoop first, because Windows is
   the reference platform, then Homebrew with the third wave. Each is a manifest that points at
   the same release assets and digests.
5. **"Installation never downloads or compiles anything" becomes a statement about npm.** It was
   written for a package install, where a nested download breaks offline and mirrored installs.
   An install script downloads by definition, from one named host, one file, checked against a
   published digest. The constraint is reworded: *an npm install* never downloads or compiles
   anything outside npm's own resolution.

### What this does not change

- The names (§4), the platform matrix and its qualification rule (§3), and lockstep versioning
  with a refusal on mismatch (§6).
- v0.21.0, which ships through npm as prepared. This amendment takes effect with the release
  that delivers #218.
- `cst doctor`'s `launcher` field: `null` for an executable installed either way, `"node"` for
  the launcher.

### Consequences

**Positive**

- The default install gives the command the program was built to give: no Node process at
  startup, on Windows and POSIX alike, with no flag to know.
- A user needs no Node.js at any point, which is what "standalone" in #136 means.
- No new hosting: the assets, the digests and the workflow already exist.

**Negative**

- **A second channel to keep working.** Each release has to install by script and by npm, and
  both are smoke-tested in CI.
- **A download script is a trust decision the user makes.** `curl | sh` runs what the URL
  serves. The README has to give the download, read, then run form beside the one-liner, and
  the scripts have to stay short enough to read.
- **Windows SmartScreen.** A downloaded `.exe` is treated with more suspicion than one npm
  unpacked. §5 defers Authenticode signing "until friction is observed"; this channel makes that
  friction likely at the first release that uses it. Signing is a certificate with a recurring
  cost and a human action, and stays deferred (owner decision 4 below).
- **Upgrades are the user's to run.** npm has `npm update`; a script install is re-run. `cst`
  gains no self-update under this amendment.

### Alternatives considered

- **Keep npm as the only channel and document the flag.** This is what v0.21.0 does. It costs
  nothing, and it leaves the default install on the slow path for every user on npm 12 or
  later, with Node.js still required to install.
- **A launcher that replaces itself on first run.** On POSIX the command is a symlink to the
  launcher file, so the launcher could copy the executable over itself. On Windows the `.cmd`
  shim already names `node`, and nothing the launcher rewrites changes that. It fixes the
  platform that needed it least.
- **A separate main package per platform,** whose `bin` is the executable. Script-free, and
  already rejected above: the user has to know their platform, and the install command differs
  between machines.
- **`cargo install`.** It needs a Rust toolchain and compiles on the user's machine, which is
  the opposite of a prebuilt executable. `cargo binstall` avoids the compile and still needs
  Cargo.
- **Package managers only, with no script.** winget and Homebrew reviews take time the project
  does not control, and neither covers Linux distributions. They are added in decision 4, not
  relied on.

### What the owner was asked to decide

1. **The primary channel:** install scripts over the GitHub release assets, with npm second
   (decisions 1 and 2), or npm alone with the flag documented.
2. **Attestations** on the release archives (decision 3).
3. **The reworded constraint** (decision 5).
4. **Whether Windows signing should be decided now** or left to §5's "on observed friction".

### Owner decision (2026-10-08)

The owner accepted all four:

1. **Install scripts over the GitHub release assets are the primary channel,** and npm is the
   second, with its package set unchanged.
2. **Release archives are attested.**
3. **The constraint is reworded:** an npm install never downloads or compiles anything outside
   npm's own resolution.
4. **Windows signing is left until friction is observed,** as §5 already says. The package
   managers of decision 4 follow as their own issues.
