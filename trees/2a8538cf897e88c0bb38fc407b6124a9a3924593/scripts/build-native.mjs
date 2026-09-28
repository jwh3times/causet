import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = process.platform === "win32" ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-gnu";
if (process.arch !== "x64" || !["win32", "linux"].includes(process.platform)) {
  throw new Error("Native builds are qualified only for Windows x64 MSVC and Linux x64 GNU.");
}
const result = spawnSync(process.env.CARGO || "cargo", ["build", "--locked", "--release"], {
  cwd: path.join(root, "native"), stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const library = process.platform === "win32" ? "vlab_binding.dll"
  : process.platform === "darwin" ? "libvlab_binding.dylib" : "libvlab_binding.so";
const directory = path.join(root, "native/prebuilds", `${process.platform}-${process.arch}`);
mkdirSync(directory, { recursive: true });
copyFileSync(path.join(root, "native/target/release", library), path.join(directory, "vlab-core.node"));

const metadata = spawnSync(process.env.CARGO || "cargo", ["metadata", "--locked", "--format-version", "1", "--filter-platform", target], {
  cwd: path.join(root, "native"), encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
});
if (metadata.error) throw metadata.error;
if (metadata.status !== 0) throw new Error(metadata.stderr);
const notices = ["Third-party notices for the optional vlab native binding.\n"];
const graph = JSON.parse(metadata.stdout);
const tree = spawnSync(process.env.CARGO || "cargo", ["tree", "--locked", "--prefix", "none", "--format", "{p}"], {
  cwd: path.join(root, "native"), encoding: "utf8",
});
if (tree.error) throw tree.error;
if (tree.status !== 0) throw new Error(tree.stderr);
const selected = new Set(tree.stdout.split(/\r?\n/).map((line) => line.split(" ").slice(0, 2).join(" ")));
for (const dependency of graph.packages.filter((item) => item.source && selected.has(`${item.name} v${item.version}`))) {
  const location = path.dirname(dependency.manifest_path);
  const licenses = readdirSync(location, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(licen[sc]e|copying|notice|copyright)/i.test(entry.name))
    .map((entry) => path.join(location, entry.name));
  if (dependency.license_file) licenses.push(path.resolve(location, dependency.license_file));
  if (!licenses.length && dependency.repository === "https://github.com/napi-rs/napi-rs") {
    licenses.push(path.join(root, "native/licenses/napi-rs-LICENSE"));
  }
  if (!licenses.length) throw new Error(`No license text found for ${dependency.name}`);
  notices.push(`\n${dependency.name} ${dependency.version}: ${dependency.license}\n`);
  for (const file of new Set(licenses)) notices.push(`\n${path.basename(file)}\n${readFileSync(file, "utf8")}\n`);
}
writeFileSync(path.join(directory, "THIRD-PARTY-NOTICES.txt"), notices.join(""));
