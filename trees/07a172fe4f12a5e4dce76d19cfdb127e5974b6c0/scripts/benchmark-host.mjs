import os from "node:os";

export const BASELINE_SCHEMA = "vcs-lab.benchmark-baseline/v3";
const LEGACY_SCHEMA = "vcs-lab.benchmark-baseline/v2";

/** Operator-assigned labels avoid publishing hostnames or machine identifiers. */
export function parseOptions(args, env = process.env) {
  const options = { record: false, json: false, host: env.VLAB_BENCHMARK_HOST || null };
  let suppliedHost = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--record") options.record = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--host" && !suppliedHost) {
      suppliedHost = true;
      options.host = args[++index];
      if (!options.host) throw new Error("--host requires an explicit host label.");
    } else throw new Error(`Unknown or repeated option: ${arg}. Use --record, --json, and/or --host <label>.`);
  }
  if (options.host !== null && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(options.host)) {
    throw new Error("Host labels must be 1–64 lowercase ASCII letters, digits, dots, underscores, or hyphens, starting with a letter or digit.");
  }
  if (options.record && !options.host) {
    throw new Error("Recording requires --host <label> or VLAB_BENCHMARK_HOST; choose a stable label for this machine.");
  }
  return options;
}

export function hostProvenance(id, env = process.env) {
  const cpus = os.cpus();
  return {
    id,
    platform: process.platform,
    arch: process.arch,
    cpuModels: [...new Set(cpus.map((cpu) => cpu.model))].sort(),
    logicalCpus: cpus.length,
    memoryBytes: os.totalmem(),
    osRelease: os.release(),
    overrides: Object.fromEntries(["VLAB_ENGINE", "VLAB_GIT_SESSION", "VLAB_FORECAST_ENGINE"].map((key) => [key, env[key] || null])),
  };
}

/** Preserve every legacy measurement; never attribute an OS entry to a machine. */
export function migrateBaseline(baseline) {
  if (!baseline) return null;
  if (baseline.schema === BASELINE_SCHEMA) return structuredClone(baseline);
  if (baseline.schema !== LEGACY_SCHEMA) throw new Error(`Unsupported baseline schema '${baseline.schema}'; migrate it explicitly before recording.`);
  return { ...structuredClone(baseline), schema: BASELINE_SCHEMA, hosts: {}, legacyHosts: structuredClone(baseline.hosts ?? {}) };
}

function matchingHardware(before, after) {
  return ["platform", "arch", "logicalCpus", "memoryBytes"].every((key) => before[key] === after[key]) &&
    JSON.stringify(before.cpuModels) === JSON.stringify(after.cpuModels);
}

function matchingOverrides(before, after) {
  return ["VLAB_ENGINE", "VLAB_GIT_SESSION", "VLAB_FORECAST_ENGINE"].every((key) => (before?.[key] || null) === (after?.[key] || null));
}

/** Latency requires explicit identity AND matching recorded hardware/settings. */
export function selectBaseline(baseline, host) {
  const identified = host.id && Object.hasOwn(baseline?.hosts ?? {}, host.id) ? baseline.hosts[host.id] : null;
  if (identified?.host?.id === host.id && matchingHardware(identified.host, host) && matchingOverrides(identified.host.overrides, host.overrides)) {
    return { entry: identified, reference: `hosts.${host.id}`, latencySkipped: false, reason: null };
  }
  const reason = identified
    ? `Host '${host.id}' does not match its recorded hardware or benchmark settings.`
    : host.id ? `No identified baseline for host '${host.id}'.` : "No host identity selected; use --host <label> or VLAB_BENCHMARK_HOST.";
  const legacy = baseline?.legacyHosts?.[host.platform];
  // OS-only entries are historical latency evidence, but their default-mode
  // process/materialization counts remain useful independently of hardware.
  const entry = matchingOverrides({}, host.overrides) ? legacy : null;
  return { entry: entry ?? null, reference: entry ? `legacyHosts.${host.platform}` : null, latencySkipped: true, reason };
}

export function recordBaseline(baseline, current, profile, tolerance) {
  const next = migrateBaseline(baseline) ?? { schema: BASELINE_SCHEMA, profile, tolerance, hosts: {}, legacyHosts: {} };
  if (JSON.stringify(next.profile) !== JSON.stringify(profile) || JSON.stringify(next.tolerance) !== JSON.stringify(tolerance)) {
    throw new Error("The baseline profile or tolerance differs; migrate it explicitly before recording. Existing measurements were preserved.");
  }
  const id = current.host?.id;
  if (!id) throw new Error("Recording requires an identified host.");
  // Define an own property even for labels such as '__proto__'.
  next.hosts = Object.fromEntries([...Object.entries(next.hosts).filter(([key]) => key !== id), [id, current]].sort(([left], [right]) => left.localeCompare(right)));
  return next;
}
