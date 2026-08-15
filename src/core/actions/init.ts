/**
 * Init action — pure business logic extracted from the init command.
 *
 * All interactive prompts go through the PromptProvider interface so that
 * the TUI can supply OpenTUI form components while headless mode uses
 * @inquirer/prompts.
 */

import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  type AuthMode,
  configExists,
  DEFAULT_CONFIG,
  DEFAULT_INSTANCE_CONFIG,
  ensureOutputFolders,
  findProjectRoot,
  generateConfigTemplate,
  getConfigPath,
  getOutputPaths,
  type InstanceConfig,
  loadConfig,
} from "../config.js";
import { generateClientFiles } from "../generator.js";
import { ensureGitignoreEntry } from "./env-manager.js";
import {
  generateDefineSurfaceContent,
  generateSurfaceRegistryContent,
  generateSurfaceComponentsContent,
  generateSurfaceDefinitionsGenContent,
  generateSurfaceIndexContent,
  generateDefinePanelContent,
  generatePanelTypesContent,
  generateUseSidepanelContent,
  generateSidepanelContainerContent,
  generateSidepanelLayoutContent,
  generatePanelDefinitionsGenContent,
  generatePanelIndexContent,
  generateUseMobileHookContent,
} from "../vite-plugin-templates.js";
import {
  commandExists,
  detectPackageManager,
  getDlxCommand,
  getInstallCommand,
  getRunCommand,
  resolveCommand,
  type PackageManager,
} from "../pm.js";

import type { Logger } from "../../adapters/logger-interface.js";
import type { ClientFilesResult } from "./types.js";

// ---------------------------------------------------------------------------
// PromptProvider interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over interactive prompts.
 * Implementations:
 *  - Headless: thin wrapper around @inquirer/prompts
 *  - TUI: OpenTUI form components that render in the terminal UI
 */
export interface PromptProvider {
  input(opts: {
    message: string;
    default?: string;
    validate?: (value: string) => string | true;
  }): Promise<string>;

  select<T>(opts: {
    message: string;
    choices: Array<{ name: string; value: T }>;
    default?: T;
  }): Promise<T>;

  confirm(opts: { message: string; default?: boolean }): Promise<boolean>;

  password(opts: { message: string; mask?: string }): Promise<string>;

  checkbox<T>(opts: {
    message: string;
    choices: Array<{ name: string; value: T }>;
  }): Promise<T[]>;
}

// ---------------------------------------------------------------------------
// Option / result interfaces
// ---------------------------------------------------------------------------

/** Options accepted by executeInit (mapped from CLI flags). */
export interface InitActionOptions {
  force: boolean;
  skipScripts: boolean;
  skipClient: boolean;
  skipConcurrent: boolean;
  skipWorkflow: boolean;
  withVitePlugins: boolean;
  baseUrlEnv: string;
  envAccessor: string;
  tokenKey: string;
  authMode: AuthMode;
  withCredentials: boolean;
  timeout: number;
  /**
   * Skip every interactive prompt and use defaults / supplied flags.
   * The spec source MUST be supplied via `specSource` (or via the
   * `--endpoint` / `--spec-file` flags on the CLI). Issue #43.
   */
  nonInteractive?: boolean;
  /** Spec source — required in non-interactive mode. */
  specSource?:
    | { kind: "remote"; endpoint: string }
    | { kind: "local"; specFile: string };
  /** Output folder override (skips the prompt). */
  outputFolder?: string;
  /** Package manager override (skips the prompt). Auto-detected when omitted. */
  packageManager?: PackageManager;
}

/** Structured result returned after a successful init. */
export interface InitResult {
  configCreated: boolean;
  scriptsAdded: string[];
  scriptsUpdated: string[];
  clientFilesCreated: ClientFilesResult;
  axiosInstalled: boolean;
  concurrentlyInstalled: boolean;
  concurrentScript: string | null;
  initialFetchSuccess: boolean | null;
  workflowCreated: boolean;
  surfacesScaffolded: boolean;
  sidepanelsScaffolded: boolean;
}

// ---------------------------------------------------------------------------
// Default npm scripts to add to package.json
// ---------------------------------------------------------------------------

export const DEFAULT_SCRIPTS: Record<string, string> = {
  "api:generate": "chowbea generate",
  "api:fetch": "chowbea fetch",
  "api:watch": "chowbea watch",
  "api:status": "chowbea status",
  "api:validate": "chowbea validate",
  "api:diff": "chowbea diff",
};

// ---------------------------------------------------------------------------
// Standalone helper functions (were private methods on the Command class)
// ---------------------------------------------------------------------------

/**
 * Detects existing setup files to notify user.
 * Does NOT auto-create any files — only checks what exists.
 */
export async function detectExistingSetup(
  projectRoot: string,
): Promise<string[]> {
  const found: string[] = [];

  const configPath = getConfigPath(projectRoot);
  const hasConfig = await configExists(configPath);
  if (hasConfig) {
    found.push("api.config.toml");
  }

  // Only check for client files if config exists (to avoid auto-creating config)
  if (hasConfig) {
    try {
      const { config } = await loadConfig();
      const outputPaths = getOutputPaths(config, projectRoot);

      try {
        await access(outputPaths.instance);
        found.push("api.instance.ts");
      } catch {
        /* Not found */
      }

      try {
        await access(outputPaths.client);
        found.push("api.client.ts");
      } catch {
        /* Not found */
      }
    } catch {
      // Config parsing failed — ignore
    }
  }

  return found;
}

/**
 * Checks if any of the given filenames exist in the project root.
 */
export async function hasFile(
  projectRoot: string,
  filenames: string[],
): Promise<boolean> {
  for (const filename of filenames) {
    try {
      await access(path.join(projectRoot, filename));
      return true;
    } catch {
      /* Not found */
    }
  }
  return false;
}

/**
 * Creates api.config.toml if it doesn't exist or if user confirms overwrite.
 * Returns true when the file was (over)written.
 */
/**
 * Returns true if the given string looks like a remote URL (has a
 * http/https/ftp scheme). Otherwise it's treated as a local file path.
 */
function isRemoteSpecUrl(value: string): boolean {
  return /^(https?|ftp):\/\//i.test(value.trim());
}

async function setupConfig(
  projectRoot: string,
  force: boolean,
  instanceConfig: InstanceConfig,
  specSource: { kind: "remote"; endpoint: string } | { kind: "local"; specFile: string },
  outputFolder: string,
  logger: Logger,
  prompts: PromptProvider,
): Promise<boolean> {
  const configPath = getConfigPath(projectRoot);
  const exists = await configExists(configPath);

  logger.step("config", "Creating api.config.toml...");

  if (exists) {
    if (force) {
      logger.info("Overwriting existing config (--force)");
    } else {
      const shouldOverwrite = await prompts.confirm({
        message: "api.config.toml already exists. Overwrite?",
        default: false,
      });

      if (!shouldOverwrite) {
        logger.info("Skipping config creation");
        return false;
      }
    }
  }

  const configContent = generateConfigTemplate({
    api_endpoint:
      specSource.kind === "remote" ? specSource.endpoint : undefined,
    spec_file:
      specSource.kind === "local" ? specSource.specFile : undefined,
    poll_interval_ms: 10_000,
    output: { folder: outputFolder },
    instance: instanceConfig,
    watch: { debug: false },
  });
  await writeFile(configPath, configContent, "utf8");
  logger.info({ path: configPath }, "Created api.config.toml");
  return true;
}

/**
 * Ensures axios is installed as a dependency.
 * Returns true when it was freshly installed.
 */
async function ensureAxios(
  projectRoot: string,
  pm: PackageManager,
  logger: Logger,
): Promise<boolean> {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const deps = (packageJson.dependencies ?? {}) as Record<string, string>;

  if (deps.axios) {
    logger.info("axios already installed");
    return false;
  }

  logger.step("deps", "Installing axios...");

  // Drop `shell: true` (deprecated by Node 24 / DEP0190); resolveCommand
  // handles the Windows `.cmd` shim path. Issue #16.
  const [cmd, ...args] = getInstallCommand(pm, "axios");
  const result = spawnSync(resolveCommand(cmd), args, {
    cwd: projectRoot,
    stdio: "pipe",
    timeout: 60_000,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    const stdout = result.stdout?.toString().trim();
    if (stderr) logger.debug(stderr);
    if (stdout) logger.debug(stdout);
    logger.warn("Failed to install axios - please install it manually");
    return false;
  }

  // Verify it was actually installed
  try {
    await access(path.join(projectRoot, "node_modules", "axios", "package.json"));
    logger.info("axios installed");
    return true;
  } catch {
    logger.warn("axios install reported success but package not found in node_modules");
    return false;
  }
}

/**
 * Adds npm scripts to package.json.
 * Returns arrays of added and updated script names.
 */
async function setupScripts(
  projectRoot: string,
  force: boolean,
  logger: Logger,
  prompts: PromptProvider,
): Promise<{ added: string[]; updated: string[] }> {
  const packageJsonPath = path.join(projectRoot, "package.json");

  logger.step("scripts", "Setting up npm scripts...");

  let packageJson: Record<string, unknown>;
  try {
    const content = await readFile(packageJsonPath, "utf8");
    packageJson = JSON.parse(content);
  } catch (error) {
    logger.error("Could not read package.json");
    throw error;
  }

  if (!packageJson.scripts || typeof packageJson.scripts !== "object") {
    packageJson.scripts = {};
  }

  const scripts = packageJson.scripts as Record<string, string>;

  const toAdd: string[] = [];
  const toUpdate: string[] = [];

  for (const [name, command] of Object.entries(DEFAULT_SCRIPTS)) {
    if (!(name in scripts)) {
      toAdd.push(name);
    } else if (scripts[name] !== command) {
      toUpdate.push(name);
    }
  }

  if (toAdd.length === 0 && toUpdate.length === 0) {
    logger.info("All npm scripts already configured");
    return { added: [], updated: [] };
  }

  if (toAdd.length > 0) {
    logger.info({ scripts: toAdd }, "Scripts to add");
  }

  if (toUpdate.length > 0) {
    logger.info({ scripts: toUpdate }, "Scripts that differ from defaults");

    if (!force) {
      const shouldUpdate = await prompts.confirm({
        message: `Update ${toUpdate.length} existing script(s) to chowbea defaults?`,
        default: false,
      });

      if (!shouldUpdate) {
        // Only add new scripts, don't update existing
        toUpdate.length = 0;
      }
    }
  }

  for (const name of toAdd) {
    scripts[name] = DEFAULT_SCRIPTS[name];
  }

  for (const name of toUpdate) {
    scripts[name] = DEFAULT_SCRIPTS[name];
  }

  await writeFile(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + "\n",
    "utf8",
  );

  logger.info(
    { added: toAdd.length, updated: toUpdate.length },
    "Updated package.json scripts",
  );

  return { added: toAdd, updated: toUpdate };
}

/**
 * Generates client files (api.instance.ts, api.error.ts, api.client.ts).
 */
async function setupClientFiles(
  projectRoot: string,
  instanceConfig: InstanceConfig,
  force: boolean,
  logger: Logger,
): Promise<ClientFilesResult> {
  logger.step("client", "Generating client files...");

  const { config } = await loadConfig();
  const outputPaths = getOutputPaths(config, projectRoot);

  await ensureOutputFolders(outputPaths);

  const result = await generateClientFiles({
    paths: outputPaths,
    instanceConfig,
    logger,
    force,
  });

  if (result.helpers || result.instance || result.error || result.client) {
    logger.info("Client files created:");
    if (result.helpers) logger.info(`  - ${outputPaths.helpers}`);
    if (result.instance) logger.info(`  - ${outputPaths.instance}`);
    if (result.error) logger.info(`  - ${outputPaths.error}`);
    if (result.client) logger.info(`  - ${outputPaths.client}`);
  } else {
    logger.info("Client files already exist (use --force to regenerate)");
  }

  return result;
}

/**
 * Ensures concurrently is installed as a dev dependency.
 * Returns true when it was freshly installed.
 */
async function ensureConcurrently(
  projectRoot: string,
  pm: PackageManager,
  logger: Logger,
): Promise<boolean> {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const devDeps = (packageJson.devDependencies ?? {}) as Record<string, string>;

  if (devDeps.concurrently) {
    logger.debug("concurrently already installed");
    return false;
  }

  logger.step("deps", "Installing concurrently...");

  // Drop `shell: true` (deprecated by Node 24 / DEP0190); resolveCommand
  // handles the Windows `.cmd` shim path. Issue #16.
  const [cmd, ...args] = getInstallCommand(pm, "concurrently", true);
  const result = spawnSync(resolveCommand(cmd), args, {
    cwd: projectRoot,
    stdio: "pipe",
    timeout: 60_000,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    const stdout = result.stdout?.toString().trim();
    if (stderr) logger.debug(stderr);
    if (stdout) logger.debug(stdout);
    logger.warn(
      `Failed to install concurrently (exit ${result.status}) - you may need to install it manually`,
    );
    return false;
  }

  // Verify it was actually installed
  try {
    await access(path.join(projectRoot, "node_modules", "concurrently", "package.json"));
    logger.info("concurrently installed");
    return true;
  } catch {
    logger.warn("concurrently install reported success but package not found in node_modules");
    return false;
  }
}

/**
 * Sets up a concurrent watch script combining api:watch with user-selected
 * dev scripts.  Uses concurrently to run multiple scripts in parallel.
 *
 * Returns the script alias that was created, or null if skipped.
 */
async function setupConcurrentlyScript(
  projectRoot: string,
  pm: PackageManager,
  logger: Logger,
  prompts: PromptProvider,
): Promise<{ scriptAlias: string | null; installed: boolean }> {
  const wantsConcurrent = await prompts.confirm({
    message:
      "Would you like to create a script that runs api:watch alongside your dev server?",
    default: true,
  });

  if (!wantsConcurrent) {
    logger.info("Skipped concurrent script setup");
    return { scriptAlias: null, installed: false };
  }

  const scriptAlias = await prompts.input({
    message: "Enter a name for the concurrent script:",
    default: "dev:all",
    validate: (value) => {
      if (!value.trim()) return "Script name is required";
      if (!/^[a-z][a-z0-9:_-]*$/i.test(value)) return "Invalid script name";
      return true;
    },
  });

  // Read package.json to get existing scripts
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const scripts = ((packageJson.scripts ?? {}) as Record<string, string>);

  // Filter out api:* scripts and the new alias itself
  const userScripts = Object.keys(scripts).filter(
    (name) => !name.startsWith("api:") && name !== scriptAlias,
  );

  if (userScripts.length === 0) {
    logger.warn("No other scripts found to run concurrently");
    return { scriptAlias: null, installed: false };
  }

  // Let user select which scripts to include
  const selectedScripts = await prompts.checkbox<string>({
    message: "Select scripts to run alongside api:watch:",
    choices: userScripts.map((name) => ({
      name: `${name}: ${scripts[name].slice(0, 50)}${
        scripts[name].length > 50 ? "..." : ""
      }`,
      value: name,
    })),
  });

  if (selectedScripts.length === 0) {
    logger.info("No scripts selected, skipping concurrent setup");
    return { scriptAlias: null, installed: false };
  }

  // Collect short labels for each selected script
  const labels: Record<string, string> = { "api:watch": "api" };

  for (const scriptName of selectedScripts) {
    const defaultLabel = scriptName
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 6)
      .toLowerCase();
    const label = await prompts.input({
      message: `Short label for "${scriptName}" (shown in terminal output):`,
      default: defaultLabel || "cmd",
      validate: (value) => {
        if (!value.trim()) return "Label is required";
        if (!/^[a-zA-Z0-9_-]+$/.test(value.trim()))
          return "Label must contain only letters, numbers, dashes, or underscores";
        return true;
      },
    });
    labels[scriptName] = label.trim();
  }

  const runCmd = getRunCommand(pm);

  // Build the concurrently command
  const allScripts = ["api:watch", ...selectedScripts];
  const names = allScripts.map((s) => labels[s]).join(",");
  const commands = allScripts.map((s) => `"${runCmd} ${s}"`).join(" ");
  const concurrentlyCmd = `concurrently --names '${names}' ${commands}`;

  // Write updated package.json
  scripts[scriptAlias] = concurrentlyCmd;
  packageJson.scripts = scripts;

  await writeFile(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + "\n",
    "utf8",
  );
  logger.info({ script: scriptAlias, pm }, "Created concurrent script");

  // Ensure concurrently is installed
  const installed = await ensureConcurrently(projectRoot, pm, logger);

  return { scriptAlias, installed };
}

/**
 * Runs initial fetch to download spec and generate types.
 * Returns true on success, false on failure.
 */
async function runInitialFetch(
  projectRoot: string,
  pm: PackageManager,
  logger: Logger,
): Promise<boolean> {
  logger.step("fetch", "Fetching OpenAPI spec and generating types...");

  // Drop `shell: true` (deprecated by Node 24 / DEP0190); resolveCommand
  // handles the Windows `.cmd` shim path. Issue #16.
  const [cmd, ...dlxArgs] = getDlxCommand(pm);
  const result = spawnSync(resolveCommand(cmd), [...dlxArgs, "chowbea", "fetch"], {
    cwd: projectRoot,
    stdio: "pipe",
  });

  const runCmd = getRunCommand(pm);
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    if (stderr) logger.debug(stderr);
    logger.warn(
      `Initial fetch failed - you can run '${runCmd} api:fetch' later`,
    );
    return false;
  }

  logger.info("Types generated successfully");
  return true;
}

// ---------------------------------------------------------------------------
// Vite plugin scaffolding
// ---------------------------------------------------------------------------

type VitePluginChoice = "both" | "surfaces" | "sidepanels" | "none";

/**
 * Write a file only if it doesn't exist yet (or --force was used).
 * Returns true if the file was written.
 */
export async function writeIfNew(
  filePath: string,
  content: string,
  force: boolean,
  logger: Logger,
): Promise<boolean> {
  let exists = false;
  try {
    await access(filePath);
    exists = true;
  } catch {
    /* not found */
  }

  if (exists && !force) {
    logger.info(`Skipping ${path.basename(filePath)} (already exists)`);
    return false;
  }

  await writeFile(filePath, content, "utf8");
  logger.info(`Created ${path.basename(filePath)}`);
  return true;
}

/**
 * Scaffold Vite codegen plugin registry files into the user's project.
 * Only called when --with-vite-plugins is passed.
 */
export async function setupVitePlugins(
  projectRoot: string,
  force: boolean,
  logger: Logger,
  prompts: PromptProvider,
): Promise<{ surfacesScaffolded: boolean; sidepanelsScaffolded: boolean }> {
  // 1. Which plugins?
  const choice = await prompts.select<VitePluginChoice>({
    message: "Which Vite codegen plugins would you like to set up?",
    choices: [
      { name: "Both (Surfaces + Side Panels)", value: "both" },
      { name: "Surfaces only (modal dialogs / drawers)", value: "surfaces" },
      { name: "Side Panels only (slide-out panels)", value: "sidepanels" },
      { name: "None — skip this step", value: "none" },
    ],
    default: "both" as VitePluginChoice,
  });

  if (choice === "none") {
    logger.info("Skipped Vite plugin scaffolding");
    return { surfacesScaffolded: false, sidepanelsScaffolded: false };
  }

  const wantsSurfaces = choice === "both" || choice === "surfaces";
  const wantsSidepanels = choice === "both" || choice === "sidepanels";

  // 2. Import prefix
  const importPrefix = await prompts.input({
    message: "What import alias does your project use?",
    default: "@/",
    validate: (v) =>
      v.trim().length > 0 ? true : "Import prefix is required",
  });

  // 3. Directories
  let surfacesDir = "";
  let sidepanelsDir = "";

  if (wantsSurfaces) {
    surfacesDir = await prompts.input({
      message: "Surfaces directory (relative to project root):",
      default: "src/components/surfaces",
    });
  }

  if (wantsSidepanels) {
    sidepanelsDir = await prompts.input({
      message: "Side panels directory (relative to project root):",
      default: "src/components/side-panels",
    });
  }

  // 4. Scaffold surfaces registry
  let surfacesScaffolded = false;
  if (wantsSurfaces) {
    logger.step("surfaces", "Scaffolding surfaces registry...");
    const registryDir = path.join(projectRoot, surfacesDir, "_registry");
    await mkdir(registryDir, { recursive: true });

    await writeIfNew(
      path.join(registryDir, "define-surface.ts"),
      generateDefineSurfaceContent(),
      force,
      logger,
    );
    await writeIfNew(
      path.join(registryDir, "surface.registry.ts"),
      generateSurfaceRegistryContent(),
      force,
      logger,
    );
    await writeIfNew(
      path.join(registryDir, "surface.tsx"),
      generateSurfaceComponentsContent(importPrefix),
      force,
      logger,
    );
    await writeIfNew(
      path.join(registryDir, "surface-definitions.gen.ts"),
      generateSurfaceDefinitionsGenContent(),
      force,
      logger,
    );
    await writeIfNew(
      path.join(registryDir, "index.ts"),
      generateSurfaceIndexContent(),
      force,
      logger,
    );
    surfacesScaffolded = true;
  }

  // 5. Scaffold sidepanels registry
  let sidepanelsScaffolded = false;
  if (wantsSidepanels) {
    logger.step("sidepanels", "Scaffolding side panels registry...");
    const registryDir = path.join(projectRoot, sidepanelsDir, "_registry");
    await mkdir(registryDir, { recursive: true });

    await writeIfNew(
      path.join(registryDir, "define-panel.ts"),
      generateDefinePanelContent(),
      force,
      logger,
    );
    await writeIfNew(
      path.join(registryDir, "types.ts"),
      generatePanelTypesContent(),
      force,
      logger,
    );
    await writeIfNew(
      path.join(registryDir, "use-sidepanel.ts"),
      generateUseSidepanelContent(),
      force,
      logger,
    );
    await writeIfNew(
      path.join(registryDir, "sidepanel.container.tsx"),
      generateSidepanelContainerContent(importPrefix),
      force,
      logger,
    );
    await writeIfNew(
      path.join(registryDir, "sidepanel.layout.tsx"),
      generateSidepanelLayoutContent(importPrefix),
      force,
      logger,
    );
    await writeIfNew(
      path.join(registryDir, "panel-definitions.gen.ts"),
      generatePanelDefinitionsGenContent(),
      force,
      logger,
    );
    await writeIfNew(
      path.join(registryDir, "index.ts"),
      generatePanelIndexContent(),
      force,
      logger,
    );
    sidepanelsScaffolded = true;
  }

  // 6. Generate use-mobile hook (needed by surfaces + sidepanel layout)
  if (wantsSurfaces || wantsSidepanels) {
    const hooksDir = path.join(projectRoot, "src", "hooks");
    const hookPath = path.join(hooksDir, "use-mobile.ts");
    await mkdir(hooksDir, { recursive: true });
    await writeIfNew(hookPath, generateUseMobileHookContent(), force, logger);
  }

  // 7. Log dependency info
  logger.step("deps", "Required dependencies:");
  logger.info("  zustand                          (state management)");
  if (wantsSidepanels) {
    logger.info("  zod                              (param validation)");
    logger.info(
      "  @hugeicons/core-free-icons       (panel icons)",
    );
    logger.info(
      "  @hugeicons/react                 (icon renderer)",
    );
    logger.info(
      "  @tanstack/react-router           (route params)",
    );
  }

  logger.info("");
  logger.step("shadcn", "Required shadcn components:");
  if (wantsSurfaces) {
    logger.info(
      "  npx shadcn@latest add button dialog drawer alert-dialog scroll-area",
    );
  }
  if (wantsSidepanels) {
    logger.info("  npx shadcn@latest add button select empty");
  }

  // 8. Log vite.config.ts instructions
  logger.info("");
  logger.step("vite", "Add to your vite.config.ts:");
  const pluginImports: string[] = [];
  const pluginCalls: string[] = [];
  if (wantsSurfaces) {
    pluginImports.push("surfacesCodegen");
    pluginCalls.push(
      surfacesDir === "src/components/surfaces"
        ? "surfacesCodegen()"
        : `surfacesCodegen({ directory: '${surfacesDir}' })`,
    );
  }
  if (wantsSidepanels) {
    pluginImports.push("sidepanelsCodegen");
    pluginCalls.push(
      sidepanelsDir === "src/components/side-panels"
        ? "sidepanelsCodegen()"
        : `sidepanelsCodegen({ directory: '${sidepanelsDir}' })`,
    );
  }
  logger.info(
    `  import { ${pluginImports.join(", ")} } from 'chowbea/vite'`,
  );
  logger.info(
    `  plugins: [${pluginCalls.join(", ")}, ...]`,
  );

  return { surfacesScaffolded, sidepanelsScaffolded };
}

// ---------------------------------------------------------------------------
// Main action entry point
// ---------------------------------------------------------------------------

/**
 * Scaffold GitHub Actions workflow for validating generated code in PRs.
 */
async function setupWorkflow(
  projectRoot: string,
  force: boolean,
  logger: Logger,
  prompts: PromptProvider,
): Promise<boolean> {
  const wantsWorkflow = await prompts.confirm({
    message:
      "Add a GitHub Actions workflow to validate generated code in PRs?",
    default: true,
  });

  if (!wantsWorkflow) {
    logger.info("Skipped CI workflow setup");
    return false;
  }

  const workflowDir = path.join(projectRoot, ".github", "workflows");
  const workflowPath = path.join(workflowDir, "chowbea-axios-ci.yml");

  let exists = false;
  try {
    await access(workflowPath);
    exists = true;
  } catch {
    /* not found */
  }

  if (exists && !force) {
    const shouldOverwrite = await prompts.confirm({
      message: "chowbea-axios-ci.yml already exists. Overwrite?",
      default: false,
    });
    if (!shouldOverwrite) {
      logger.info("Skipping workflow creation");
      return false;
    }
  }

  logger.step("workflow", "Creating GitHub Actions workflow...");

  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const templatePath = path.resolve(
    thisDir,
    "..",
    "..",
    "..",
    "templates",
    "chowbea-axios-ci.yml",
  );
  const template = await readFile(templatePath, "utf8");

  await mkdir(workflowDir, { recursive: true });
  await writeFile(workflowPath, template, "utf8");
  logger.info(`Created ${workflowPath}`);
  logger.info(
    "Set STAGING_API_ENDPOINT in your GitHub repository secrets",
  );

  return true;
}

/**
 * Append chowbea gitignore entries if not already present.
 */
async function ensureGitignoreEntries(
  projectRoot: string,
  logger: Logger,
): Promise<void> {
  const entry = "_internal/";
  const added = await ensureGitignoreEntry(
    projectRoot,
    entry,
    "# chowbea cache (timestamps, downloaded specs)",
  );
  if (added) {
    logger.step("gitignore", `Added ${entry} to .gitignore`);
  }
}

/**
 * Execute the init workflow.
 *
 * Pure function — all side-effects (prompts, logging, fs, child_process)
 * are injected via parameters so that the action can be driven by any UI.
 */
export async function executeInit(
  options: InitActionOptions,
  logger: Logger,
  prompts: PromptProvider,
): Promise<InitResult> {
  logger.header("chowbea init");

  // Find project root
  logger.step("config", "Finding project root...");
  const projectRoot = await findProjectRoot();
  logger.info(projectRoot);

  // Check for existing setup and notify user
  const existingSetup = await detectExistingSetup(projectRoot);
  if (existingSetup.length > 0 && !options.force) {
    logger.step("detect", "Existing setup detected");
    for (const item of existingSetup) {
      logger.info(item);
    }
    const shouldContinue = await prompts.confirm({
      message: "Continue with setup? (existing files may be modified)",
      default: true,
    });
    if (!shouldContinue) {
      logger.info("Setup cancelled");
      return {
        configCreated: false,
        scriptsAdded: [],
        scriptsUpdated: [],
        clientFilesCreated: {
          helpers: false,
          instance: false,
          error: false,
          client: false,
        },
        axiosInstalled: false,
        concurrentlyInstalled: false,
        concurrentScript: null,
        initialFetchSuccess: null,
        workflowCreated: false,
        surfacesScaffolded: false,
        sidepanelsScaffolded: false,
      };
    }
  }

  // Prompt for spec source — accepts either a remote URL or a local file path.
  // The answer is auto-classified by shape: http(s)://... → remote endpoint;
  // anything else → local file path (spec_file in config).
  // Non-interactive mode: use options.specSource or fail with a clear
  // message naming the missing flag. Issue #43.
  let specSource:
    | { kind: "remote"; endpoint: string }
    | { kind: "local"; specFile: string };
  if (options.nonInteractive) {
    if (!options.specSource) {
      throw new Error(
        "--non-interactive requires a spec source. Pass --endpoint <url> or --spec-file <path>.",
      );
    }
    specSource = options.specSource;
  } else {
    const specInput = await prompts.input({
      message:
        "Enter your OpenAPI spec URL (http://...) or local file path (./openapi.json):",
      default: DEFAULT_CONFIG.api_endpoint,
      validate: (value) =>
        value.trim().length > 0
          ? true
          : "A spec URL or local file path is required",
    });
    specSource = isRemoteSpecUrl(specInput)
      ? { kind: "remote", endpoint: specInput.trim() }
      : { kind: "local", specFile: specInput.trim() };
  }

  // Prompt for output folder location (or use supplied/default in
  // non-interactive mode).
  const outputFolder = options.nonInteractive
    ? options.outputFolder ?? DEFAULT_CONFIG.output.folder
    : await prompts.input({
        message: "Where should generated API files be placed?",
        default: DEFAULT_CONFIG.output.folder,
        validate: (value) =>
          value.trim().length > 0 ? true : "Output folder is required",
      });

  // Detect package manager and confirm with user (or use supplied/auto-
  // detected in non-interactive mode).
  const detectedPm = await detectPackageManager(projectRoot);
  const pm: PackageManager = options.nonInteractive
    ? options.packageManager ?? detectedPm
    : await prompts.select<PackageManager>({
        message: "Which package manager are you using?",
        choices: [
          { name: "pnpm", value: "pnpm" },
          { name: "npm", value: "npm" },
          { name: "yarn", value: "yarn" },
          { name: "bun", value: "bun" },
        ],
        default: detectedPm,
      });

  // Verify package manager binary exists
  if (!commandExists(pm)) {
    throw new Error(
      `Package manager "${pm}" not found in PATH. Please install it first.`,
    );
  }

  // Detect Vite project (used for env accessor and optional plugin scaffolding)
  const hasViteConfig = await hasFile(projectRoot, [
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mts",
  ]);

  // Auto-detect env accessor from framework config files
  let envAccessor = options.envAccessor;
  if (envAccessor === DEFAULT_INSTANCE_CONFIG.env_accessor) {
    if (hasViteConfig) {
      envAccessor = "import.meta.env";
      logger.info("Detected Vite project — using import.meta.env");
    }
  }

  // Prompt for auth mode (or use the flag-supplied default in non-
  // interactive mode).
  const authMode: AuthMode = options.nonInteractive
    ? options.authMode
    : await prompts.select<AuthMode>({
        message: "How should auth tokens be attached to requests?",
        choices: [
          {
            name: "Bearer token from localStorage (SPA pattern)",
            value: "bearer-localstorage",
          },
          {
            name: "Custom — I'll implement my own auth logic",
            value: "custom",
          },
          {
            name: "None — no auth interceptor needed",
            value: "none",
          },
        ],
        default: options.authMode,
      });

  // Build instance config from options and prompts
  let instanceConfig: InstanceConfig = {
    base_url_env: options.baseUrlEnv,
    env_accessor: envAccessor,
    token_key: options.tokenKey,
    auth_mode: authMode,
    with_credentials: options.withCredentials,
    timeout: options.timeout,
  };

  // Step 1: Create api.config.toml
  const configCreated = await setupConfig(
    projectRoot,
    options.force,
    instanceConfig,
    specSource,
    outputFolder,
    logger,
    prompts,
  );

  // If the user declined overwrite, reload the effective config from disk
  // so subsequent steps use the persisted settings, not the wizard answers.
  if (!configCreated) {
    try {
      const { config } = await loadConfig();
      instanceConfig = {
        base_url_env: config.instance.base_url_env,
        env_accessor: config.instance.env_accessor,
        token_key: config.instance.token_key,
        auth_mode: config.instance.auth_mode,
        with_credentials: config.instance.with_credentials,
        timeout: config.instance.timeout,
      };
    } catch {
      // Config parsing failed — continue with prompted values as fallback
    }
  }

  // Step 2: Install axios dependency
  const axiosInstalled = await ensureAxios(projectRoot, pm, logger);

  // Step 3: Add npm scripts to package.json
  let scriptsAdded: string[] = [];
  let scriptsUpdated: string[] = [];
  if (!options.skipScripts) {
    const scriptResult = await setupScripts(
      projectRoot,
      options.force,
      logger,
      prompts,
    );
    scriptsAdded = scriptResult.added;
    scriptsUpdated = scriptResult.updated;
  }

  // Step 4: Setup concurrent dev script (optional)
  let concurrentScript: string | null = null;
  let concurrentlyInstalled = false;
  if (!options.skipConcurrent) {
    const concurrentResult = await setupConcurrentlyScript(
      projectRoot,
      pm,
      logger,
      prompts,
    );
    concurrentScript = concurrentResult.scriptAlias;
    concurrentlyInstalled = concurrentResult.installed;
  }

  // Step 5: Generate client files
  let clientFilesCreated: ClientFilesResult = {
    helpers: false,
    instance: false,
    error: false,
    client: false,
  };
  if (!options.skipClient) {
    clientFilesCreated = await setupClientFiles(
      projectRoot,
      instanceConfig,
      options.force,
      logger,
    );
  }

  // Step 5.5: Set up Vite plugins (opt-in via --with-vite-plugins)
  let surfacesScaffolded = false;
  let sidepanelsScaffolded = false;
  if (options.withVitePlugins) {
    if (hasViteConfig) {
      const viteResult = await setupVitePlugins(
        projectRoot,
        options.force,
        logger,
        prompts,
      );
      surfacesScaffolded = viteResult.surfacesScaffolded;
      sidepanelsScaffolded = viteResult.sidepanelsScaffolded;
    } else {
      logger.warn(
        "--with-vite-plugins was set but no vite.config found. Skipping.",
      );
    }
  }

  // Step 6: Ensure _internal/ is in .gitignore
  await ensureGitignoreEntries(projectRoot, logger);

  // Step 7: Run initial fetch.
  // - Local spec_file: always safe to read, always run.
  // - Remote localhost: skip (user's dev server may not be running yet).
  // - Remote non-localhost: run.
  const isLocalhost =
    specSource.kind === "remote" &&
    (specSource.endpoint.includes("localhost") ||
      specSource.endpoint.includes("127.0.0.1"));
  let initialFetchSuccess: boolean | null = null;
  if (!isLocalhost) {
    initialFetchSuccess = await runInitialFetch(projectRoot, pm, logger);
  }

  // Step 8: Scaffold CI workflow (optional)
  let workflowCreated = false;
  if (!options.skipWorkflow) {
    workflowCreated = await setupWorkflow(
      projectRoot,
      options.force,
      logger,
      prompts,
    );
  }

  // Summary
  const runCmd = getRunCommand(pm);
  if (isLocalhost) {
    logger.done("Setup complete! When your API server is running:");
    logger.info(`${runCmd} api:fetch    # Fetch spec and generate types`);
  } else {
    logger.done("Setup complete!");
    logger.info(`${runCmd} api:status   # Check current status`);
    logger.info(`${runCmd} api:fetch    # Re-fetch spec and regenerate`);
    logger.info(`${runCmd} api:watch    # Watch for spec changes`);
  }

  return {
    configCreated,
    scriptsAdded,
    scriptsUpdated,
    clientFilesCreated,
    axiosInstalled,
    concurrentlyInstalled,
    concurrentScript,
    initialFetchSuccess,
    workflowCreated,
    surfacesScaffolded,
    sidepanelsScaffolded,
  };
}
