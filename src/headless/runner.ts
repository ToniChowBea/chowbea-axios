/**
 * Headless command runner -- replaces oclif's command dispatch for CI/scripting.
 *
 * Parses CLI arguments using node:util parseArgs, routes to the appropriate
 * core action, and renders output with the headless logger + formatters.
 */

import { parseArgs } from "node:util";

import { createLogger } from "../adapters/headless-logger.js";
import { getLogLevel } from "../adapters/logger-interface.js";
import { formatError } from "../core/errors.js";
import { formatStatusOutput, formatDiffSummary, formatPluginsList } from "./formatters.js";

// ---- Core actions ----------------------------------------------------------
import { executeFetch } from "../core/actions/fetch.js";
import type { FetchActionOptions } from "../core/actions/fetch.js";
import { executeGenerate } from "../core/actions/generate.js";
import type { GenerateActionOptions } from "../core/actions/generate.js";
import { executeStatus } from "../core/actions/status.js";
import {
	executionSource,
	findRunningPackageRoot,
	resolveLocalInstall,
} from "../core/local-resolution.js";
import { executeDiff } from "../core/actions/diff.js";
import { executeValidate } from "../core/actions/validate.js";
import { executeWatch } from "../core/actions/watch.js";
import { executeResolve } from "../core/actions/resolve.js";
import type { ResolveActionOptions } from "../core/actions/resolve.js";
import { executeDoctor } from "../core/actions/doctor.js";
import type { DoctorActionOptions } from "../core/actions/doctor.js";
import { executeExtract } from "../core/actions/extract.js";
import type { ExtractActionOptions } from "../core/actions/extract.js";
import {
	executeInit,
	setupVitePlugins,
	type PromptProvider,
	type InitActionOptions,
} from "../core/actions/init.js";
import { executePluginsScan, scaffoldNewSurface, scaffoldNewPanel, type PluginsActionOptions } from "../core/actions/plugins.js";
import type { AuthMode } from "../core/config.js";
import { DEFAULT_INSTANCE_CONFIG } from "../core/config.js";

// ---- Known commands --------------------------------------------------------
const COMMANDS = [
	"fetch",
	"generate",
	"status",
	"diff",
	"validate",
	"watch",
	"resolve",
	"doctor",
	"init",
	"plugins",
	"extract",
] as const;

type CommandName = (typeof COMMANDS)[number];

// ---- Help text -------------------------------------------------------------

function printHelp(): void {
	console.log(`
  ${"\x1b[1m"}chowbea-axios${"\x1b[0m"} - Type-safe axios client generator

  ${"\x1b[1m"}USAGE${"\x1b[0m"}
    chowbea-axios <command> [flags]

  ${"\x1b[1m"}COMMANDS${"\x1b[0m"}
    fetch        Fetch OpenAPI spec and generate types/operations
    generate     Generate types/operations from cached spec
    status       Show current status of config, cache, and generated files
    diff         Compare current vs new spec and show changes
    validate     Validate the OpenAPI spec
    watch        Watch for spec changes and auto-regenerate
    resolve      Resolve a merge conflict by regenerating generated files
    doctor       Check (and --fix) generated cache files wrongly tracked in git
    init         Initialize chowbea-axios in your project
    plugins      Manage Vite codegen plugins (Surfaces & Side Panels)
    extract      Extract type-bus types into chowbea.bus.json (API-repo side)

  ${"\x1b[1m"}GLOBAL FLAGS${"\x1b[0m"}
    -q, --quiet      Suppress non-error output
    -v, --verbose    Show detailed output
    -h, --help       Show help
        --version    Show version
        --headless   Force headless mode (auto-detected in non-TTY)

  Run 'chowbea-axios <command> --help' for command-specific flags.
`);
}

function printCommandHelp(command: CommandName): void {
	const helps: Record<CommandName, string> = {
		fetch: `
  ${"\x1b[1m"}chowbea-axios fetch${"\x1b[0m"} - Fetch OpenAPI spec and generate types/operations

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -c, --config <path>    Path to api.config.toml
    -e, --endpoint <url>   Override API endpoint URL
    -s, --spec-file <path> Use local spec file instead of fetching
    -f, --force            Force regeneration even if spec hasn't changed
    -n, --dry-run          Show what would be generated without writing
        --types-only       Generate only TypeScript types
        --operations-only  Generate only operations
    -q, --quiet            Suppress non-error output
    -v, --verbose          Show detailed output
`,
		generate: `
  ${"\x1b[1m"}chowbea-axios generate${"\x1b[0m"} - Generate types/operations from cached spec

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -c, --config <path>    Path to api.config.toml
    -s, --spec-file <path> Use local spec file
    -n, --dry-run          Show what would be generated without writing
        --types-only       Generate only TypeScript types
        --operations-only  Generate only operations
    -q, --quiet            Suppress non-error output
    -v, --verbose          Show detailed output
`,
		status: `
  ${"\x1b[1m"}chowbea-axios status${"\x1b[0m"} - Show current status

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -c, --config <path>  Path to api.config.toml
    -q, --quiet          Suppress non-error output
    -v, --verbose        Show detailed output
`,
		diff: `
  ${"\x1b[1m"}chowbea-axios diff${"\x1b[0m"} - Compare current vs new spec

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -c, --config <path>  Path to api.config.toml
    -s, --spec <path>    Path to new spec file to compare against
    -q, --quiet          Suppress non-error output
    -v, --verbose        Show detailed output
`,
		validate: `
  ${"\x1b[1m"}chowbea-axios validate${"\x1b[0m"} - Validate the OpenAPI spec

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -c, --config <path>  Path to api.config.toml
    -s, --spec <path>    Path to spec file to validate
        --strict         Treat warnings as errors
    -q, --quiet          Suppress non-error output
    -v, --verbose        Show detailed output
`,
		watch: `
  ${"\x1b[1m"}chowbea-axios watch${"\x1b[0m"} - Watch for spec changes

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -c, --config <path>     Path to api.config.toml
    -i, --interval <ms>     Polling interval in milliseconds
    -q, --quiet             Suppress non-error output
    -d, --debug             Enable debug logging
`,
		init: `
  ${"\x1b[1m"}chowbea-axios init${"\x1b[0m"} - Initialize chowbea-axios in your project

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -f, --force              Overwrite existing files
        --skip-scripts       Skip adding npm scripts
        --skip-client        Skip generating client files
        --skip-concurrent    Skip concurrent script setup
        --skip-workflow      Skip GitHub Actions workflow setup
        --with-vite-plugins  Scaffold Vite codegen plugins (Surfaces & Side Panels)
        --base-url-env <var> Environment variable for base URL
        --env-accessor <str> How to access env vars (e.g. "process.env")
        --token-key <key>    localStorage key for auth token
        --auth-mode <mode>   Auth mode: bearer-localstorage | custom | none
        --with-credentials   Include credentials in requests
        --timeout <ms>       Request timeout in milliseconds
    -q, --quiet              Suppress non-error output
    -v, --verbose            Show detailed output
`,
		resolve: `
  ${"\x1b[1m"}chowbea-axios resolve${"\x1b[0m"} - Resolve merge conflicts in generated files by regenerating

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -c, --config <path>    Path to api.config.toml
    -q, --quiet            Suppress non-error output
    -v, --verbose          Show detailed output
`,
		doctor: `
  ${"\x1b[1m"}chowbea-axios doctor${"\x1b[0m"} - Check for (and --fix) cache files wrongly tracked in git

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -c, --config <path>    Path to api.config.toml
        --fix              Untrack cache artifacts and add the gitignore rule
    -q, --quiet            Suppress non-error output
    -v, --verbose          Show detailed output
`,
		plugins: `
  ${"\x1b[1m"}chowbea-axios plugins${"\x1b[0m"} - Manage Vite codegen plugins (Surfaces & Side Panels)

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
      --setup              Run the plugin setup wizard
      --list               List all discovered surfaces and panels
      --add <type:name>    Scaffold a new surface or panel (e.g. --add surface:edit-user)
                           Supports group prefix: --add surface:user/edit-user
      --surfaces-dir <dir> Override surfaces directory
      --panels-dir <dir>   Override side panels directory
    -q, --quiet            Suppress non-error output
    -v, --verbose          Show detailed output
`,
		extract: `
  ${"\x1b[1m"}chowbea-axios extract${"\x1b[0m"} - Extract type-bus types into chowbea.bus.json (API-repo side)

  ${"\x1b[1m"}FLAGS${"\x1b[0m"}
    -p, --project <path>   Path to tsconfig.json (default: auto-discovered)
    -o, --out <path>       Output path for the manifest (default: chowbea.bus.json)
        --check            Validate only — never write the manifest
    -q, --quiet            Suppress non-error output
    -v, --verbose          Show detailed output
`,
	};

	console.log(helps[command]);
}

// ---- Inquirer-based PromptProvider for headless init -----------------------

function createHeadlessPromptProvider(): PromptProvider {
	return {
		async input(opts) {
			const { input } = await import("@inquirer/prompts");
			return input(opts);
		},
		async select(opts) {
			const { select } = await import("@inquirer/prompts");
			return select(opts);
		},
		async confirm(opts) {
			const { confirm } = await import("@inquirer/prompts");
			return confirm(opts);
		},
		async password(opts) {
			const { password } = await import("@inquirer/prompts");
			return password({ message: opts.message, mask: opts.mask });
		},
		async checkbox(opts) {
			const { checkbox } = await import("@inquirer/prompts");
			return checkbox(opts);
		},
	};
}

// ---- Command handlers ------------------------------------------------------

async function handleFetch(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: "string", short: "c" },
			endpoint: { type: "string", short: "e" },
			"spec-file": { type: "string", short: "s" },
			force: { type: "boolean", short: "f", default: false },
			"dry-run": { type: "boolean", short: "n", default: false },
			"types-only": { type: "boolean", default: false },
			"operations-only": { type: "boolean", default: false },
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		verbose: values.verbose,
	});
	const logger = createLogger({ level });

	const options: FetchActionOptions = {
		configPath: values.config,
		endpoint: values.endpoint,
		specFile: values["spec-file"],
		force: values.force ?? false,
		dryRun: values["dry-run"] ?? false,
		typesOnly: values["types-only"] ?? false,
		operationsOnly: values["operations-only"] ?? false,
	};

	try {
		const prompts =
			process.stdin.isTTY && process.stdout.isTTY
				? createHeadlessPromptProvider()
				: undefined;
		const result = await executeFetch(options, logger, prompts);
		if (!result.specChanged && !values.quiet) {
			logger.info("Spec unchanged, nothing to do. Use --force to regenerate.");
		}
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}

async function handleGenerate(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: "string", short: "c" },
			"spec-file": { type: "string", short: "s" },
			"dry-run": { type: "boolean", short: "n", default: false },
			"types-only": { type: "boolean", default: false },
			"operations-only": { type: "boolean", default: false },
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		verbose: values.verbose,
	});
	const logger = createLogger({ level });

	const options: GenerateActionOptions = {
		configPath: values.config,
		specFile: values["spec-file"],
		dryRun: values["dry-run"] ?? false,
		typesOnly: values["types-only"] ?? false,
		operationsOnly: values["operations-only"] ?? false,
	};

	try {
		await executeGenerate(options, logger);
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}

async function handleResolve(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: "string", short: "c" },
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		verbose: values.verbose,
	});
	const logger = createLogger({ level });

	const options: ResolveActionOptions = {
		configPath: values.config,
	};

	try {
		const result = await executeResolve(options, logger);
		// Non-generated conflicts still need manual resolution — fail so the
		// developer (and CI) knows the merge isn't fully done.
		if (result.conflictedOther.length > 0) {
			process.exitCode = 1;
		}
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}

async function handleDoctor(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: "string", short: "c" },
			fix: { type: "boolean", default: false },
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		verbose: values.verbose,
	});
	const logger = createLogger({ level });

	const options: DoctorActionOptions = {
		configPath: values.config,
		fix: values.fix ?? false,
	};

	try {
		const result = await executeDoctor(options, logger);
		// Report-only mode that found problems exits non-zero so `doctor` can
		// gate CI; once `--fix` repairs them, it succeeds.
		if (!result.healthy && !result.fixApplied) {
			process.exitCode = 1;
		}
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}

async function handleStatus(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: "string", short: "c" },
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		verbose: values.verbose,
	});
	const logger = createLogger({ level });

	try {
		const result = await executeStatus({ configPath: values.config }, logger);
		console.log(formatStatusOutput(result));
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}

async function handleDiff(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: "string", short: "c" },
			spec: { type: "string", short: "s" },
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		verbose: values.verbose,
	});
	const logger = createLogger({ level });

	try {
		const result = await executeDiff(
			{ configPath: values.config, specFile: values.spec },
			logger,
		);
		console.log(formatDiffSummary(result));
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}

async function handleValidate(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: "string", short: "c" },
			spec: { type: "string", short: "s" },
			strict: { type: "boolean", default: false },
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		verbose: values.verbose,
	});
	const logger = createLogger({ level });

	try {
		const result = await executeValidate(
			{
				configPath: values.config,
				specFile: values.spec,
				strict: values.strict,
			},
			logger,
		);

		// Display results
		if (result.valid) {
			logger.done("Spec is valid");
		} else {
			logger.step("validate", "Validation issues found");
		}

		for (const issue of result.errors) {
			logger.error(`[${issue.path}] ${issue.message}`);
		}

		for (const issue of result.warnings) {
			logger.warn(`[${issue.path}] ${issue.message}`);
		}

		if (!result.valid) {
			process.exitCode = 1;
		}
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}

async function handleWatch(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: "string", short: "c" },
			interval: { type: "string", short: "i" },
			quiet: { type: "boolean", short: "q", default: false },
			debug: { type: "boolean", short: "d", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		debug: values.debug,
	});
	const logger = createLogger({ level });

	const intervalMs = values.interval ? parseInt(values.interval, 10) : undefined;

	if (intervalMs !== undefined && (isNaN(intervalMs) || intervalMs <= 0)) {
		console.error(`Invalid interval value: "${values.interval}". Must be a positive number of milliseconds.`);
		process.exitCode = 1;
		return;
	}

	// Setup SIGINT handler for graceful shutdown
	const controller = new AbortController();
	const onSigint = () => {
		controller.abort();
	};
	process.on("SIGINT", onSigint);

	try {
		await executeWatch(
			{
				configPath: values.config,
				intervalMs,
				debug: values.debug,
				signal: controller.signal,
			},
			logger,
		);
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	} finally {
		process.off("SIGINT", onSigint);
	}
}

async function handleInit(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			force: { type: "boolean", short: "f", default: false },
			"skip-scripts": { type: "boolean", default: false },
			"skip-client": { type: "boolean", default: false },
			"skip-concurrent": { type: "boolean", default: false },
			"skip-workflow": { type: "boolean", default: false },
			"with-vite-plugins": { type: "boolean", default: false },
			"base-url-env": {
				type: "string",
				default: DEFAULT_INSTANCE_CONFIG.base_url_env,
			},
			"env-accessor": {
				type: "string",
				default: DEFAULT_INSTANCE_CONFIG.env_accessor,
			},
			"token-key": {
				type: "string",
				default: DEFAULT_INSTANCE_CONFIG.token_key,
			},
			"auth-mode": {
				type: "string",
				default: DEFAULT_INSTANCE_CONFIG.auth_mode,
			},
			"with-credentials": {
				type: "boolean",
				default: DEFAULT_INSTANCE_CONFIG.with_credentials,
			},
			timeout: {
				type: "string",
				default: String(DEFAULT_INSTANCE_CONFIG.timeout),
			},
			// Non-interactive flags (#43)
			"non-interactive": { type: "boolean", default: false },
			endpoint: { type: "string" },
			"spec-file": { type: "string" },
			"output-folder": { type: "string" },
			"package-manager": { type: "string" },
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		verbose: values.verbose,
	});
	const logger = createLogger({ level });

	const VALID_AUTH_MODES: readonly string[] = ["bearer-localstorage", "custom", "none"];
	const rawAuthMode = values["auth-mode"] ?? DEFAULT_INSTANCE_CONFIG.auth_mode;
	if (!VALID_AUTH_MODES.includes(rawAuthMode)) {
		console.error(`Invalid auth-mode: "${rawAuthMode}". Must be one of: ${VALID_AUTH_MODES.join(", ")}`);
		process.exitCode = 1;
		return;
	}

	const VALID_PMS: readonly string[] = ["pnpm", "npm", "yarn", "bun"];
	const rawPm = values["package-manager"];
	if (rawPm != null && !VALID_PMS.includes(rawPm)) {
		console.error(`Invalid package-manager: "${rawPm}". Must be one of: ${VALID_PMS.join(", ")}`);
		process.exitCode = 1;
		return;
	}

	// Non-interactive mode (#43): construct the spec source from flags. We
	// also auto-enable non-interactive mode when stdin isn't a TTY so CI
	// jobs without an interactive terminal fail with a clear message
	// instead of hanging on inquirer.
	const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const nonInteractive = (values["non-interactive"] ?? false) || !isTTY;

	let specSource: InitActionOptions["specSource"];
	if (values.endpoint && values["spec-file"]) {
		console.error(
			"Cannot pass both --endpoint and --spec-file; choose one.",
		);
		process.exitCode = 1;
		return;
	}
	if (values.endpoint) {
		specSource = { kind: "remote", endpoint: values.endpoint };
	} else if (values["spec-file"]) {
		specSource = { kind: "local", specFile: values["spec-file"] };
	}

	const options: InitActionOptions = {
		force: values.force ?? false,
		skipScripts: values["skip-scripts"] ?? false,
		skipClient: values["skip-client"] ?? false,
		skipConcurrent: values["skip-concurrent"] ?? false,
		skipWorkflow: values["skip-workflow"] ?? false,
		withVitePlugins: values["with-vite-plugins"] ?? false,
		baseUrlEnv: values["base-url-env"] ?? DEFAULT_INSTANCE_CONFIG.base_url_env,
		envAccessor:
			values["env-accessor"] ?? DEFAULT_INSTANCE_CONFIG.env_accessor,
		tokenKey: values["token-key"] ?? DEFAULT_INSTANCE_CONFIG.token_key,
		authMode: rawAuthMode as AuthMode,
		withCredentials: values["with-credentials"] ?? DEFAULT_INSTANCE_CONFIG.with_credentials,
		timeout: parseInt(values.timeout ?? String(DEFAULT_INSTANCE_CONFIG.timeout), 10),
		nonInteractive,
		specSource,
		outputFolder: values["output-folder"],
		packageManager: rawPm as InitActionOptions["packageManager"],
	};

	// Surface a clearer error when running non-interactively without a
	// spec source — better than letting `executeInit` throw inside an
	// inquirer call that fails mysteriously in non-TTY contexts. Issue #43.
	if (nonInteractive && !specSource) {
		console.error(
			"chowbea-axios init in non-interactive mode requires either --endpoint <url> or --spec-file <path>.\n" +
				"(Detected non-TTY: " + (!isTTY) + "; --non-interactive: " + (values["non-interactive"] ?? false) + ".)",
		);
		process.exitCode = 1;
		return;
	}

	const prompts = createHeadlessPromptProvider();

	try {
		await executeInit(options, logger, prompts);
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}

async function handlePlugins(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			setup: { type: "boolean", default: false },
			list: { type: "boolean", default: false },
			add: { type: "string" },
			"surfaces-dir": { type: "string" },
			"panels-dir": { type: "string" },
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({ quiet: values.quiet, verbose: values.verbose });
	const logger = createLogger({ level });

	try {
		if (values.setup) {
			// Run the setup wizard
			const prompts = createHeadlessPromptProvider();
			const { findProjectRoot } = await import("../core/config.js");
			const projectRoot = await findProjectRoot();
			await setupVitePlugins(projectRoot, false, logger, prompts);
			return;
		}

		if (values.add) {
			// Parse type:name format, e.g. "surface:edit-user" or "surface:user/edit-user"
			const [type, ...rest] = values.add.split(":");
			const fullName = rest.join(":");
			if (!type || !fullName || (type !== "surface" && type !== "panel")) {
				console.error('Invalid format. Use --add surface:<name> or --add panel:<name>');
				console.error('Examples: --add surface:edit-user  --add panel:user/staff-profile');
				process.exitCode = 1;
				return;
			}

			// Parse group from name: "user/edit-user" → group="user", name="edit-user"
			const parts = fullName.split("/");
			const name = parts.pop()!;
			const group = parts.join("/") || undefined;

			const surfacesDir = values["surfaces-dir"] ?? "src/components/surfaces";
			const sidepanelsDir = values["panels-dir"] ?? "src/components/side-panels";

			if (type === "surface") {
				await scaffoldNewSurface(name, surfacesDir, logger, group);
			} else {
				await scaffoldNewPanel(name, sidepanelsDir, logger, group);
			}
			return;
		}

		// Default: list
		const options: PluginsActionOptions = {
			surfacesDir: values["surfaces-dir"],
			sidepanelsDir: values["panels-dir"],
		};
		const result = await executePluginsScan(options, logger);
		console.log(formatPluginsList(result));
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}

async function handleExtract(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			project: { type: "string", short: "p" },
			out: { type: "string", short: "o" },
			check: { type: "boolean", default: false },
			quiet: { type: "boolean", short: "q", default: false },
			verbose: { type: "boolean", short: "v", default: false },
		},
		strict: true,
	});

	const level = getLogLevel({
		quiet: values.quiet,
		verbose: values.verbose,
	});
	const logger = createLogger({ level });

	const options: ExtractActionOptions = {
		project: values.project,
		out: values.out,
		check: values.check ?? false,
	};

	try {
		const result = await executeExtract(options, logger);
		// CI gate: extraction errors or --check violations exit non-zero.
		if (!result.ok) {
			process.exitCode = 1;
		}
	} catch (error) {
		logger.error(formatError(error));
		process.exitCode = 1;
	}
}

// ---- Main entry point ------------------------------------------------------

/**
 * Headless command runner.
 * Parses the command name and flags, routes to the appropriate action.
 *
 * @param command - The command name (first positional arg), may be undefined
 * @param args    - All args (including the command name as the first element)
 */
export async function runHeadless(
	command: string | undefined,
	args: string[],
): Promise<void> {
	// Strip the command name and global-only flags from args for sub-parsers
	const commandArgs = args.filter(
		(a) => a !== command && a !== "--headless" && a !== "--global",
	);

	// --version
	if (args.includes("--version")) {
		try {
			const { readFileSync } = await import("node:fs");
			const { resolve, dirname } = await import("node:path");
			const { fileURLToPath } = await import("node:url");
			const thisDir = dirname(fileURLToPath(import.meta.url));
			const pkgPath = resolve(thisDir, "..", "..", "package.json");
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
			const source = executionSource({
				runningRoot: findRunningPackageRoot(import.meta.url),
				localRoot: resolveLocalInstall(process.cwd())?.root ?? null,
			});
			console.log(`chowbea-axios v${pkg.version} (${source})`);
		} catch {
			console.log("chowbea-axios (unknown version)");
		}
		return;
	}

	// Check for global --help before routing
	if (!command || args.includes("--help") || args.includes("-h")) {
		if (command && COMMANDS.includes(command as CommandName)) {
			printCommandHelp(command as CommandName);
		} else {
			printHelp();
		}
		return;
	}

	// Route to command handler
	switch (command) {
		case "fetch":
			await handleFetch(commandArgs);
			break;
		case "generate":
			await handleGenerate(commandArgs);
			break;
		case "status":
			await handleStatus(commandArgs);
			break;
		case "diff":
			await handleDiff(commandArgs);
			break;
		case "validate":
			await handleValidate(commandArgs);
			break;
		case "watch":
			await handleWatch(commandArgs);
			break;
		case "resolve":
			await handleResolve(commandArgs);
			break;
		case "doctor":
			await handleDoctor(commandArgs);
			break;
		case "init":
			await handleInit(commandArgs);
			break;
		case "plugins":
			await handlePlugins(commandArgs);
			break;
		case "extract":
			await handleExtract(commandArgs);
			break;
		default:
			console.error(`Unknown command: ${command}`);
			printHelp();
			process.exitCode = 1;
			break;
	}
}
