// Assemble the publishable package set of ADR-0038: one package per platform
// holding a prebuilt `cst`, and the main package whose `cst` command is that
// executable. Nothing is published here; the release workflow publishes what
// this writes.
//
//   node scripts/pack-release.mjs --out <dir> \
//     --executable linux-x64-gnu=<path> --executable win32-x64=<path> \
//     [--notices <platform>=<path> ...]
//
// The repository's own `package.json` keeps the JavaScript CLI as its command
// until the cutover (#152). The main package written here differs from it in
// exactly three members: `bin`, `scripts.preinstall` and
// `optionalDependencies`, plus the generated `bin/native/checksums.json`.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { PLATFORMS } = createRequire(import.meta.url)("../bin/native/platform.js");

/** What npm needs to install a platform package only where it runs. */
const TARGETS = {
  "win32-x64": { os: ["win32"], cpu: ["x64"], rust: "x86_64-pc-windows-msvc" },
  "linux-x64-gnu": { os: ["linux"], cpu: ["x64"], libc: ["glibc"], rust: "x86_64-unknown-linux-gnu" },
};

function parse(argv) {
  const options = { executable: {}, notices: {}, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    index += 1;
    if (flag === "--out") options.out = value;
    else if (flag === "--executable" || flag === "--notices") {
      const [platform, ...file] = String(value ?? "").split("=");
      if (!TARGETS[platform] || !file.length) throw new Error(`${flag} needs <platform>=<path>, with a platform of: ${Object.keys(TARGETS).join(", ")}`);
      options[flag.slice(2)][platform] = path.resolve(file.join("="));
    } else throw new Error(`Unknown option ${flag}`);
  }
  if (!options.out) throw new Error("--out <directory> is required");
  if (!Object.keys(options.executable).length) throw new Error("At least one --executable <platform>=<path> is required");
  return options;
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/** `npm pack --json` lists packages in an array before npm 12 and by name from it. */
function packed(args, cwd) {
  const output = JSON.parse(execFileSync(npm, ["pack", "--json", ...args], {
    cwd, encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024,
  }));
  return Array.isArray(output) ? output[0] : Object.values(output)[0];
}

function pack(directory, out) {
  return path.join(out, packed(["--pack-destination", out], directory).filename);
}

export function packRelease(options) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const out = path.resolve(options.out);
  const stage = path.join(out, "stage");
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const checksums = {};
  const tarballs = [];

  for (const [platform, executable] of Object.entries(options.executable)) {
    const target = TARGETS[platform];
    const published = PLATFORMS[platform];
    const directory = path.join(stage, platform);
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(executable, path.join(directory, published.file));
    fs.chmodSync(path.join(directory, published.file), 0o755);
    const notices = options.notices[platform]
      ?? path.join(root, "native", "prebuilds", platform.split("-").slice(0, 2).join("-"), "THIRD-PARTY-NOTICES.txt");
    if (!fs.existsSync(notices)) throw new Error(`No third-party notices for ${platform} at ${notices}; pass --notices ${platform}=<path>`);
    fs.copyFileSync(notices, path.join(directory, "THIRD-PARTY-NOTICES.txt"));
    fs.copyFileSync(path.join(root, "LICENSE"), path.join(directory, "LICENSE"));
    fs.writeFileSync(path.join(directory, "README.md"), [
      `# ${published.package}`,
      "",
      `The prebuilt \`cst\` executable of [causet](${manifest.homepage}) ${manifest.version} for ${target.rust}.`,
      "",
      `Install \`${manifest.name}\`, which selects this package on a matching host. It is not meant to be installed by itself.`,
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(directory, "package.json"), `${JSON.stringify({
      name: published.package,
      version: manifest.version,
      description: `The causet cst executable for ${target.rust}.`,
      repository: manifest.repository,
      homepage: manifest.homepage,
      bugs: manifest.bugs,
      license: manifest.license,
      os: target.os,
      cpu: target.cpu,
      ...(target.libc ? { libc: target.libc } : {}),
      files: [published.file, "THIRD-PARTY-NOTICES.txt"],
      publishConfig: { access: "public" },
    }, null, 2)}\n`);
    checksums[published.package] = { file: published.file, sha256: sha256(executable), target: target.rust };
    tarballs.push(pack(directory, out));
  }

  // The main package: what `npm pack` would publish from this checkout, with
  // the command pointed at the executable.
  const main = path.join(stage, "main");
  const listed = packed(["--dry-run"], root).files.map((entry) => entry.path);
  for (const file of listed) {
    fs.mkdirSync(path.dirname(path.join(main, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(main, file));
  }
  fs.chmodSync(path.join(main, "bin", "native", "cst.exe"), 0o755);
  fs.writeFileSync(path.join(main, "bin", "native", "checksums.json"), `${JSON.stringify(checksums, null, 2)}\n`);
  fs.writeFileSync(path.join(main, "package.json"), `${JSON.stringify({
    ...manifest,
    bin: { cst: "bin/native/cst.exe", vlab: "bin/native/cst.exe" },
    scripts: { preinstall: "node bin/native/preinstall.js" },
    // Exact pins: a platform package of another version is refused (§6).
    optionalDependencies: Object.fromEntries(
      Object.keys(options.executable).map((platform) => [PLATFORMS[platform].package, manifest.version]),
    ),
  }, null, 2)}\n`);
  tarballs.push(pack(main, out));

  fs.rmSync(stage, { recursive: true, force: true });
  const sums = tarballs
    .map((file) => `${sha256(file)}  ${path.basename(file)}`)
    .concat(Object.entries(checksums).map(([name, entry]) => `${entry.sha256}  ${name}/${entry.file}`));
  fs.writeFileSync(path.join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
  return { version: manifest.version, tarballs, checksums };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = packRelease(parse(process.argv.slice(2)));
    console.log(JSON.stringify({ ...result, tarballs: result.tarballs.map((file) => path.basename(file)) }, null, 2));
  } catch (error) {
    console.error(`pack-release: ${error.message}`);
    process.exit(1);
  }
}
