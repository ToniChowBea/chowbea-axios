/**
 * Configuration loader with auto-create functionality.
 * Finds project root, loads api.config.toml, and auto-creates if missing.
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import toml from "toml";

import { ConfigError, ConfigValidationError } from "./errors.js";

/**
 * Auth configuration for fetching the OpenAPI spec.
 * Currently only supports Basic Auth.
 */
export interface FetchAuthConfig {
  /** Auth type — only "basic" is supported */
  type: "basic";
  /** Username (supports $VAR env var interpolation) */
  username?: string;
  /** Password (supports $VAR env var interpolation) */
  password?: string;
}

/**
 * Fetch configuration for remote spec retrieval.
 */
export interface FetchConfig {
  /** Headers to include when fetching the OpenAPI spec */
  headers?: Record<string, string>;
  /** Auth configuration for spec endpoint */
  auth?: FetchAuthConfig;
}

/**
 * Bus configuration for consuming a published Type Bus feed.
 */
export interface BusConfig {
  /** URL of the served chowbea.bus.json (conventionally /.well-known/chowbea.json). */
  endpoint: string;
}

/**
 * Watch mode configuration for controlling debug output.
 */
export interface WatchConfig {
  /** Enable debug logging in watch mode (shows cycle-by-cycle logs) */
  debug: boolean;
}

/**
 * Auth mode for the generated axios instance interceptor.
 * - "bearer-localstorage": reads token from localStorage and attaches as Bearer header (SPA pattern)
 * - "custom": generates a placeholder interceptor with a TODO comment
 * - "none": no auth interceptor at all
 */
export type AuthMode = "bearer-localstorage" | "custom" | "none";

/**
 * Instance configuration for the generated axios client.
 */
export interface InstanceConfig {
  /** Environment variable name for base URL (e.g., "API_BASE_URL") */
  base_url_env: string;
  /** How to access environment variables (e.g., "process.env" or "import.meta.env") */
  env_accessor: string;
  /** localStorage key for auth token (used when auth_mode is "bearer-localstorage") */
  token_key: string;
  /** Auth interceptor mode */
  auth_mode: AuthMode;
  /** Whether to include credentials (cookies) in requests */
  with_credentials: boolean;
  /** Request timeout in milliseconds */
  timeout: number;
}

/**
 * Configuration structure for api.config.toml
 */
export interface ApiConfig {
  /** Remote OpenAPI spec endpoint URL. Optional when `spec_file` is set. */
  api_endpoint?: string;
  /** Local spec file path (takes priority over api_endpoint if set) */
  spec_file?: string;
  /** Polling interval in milliseconds for watch mode */
  poll_interval_ms: number;
  /** Output configuration */
  output: {
    /** Folder where all generated files are written */
    folder: string;
  };
  /** Fetch configuration for remote spec retrieval */
  fetch?: FetchConfig;
  /** Bus configuration for consuming a published Type Bus feed */
  bus?: BusConfig;
  /** Instance configuration for the generated axios client */
  instance: InstanceConfig;
  /** Watch mode configuration */
  watch: WatchConfig;
}

/**
 * Default watch configuration values.
 */
export const DEFAULT_WATCH_CONFIG: WatchConfig = {
  debug: false,
};

/**
 * Default instance configuration values.
 *
 * `with_credentials` defaults to `false` — sending cookies cross-origin
 * is a footgun for cookie-based auth setups and not what most users
 * want. Cookie-auth users opt in explicitly. Issue #28.
 */
export const DEFAULT_INSTANCE_CONFIG: InstanceConfig = {
  base_url_env: "API_BASE_URL",
  env_accessor: "process.env",
  token_key: "auth-token",
  auth_mode: "custom",
  with_credentials: false,
  timeout: 30_000,
};

/**
 * Default configuration values used when auto-creating config.
 */
export const DEFAULT_CONFIG: ApiConfig = {
  api_endpoint: "http://localhost:3000/openapi.json",
  spec_file: undefined,
  poll_interval_ms: 10_000,
  output: {
    folder: "src/api",
  },
  fetch: undefined,
  bus: undefined,
  instance: DEFAULT_INSTANCE_CONFIG,
  watch: DEFAULT_WATCH_CONFIG,
};

/**
 * Encodes an arbitrary string for safe inclusion in a TOML basic string
 * value. JSON.stringify produces a strict subset of TOML basic-string
 * syntax (`\"`, `\\`, `\n`, `\t`, `\r`, `\uXXXX`), so any character a
 * user types — including `"`, `\`, control codes, non-ASCII — round-
 * trips through TOML safely. Issue #27.
 */
function tomlEscape(value: string): string {
  return JSON.stringify(value);
}

/**
 * Generates config file content from an ApiConfig object.
 * Single source of truth — used by both auto-create and init command.
 *
 * Every interpolated string flows through `tomlEscape` (`JSON.stringify`)
 * so values containing `"`, `\`, or control chars produce valid TOML
 * rather than a malformed file. Issue #27.
 */
export function generateConfigTemplate(config: ApiConfig): string {
  // Emit whichever spec source is configured as the active line, and the
  // other as a commented-out example.
  const fallbackEndpoint = config.api_endpoint ?? "https://api.example.com/openapi.json";
  const specSourceBlock = config.spec_file
    ? `# api_endpoint = ${tomlEscape(fallbackEndpoint)}  # Use remote endpoint instead of local file
spec_file = ${tomlEscape(config.spec_file)}`
    : `api_endpoint = ${tomlEscape(config.api_endpoint ?? "")}
# spec_file = "./openapi.json"  # Use local file instead of remote`;

  return `# Chowbea Axios Configuration

${specSourceBlock}
poll_interval_ms = ${config.poll_interval_ms}

[output]
folder = ${tomlEscape(config.output.folder)}

[instance]
base_url_env = ${tomlEscape(config.instance.base_url_env)}
env_accessor = ${tomlEscape(config.instance.env_accessor)}
token_key = ${tomlEscape(config.instance.token_key)}
auth_mode = ${tomlEscape(config.instance.auth_mode)}
with_credentials = ${config.instance.with_credentials}
timeout = ${config.instance.timeout}

# [fetch.auth]
# type = "basic"
# username = "$SWAGGER_USER"
# password = "$SWAGGER_PASS"

[watch]
debug = ${config.watch.debug}
`;
}

/**
 * Finds the project root by walking up to the nearest package.json.
 * Returns the directory containing package.json.
 */
export async function findProjectRoot(startDir?: string): Promise<string> {
  let currentDir = startDir ?? process.cwd();

  // Walk up the directory tree looking for package.json
  while (currentDir !== path.dirname(currentDir)) {
    const packageJsonPath = path.join(currentDir, "package.json");

    try {
      await access(packageJsonPath);
      return currentDir;
    } catch {
      // package.json not found, continue walking up
      currentDir = path.dirname(currentDir);
    }
  }

  // No package.json found, use the starting directory
  return startDir ?? process.cwd();
}

/**
 * Gets the path to api.config.toml relative to project root.
 */
export function getConfigPath(projectRoot: string): string {
  return path.join(projectRoot, "api.config.toml");
}

/**
 * Checks if a config file exists at the given path.
 */
export async function configExists(configPath: string): Promise<boolean> {
  try {
    await access(configPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a default config file at the specified path.
 */
export async function createDefaultConfig(configPath: string): Promise<void> {
  const configDir = path.dirname(configPath);

  // Ensure directory exists
  await mkdir(configDir, { recursive: true });

  // Write the config template generated from defaults
  await writeFile(configPath, generateConfigTemplate(DEFAULT_CONFIG), "utf8");
}

/**
 * Validates the watch configuration section.
 */
function validateWatchConfig(watch: unknown): WatchConfig {
  // If watch section is missing, use defaults
  if (watch === undefined || watch === null) {
    return DEFAULT_WATCH_CONFIG;
  }

  if (typeof watch !== "object") {
    throw new ConfigValidationError("watch", "watch section must be an object");
  }

  const w = watch as Record<string, unknown>;

  // Validate or use default for debug field
  const debug =
    typeof w.debug === "boolean" ? w.debug : DEFAULT_WATCH_CONFIG.debug;

  return { debug };
}

/**
 * Validates the instance configuration section.
 */
function validateInstanceConfig(instance: unknown): InstanceConfig {
  // If instance section is missing, use defaults
  if (instance === undefined || instance === null) {
    return DEFAULT_INSTANCE_CONFIG;
  }

  if (typeof instance !== "object") {
    throw new ConfigValidationError(
      "instance",
      "instance section must be an object"
    );
  }

  const inst = instance as Record<string, unknown>;

  // Validate or use defaults for each field
  const base_url_env =
    typeof inst.base_url_env === "string" && inst.base_url_env.trim().length > 0
      ? inst.base_url_env
      : DEFAULT_INSTANCE_CONFIG.base_url_env;

  const env_accessor =
    typeof inst.env_accessor === "string" && inst.env_accessor.trim().length > 0
      ? inst.env_accessor
      : DEFAULT_INSTANCE_CONFIG.env_accessor;

  const token_key =
    typeof inst.token_key === "string" && inst.token_key.trim().length > 0
      ? inst.token_key
      : DEFAULT_INSTANCE_CONFIG.token_key;

  const VALID_AUTH_MODES = ["bearer-localstorage", "custom", "none"];
  const auth_mode =
    typeof inst.auth_mode === "string" && VALID_AUTH_MODES.includes(inst.auth_mode)
      ? (inst.auth_mode as InstanceConfig["auth_mode"])
      : DEFAULT_INSTANCE_CONFIG.auth_mode;

  const with_credentials =
    typeof inst.with_credentials === "boolean"
      ? inst.with_credentials
      : DEFAULT_INSTANCE_CONFIG.with_credentials;

  const timeout =
    typeof inst.timeout === "number" && inst.timeout > 0
      ? inst.timeout
      : DEFAULT_INSTANCE_CONFIG.timeout;

  return { base_url_env, env_accessor, token_key, auth_mode, with_credentials, timeout };
}

/**
 * Validates the loaded configuration and throws descriptive errors.
 */
function validateConfig(config: unknown): ApiConfig {
  if (typeof config !== "object" || config === null) {
    throw new ConfigValidationError("root", "Configuration must be an object");
  }

  const cfg = config as Record<string, unknown>;

  // Validate spec source: at least one of api_endpoint or spec_file must be set.
  // spec_file takes priority at resolve time (see resolveSpecSource), so
  // api_endpoint is only required when spec_file is absent.
  const hasSpecFile =
    typeof cfg.spec_file === "string" && cfg.spec_file.trim().length > 0;
  const hasApiEndpoint =
    typeof cfg.api_endpoint === "string" &&
    cfg.api_endpoint.trim().length > 0;

  if (!hasSpecFile && !hasApiEndpoint) {
    throw new ConfigValidationError(
      "api_endpoint",
      "Configuration must set either api_endpoint (remote URL) or spec_file (local path)"
    );
  }
  if (cfg.api_endpoint !== undefined && !hasApiEndpoint) {
    throw new ConfigValidationError(
      "api_endpoint",
      "api_endpoint must be a non-empty string URL when provided"
    );
  }

  // Validate poll_interval_ms
  if (typeof cfg.poll_interval_ms !== "number" || cfg.poll_interval_ms < 1000) {
    throw new ConfigValidationError(
      "poll_interval_ms",
      "poll_interval_ms must be a number >= 1000"
    );
  }

  // Validate output section
  if (typeof cfg.output !== "object" || cfg.output === null) {
    throw new ConfigValidationError("output", "output section is required");
  }

  const output = cfg.output as Record<string, unknown>;

  if (typeof output.folder !== "string" || output.folder.trim().length === 0) {
    throw new ConfigValidationError(
      "output.folder",
      "output.folder must be a non-empty string path"
    );
  }

  // Validate spec_file if provided (optional)
  const spec_file =
    typeof cfg.spec_file === "string" && cfg.spec_file.trim().length > 0
      ? cfg.spec_file
      : undefined;

  // Validate fetch section if provided (optional)
  const fetchConfig = validateFetchConfig(cfg.fetch);

  // Validate bus section if provided (optional)
  const busConfig = validateBusConfig(cfg.bus);

  // Validate instance section (uses defaults if missing)
  const instance = validateInstanceConfig(cfg.instance);

  // Validate watch section (uses defaults if missing)
  const watch = validateWatchConfig(cfg.watch);

  return {
    api_endpoint: hasApiEndpoint ? (cfg.api_endpoint as string) : undefined,
    spec_file,
    poll_interval_ms: cfg.poll_interval_ms,
    output: {
      folder: output.folder,
    },
    fetch: fetchConfig,
    bus: busConfig,
    instance,
    watch,
  };
}

/**
 * Validates the fetch auth configuration section.
 */
function validateFetchAuthConfig(auth: unknown): FetchAuthConfig | undefined {
  if (auth === undefined || auth === null) {
    return;
  }

  if (typeof auth !== "object") {
    throw new ConfigValidationError("fetch.auth", "fetch.auth must be an object");
  }

  const authObj = auth as Record<string, unknown>;

  if (typeof authObj.type !== "string" || authObj.type !== "basic") {
    throw new ConfigValidationError(
      "fetch.auth.type",
      'fetch.auth.type must be "basic"'
    );
  }

  const username =
    typeof authObj.username === "string" && authObj.username.trim().length > 0
      ? authObj.username
      : undefined;

  const password =
    typeof authObj.password === "string" && authObj.password.trim().length > 0
      ? authObj.password
      : undefined;

  return { type: "basic", username, password };
}

/**
 * Validates the fetch configuration section.
 */
function validateFetchConfig(fetch: unknown): FetchConfig | undefined {
  // If fetch section is missing, return undefined
  if (fetch === undefined || fetch === null) {
    return;
  }

  if (typeof fetch !== "object") {
    throw new ConfigValidationError("fetch", "fetch section must be an object");
  }

  const fetchObj = fetch as Record<string, unknown>;

  // Validate headers if provided
  let headers: Record<string, string> | undefined;
  if (fetchObj.headers !== undefined && fetchObj.headers !== null) {
    if (typeof fetchObj.headers !== "object") {
      throw new ConfigValidationError(
        "fetch.headers",
        "fetch.headers must be an object"
      );
    }

    const headersObj = fetchObj.headers as Record<string, unknown>;
    headers = {};

    for (const [key, value] of Object.entries(headersObj)) {
      if (typeof value !== "string") {
        throw new ConfigValidationError(
          `fetch.headers.${key}`,
          "header value must be a string"
        );
      }
      headers[key] = value;
    }
  }

  // Validate auth if provided
  const auth = validateFetchAuthConfig(fetchObj.auth);

  if (!headers && !auth) {
    return;
  }

  return { ...(headers ? { headers } : {}), ...(auth ? { auth } : {}) };
}

/**
 * Validates the bus configuration section.
 */
function validateBusConfig(bus: unknown): BusConfig | undefined {
  // If bus section is missing, return undefined (feature inert)
  if (bus === undefined || bus === null) {
    return undefined;
  }

  if (typeof bus !== "object") {
    throw new ConfigValidationError("bus", "bus section must be an object");
  }

  const busObj = bus as Record<string, unknown>;

  if (typeof busObj.endpoint !== "string" || busObj.endpoint.trim() === "") {
    throw new ConfigValidationError(
      "bus.endpoint",
      "bus.endpoint must be a non-empty string"
    );
  }

  return { endpoint: busObj.endpoint };
}

/**
 * Spec source types for determining where to load the spec from.
 */
export type SpecSource =
  | { type: "local"; path: string }
  | { type: "remote"; endpoint: string };

/**
 * Resolves the spec source based on config and flag overrides.
 * Priority: flag > config spec_file > config api_endpoint
 */
export function resolveSpecSource(
  config: ApiConfig,
  projectRoot: string,
  flagSpecFile?: string
): SpecSource {
  // Flag takes highest priority
  if (flagSpecFile) {
    const resolvedPath = path.isAbsolute(flagSpecFile)
      ? flagSpecFile
      : path.join(projectRoot, flagSpecFile);
    return { type: "local", path: resolvedPath };
  }

  // Config spec_file takes second priority
  if (config.spec_file) {
    const resolvedPath = path.isAbsolute(config.spec_file)
      ? config.spec_file
      : path.join(projectRoot, config.spec_file);
    return { type: "local", path: resolvedPath };
  }

  // Default to remote endpoint. Validator guarantees api_endpoint is present
  // whenever spec_file is absent, but we guard here for defense-in-depth.
  if (!config.api_endpoint) {
    throw new Error(
      "No spec source configured: set either api_endpoint or spec_file in api.config.toml"
    );
  }
  return { type: "remote", endpoint: config.api_endpoint };
}

/**
 * Options for `loadConfig`.
 */
export interface LoadConfigOptions {
  /**
   * When true and the config file is missing, create one with defaults.
   * Defaults to false — only `init` should create config; other commands
   * fail loudly when config is absent so CI/non-interactive runs don't
   * silently use a localhost endpoint. Issue #39.
   */
  autoCreate?: boolean;
}

/**
 * Loads and parses the configuration file.
 *
 * By default, throws `ConfigError` when the file is missing — call sites
 * that legitimately want to create one (only `init`) opt in via
 * `{ autoCreate: true }`. This prevents commands like `fetch`/`generate`
 * from silently writing a default config in CI environments where a
 * missing file should be a hard error. Issue #39.
 */
export async function loadConfig(
  configPath?: string,
  options: LoadConfigOptions = {},
): Promise<{
  config: ApiConfig;
  projectRoot: string;
  configPath: string;
  wasCreated: boolean;
}> {
  // Find project root
  const projectRoot = await findProjectRoot();
  const resolvedConfigPath = configPath ?? getConfigPath(projectRoot);

  // Check if config exists
  const exists = await configExists(resolvedConfigPath);

  if (!exists) {
    if (!options.autoCreate) {
      throw new ConfigError(
        `No api.config.toml found at ${resolvedConfigPath}`,
        "Run 'chowbea init' to create one.",
      );
    }
    // Auto-create config with defaults (init only)
    await createDefaultConfig(resolvedConfigPath);

    return {
      config: DEFAULT_CONFIG,
      projectRoot,
      configPath: resolvedConfigPath,
      wasCreated: true,
    };
  }

  // Load and parse existing config
  try {
    const content = await readFile(resolvedConfigPath, "utf8");
    const parsed = toml.parse(content);
    const config = validateConfig(parsed);

    return {
      config,
      projectRoot,
      configPath: resolvedConfigPath,
      wasCreated: false,
    };
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw error;
    }

    if (error instanceof Error && error.message.includes("Unexpected")) {
      throw new ConfigError(
        `Failed to parse api.config.toml: ${error.message}`,
        "Check your TOML syntax. Run 'chowbea init --force' to regenerate with defaults."
      );
    }

    throw new ConfigError(
      `Failed to load config: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Resolves the output folder path to an absolute path.
 */
export function resolveOutputFolder(
  config: ApiConfig,
  projectRoot: string
): string {
  return path.isAbsolute(config.output.folder)
    ? config.output.folder
    : path.join(projectRoot, config.output.folder);
}

/**
 * Output paths for all generated files.
 */
export interface OutputPaths {
  /** Root output folder */
  folder: string;
  /** _internal folder for cache files */
  internal: string;
  /** _generated folder for auto-generated code */
  generated: string;
  /** Path to api.types.ts (generated types) */
  types: string;
  /** Path to api.operations.ts (generated operations) */
  operations: string;
  /** Path to api.contracts.ts (concrete type contracts - always overwritten) */
  contracts: string;
  /** Path to api.helpers.ts (utility types - generated once) */
  helpers: string;
  /** Path to openapi.json spec file */
  spec: string;
  /** Path to .api-cache.json */
  cache: string;
  /** Path to api.instance.ts (axios instance - generated once) */
  instance: string;
  /** Path to api.error.ts (error handling - generated once) */
  error: string;
  /** Path to api.client.ts (typed facade - generated once) */
  client: string;
  /** Path to the bus output directory (generated bus artifacts) */
  busDir: string;
  /** Path to chowbea.bus.json (bus cache) */
  busCache: string;
}

/**
 * Gets paths for all generated files based on config.
 */
export function getOutputPaths(
  config: ApiConfig,
  projectRoot: string
): OutputPaths {
  const folder = resolveOutputFolder(config, projectRoot);
  const internal = path.join(folder, "_internal");
  const generated = path.join(folder, "_generated");

  return {
    folder,
    internal,
    generated,
    // _internal/ files (always overwritten)
    spec: path.join(internal, "openapi.json"),
    cache: path.join(internal, ".api-cache.json"),
    // _generated/ files (always overwritten)
    types: path.join(generated, "api.types.ts"),
    operations: path.join(generated, "api.operations.ts"),
    contracts: path.join(generated, "api.contracts.ts"),
    // Root files (generated once, user-editable)
    helpers: path.join(folder, "api.helpers.ts"),
    instance: path.join(folder, "api.instance.ts"),
    error: path.join(folder, "api.error.ts"),
    client: path.join(folder, "api.client.ts"),
    busDir: path.join(generated, "bus"),
    busCache: path.join(internal, "chowbea.bus.json"),
  };
}

/**
 * Ensures the output folder and subfolders exist, creating them if necessary.
 */
export async function ensureOutputFolder(outputFolder: string): Promise<void> {
  await mkdir(outputFolder, { recursive: true });
}

/**
 * Ensures all output folders exist (_internal, _generated, and root).
 */
export async function ensureOutputFolders(paths: OutputPaths): Promise<void> {
  await mkdir(paths.internal, { recursive: true });
  await mkdir(paths.generated, { recursive: true });
}
