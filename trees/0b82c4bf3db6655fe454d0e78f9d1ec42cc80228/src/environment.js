/**
 * The user-facing environment variables (ADR-0039 §5). Each is named
 * `CAUSET_<name>`; during the migration window the former `VLAB_<name>` is read
 * as a fallback, and when both are set `CAUSET_<name>` wins. Nothing is printed
 * when the fallback is used, so stderr stays empty in `--json` mode (ADR-0021);
 * `cst doctor` lists the legacy variables in use instead.
 *
 * "Set" means present, even when empty: an empty `CAUSET_ENGINE` selects the
 * default engine and hides a `VLAB_ENGINE`, exactly as an empty `VLAB_ENGINE`
 * did before.
 */
export const ENVIRONMENT_PREFIX = "CAUSET_";
export const LEGACY_ENVIRONMENT_PREFIX = "VLAB_";

/** Every user-facing variable, by the name after its prefix. */
export const ENVIRONMENT_VARIABLES = Object.freeze([
  "AGENT",
  "BENCHMARK_HOST",
  "CLI",
  "CLI_REPORT",
  "DELEGATE",
  "ENGINE",
  "FORECAST_ENGINE",
  "GIT_SESSION",
  "GIT_SESSION_DIAGNOSTICS",
  "GIT_SESSION_DIAGNOSTICS_FILE",
  "JS_CLI",
  "LAUNCHER",
  "RELEASE_SET",
  "REQUIRE_NATIVE",
  "TRACE",
]);

function known(name) {
  if (!ENVIRONMENT_VARIABLES.includes(name)) {
    throw new TypeError(`'${name}' is not a published causet environment variable.`);
  }
  return name;
}

/** The value of `CAUSET_<name>`, else `VLAB_<name>`, else undefined. */
export function environmentValue(name, env = process.env) {
  const current = env[`${ENVIRONMENT_PREFIX}${known(name)}`];
  return current !== undefined ? current : env[`${LEGACY_ENVIRONMENT_PREFIX}${name}`];
}

/** Select a value for this process and its children; it wins over both names. */
export function setEnvironmentValue(name, value, env = process.env) {
  env[`${ENVIRONMENT_PREFIX}${known(name)}`] = value;
}

/** The legacy variables whose values are being read, because no new name hides them. */
export function legacyVariablesInUse(env = process.env) {
  return ENVIRONMENT_VARIABLES
    .filter((name) => env[`${LEGACY_ENVIRONMENT_PREFIX}${name}`] !== undefined
      && env[`${ENVIRONMENT_PREFIX}${name}`] === undefined)
    .map((name) => `${LEGACY_ENVIRONMENT_PREFIX}${name}`);
}
