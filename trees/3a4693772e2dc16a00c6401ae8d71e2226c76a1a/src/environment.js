/**
 * The user-facing environment variables (ADR-0039 §5). Each is named
 * `CAUSET_<name>`. The former `VLAB_<name>` was read as a fallback during the
 * migration window, which has ended (ADR-0039 §8); it is ignored now.
 *
 * "Set" means present, even when empty: an empty `CAUSET_ENGINE` selects the
 * default engine.
 */
export const ENVIRONMENT_PREFIX = "CAUSET_";

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

/** The value of `CAUSET_<name>`, else undefined. */
export function environmentValue(name, env = process.env) {
  return env[`${ENVIRONMENT_PREFIX}${known(name)}`];
}

/** Select a value for this process and its children. */
export function setEnvironmentValue(name, value, env = process.env) {
  env[`${ENVIRONMENT_PREFIX}${known(name)}`] = value;
}
