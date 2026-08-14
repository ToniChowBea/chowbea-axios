/**
 * Fetch action - fetches OpenAPI spec from remote endpoint and generates types.
 * Pure business logic extracted from the Fetch command.
 * No oclif dependencies, no process.exit, no this.parse.
 */

import type { Logger } from "../../adapters/logger-interface.js";
import { formatDuration } from "../../adapters/logger-interface.js";
import {
	type ApiConfig,
	ensureOutputFolders,
	type FetchAuthConfig,
	getOutputPaths,
	loadConfig,
	type OutputPaths,
	resolveSpecSource,
} from "../config.js";
import {
	fetchOpenApiSpec,
	interpolateEnvVars,
	loadLocalSpecFile,
	saveSpec,
} from "../fetcher.js";
import { generate, generateClientFiles } from "../generator.js";
import { loadHooks } from "../hooks-loader.js";
import type { PromptProvider } from "./init.js";
import type { ClientFilesResult, DryRunResult } from "./types.js";

/**
 * Options for the fetch action.
 */
export interface FetchActionOptions {
	/** Path to api.config.toml */
	configPath?: string;
	/** Override API endpoint URL */
	endpoint?: string;
	/** Use local spec file instead of fetching from remote */
	specFile?: string;
	/** Force regeneration even if spec hasn't changed */
	force: boolean;
	/** Show what would be generated without writing files */
	dryRun: boolean;
	/** Generate only TypeScript types (skip operations) */
	typesOnly: boolean;
	/** Generate only operations (skip types) */
	operationsOnly: boolean;
	/**
	 * Pre-resolved Basic Auth credentials. When provided, overrides
	 * config-based env var lookup and skips interactive prompts.
	 * Used by the TUI to collect credentials via its own UI layer.
	 */
	auth?: { username: string; password: string };
}

/**
 * Result of the fetch action.
 */
export interface FetchActionResult {
	/** Whether the spec changed since last fetch */
	specChanged: boolean;
	/** Whether the result was loaded from cache due to network failure */
	fromCache: boolean;
	/** Number of operations generated */
	operationCount: number;
	/** Duration of the entire fetch+generate process in milliseconds */
	durationMs: number;
	/** Whether types were generated */
	typesGenerated: boolean;
	/** Whether operations were generated */
	operationsGenerated: boolean;
	/** Which client files were created (helpers, instance, error, client) */
	clientFilesCreated: ClientFilesResult;
	/** Dry run result (only present when dryRun is true) */
	dryRunResult?: DryRunResult;
}

/**
 * Resolves Basic Auth credentials from config, env vars, or interactive prompts.
 * Returns resolved credentials or undefined if no auth is configured.
 */
async function resolveBasicAuth(
	authConfig: FetchAuthConfig,
	logger: Logger,
	prompts?: PromptProvider,
): Promise<{ username: string; password: string }> {
	let username: string | undefined;
	let password: string | undefined;

	// Try resolving username from config (with env var interpolation)
	if (authConfig.username) {
		try {
			username = interpolateEnvVars(authConfig.username);
		} catch {
			// Env var not set — will prompt or error below
		}
	}

	// Try resolving password from config (with env var interpolation)
	if (authConfig.password) {
		try {
			password = interpolateEnvVars(authConfig.password);
		} catch {
			// Env var not set — will prompt or error below
		}
	}

	// If credentials are complete, return them
	if (username && password) {
		logger.debug("Using Basic Auth credentials from config/env");
		return { username, password };
	}

	// Try interactive prompts
	if (prompts) {
		logger.info("Basic Auth credentials needed for spec endpoint");

		if (!username) {
			username = await prompts.input({
				message: "Swagger username:",
				validate: (value) =>
					value.trim().length > 0 ? true : "Username is required",
			});
		}
		if (!password) {
			password = await prompts.password({
				message: "Swagger password:",
				mask: "*",
			});
		}

		if (!username?.trim() || !password) {
			throw new Error(
				"Basic Auth credentials are incomplete. Both username and password are required."
			);
		}

		return { username, password };
	}

	// Non-interactive and credentials are incomplete
	throw new Error(
		"Basic Auth credentials are incomplete. " +
			"Set the environment variables referenced in [fetch.auth] " +
			"(e.g. SWAGGER_USER, SWAGGER_PASS), or run interactively to be prompted."
	);
}

/**
 * Syncs the Type Bus, swallowing failures as a warning instead of failing
 * the whole command — same fallback posture as spec fetching falling back
 * to cache. Bus types change independently of the OpenAPI spec, so this
 * runs on every successful fetch, whether or not the spec itself changed
 * (spec §5/§7). No-op when `[bus]` isn't configured (syncBusFromConfig
 * returns null and logs nothing).
 */
async function syncBusResilient(
	config: ApiConfig,
	outputPaths: OutputPaths,
	logger: Logger,
	resolvedAuth?: { username: string; password: string },
): Promise<void> {
	try {
		const { syncBusFromConfig } = await import("../bus/fetch.js");
		await syncBusFromConfig(config, outputPaths, logger, resolvedAuth);
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Type bus sync failed — continuing without updating bus files",
		);
	}
}

/**
 * Executes the fetch action: fetch OpenAPI spec, cache it, and generate types/operations.
 *
 * @param options - Fetch action options (replaces CLI flags)
 * @param logger - Logger instance for output
 * @param prompts - Optional prompt provider for interactive auth credential input
 * @returns Structured result with all data the UI needs
 */
export async function executeFetch(
	options: FetchActionOptions,
	logger: Logger,
	prompts?: PromptProvider,
): Promise<FetchActionResult> {
	const startTime = Date.now();

	logger.header("chowbea-axios fetch");

	// Load configuration (auto-creates if missing)
	logger.step("config", "Loading configuration...");
	const { config, projectRoot, configPath, wasCreated } = await loadConfig(
		options.configPath,
	);

	if (wasCreated) {
		logger.warn(
			{ configPath },
			"Created default api.config.toml - please review and update settings",
		);
	}

	// Validate flag combination early
	if (options.typesOnly && options.operationsOnly) {
		throw new Error("Cannot use --types-only and --operations-only together");
	}

	// Get output paths
	const outputPaths = getOutputPaths(config, projectRoot);
	logger.debug({ outputPaths }, "Resolved output paths");

	// Ensure output folders exist (_internal, _generated)
	await ensureOutputFolders(outputPaths);
	logger.debug({ folder: outputPaths.folder }, "Output folders ready");

	// Resolve spec source (flag > config spec_file > config api_endpoint)
	// Note: --endpoint flag overrides spec_file for remote fetching
	const specSource = options.endpoint
		? { type: "remote" as const, endpoint: options.endpoint }
		: resolveSpecSource(config, projectRoot, options.specFile);

	let fetchResult;
	let sourceIdentifier: string;
	// Threaded to the bus sync below: when the spec fetch resolved Basic Auth
	// interactively (env vars unset, prompted a human), the bus endpoint must
	// reuse those same credentials instead of re-resolving non-interactively,
	// which would fail outright (a bus sync has no TTY to prompt on).
	let resolvedAuth: { username: string; password: string } | undefined;

	if (specSource.type === "local") {
		// Load from local file
		sourceIdentifier = specSource.path;
		fetchResult = await loadLocalSpecFile({
			localPath: specSource.path,
			specPath: outputPaths.spec,
			cachePath: outputPaths.cache,
			logger,
			force: options.force,
		});
	} else {
		// Fetch from remote endpoint
		sourceIdentifier = specSource.endpoint;
		logger.step("fetch", "Fetching OpenAPI spec...");
		logger.debug({ endpoint: specSource.endpoint }, "endpoint");

		// Resolve auth credentials if configured.
		// Caller-supplied options.auth (e.g., from TUI) takes precedence
		// over config-based env var lookup and interactive prompts.
		if (options.auth) {
			resolvedAuth = options.auth;
			logger.debug("Using Basic Auth credentials from caller");
		} else if (config.fetch?.auth?.type === "basic") {
			resolvedAuth = await resolveBasicAuth(config.fetch.auth, logger, prompts);
		}

		fetchResult = await fetchOpenApiSpec({
			endpoint: specSource.endpoint,
			specPath: outputPaths.spec,
			cachePath: outputPaths.cache,
			logger,
			force: options.force,
			headers: config.fetch?.headers,
			auth: resolvedAuth,
		});

		// Handle network fallback
		if (fetchResult.fromCache) {
			logger.warn("Using cached spec due to network issues");
		}
	}

	if (!(fetchResult.hasChanged || options.force)) {
		logger.info("Spec unchanged, skipping generation");
		logger.info("Use --force to regenerate anyway");

		// Bus types change independently of the OpenAPI spec — sync even
		// though the spec itself didn't change (spec §5/§7). Cheap when
		// nothing changed (If-None-Match + hash compare). Skipped in dry-run:
		// dry-run never writes files, and bus sync writes bus files.
		if (!options.dryRun) {
			await syncBusResilient(config, outputPaths, logger, resolvedAuth);
		}

		return {
			specChanged: false,
			fromCache: fetchResult.fromCache,
			operationCount: 0,
			durationMs: Date.now() - startTime,
			typesGenerated: false,
			operationsGenerated: false,
			clientFilesCreated: { helpers: false, instance: false, error: false, client: false },
		};
	}

	// Save the new spec
	await saveSpec({
		buffer: fetchResult.buffer,
		hash: fetchResult.hash,
		endpoint: sourceIdentifier,
		specPath: outputPaths.spec,
		cachePath: outputPaths.cache,
	});

	logger.info(
		{
			bytes: fetchResult.buffer.length,
			hash: fetchResult.hash.slice(0, 8),
		},
		"Spec saved",
	);

	// Generate client files if they don't exist
	const clientFiles = await generateClientFiles({
		paths: outputPaths,
		instanceConfig: config.instance,
		logger,
	});

	// Load optional generator hooks from chowbea.config.{mjs,js}
	const hooks = await loadHooks(projectRoot, logger);

	// Run generation
	logger.step("generate", "Generating types and operations...");
	const result = await generate({
		paths: outputPaths,
		logger,
		dryRun: options.dryRun,
		skipTypes: options.operationsOnly,
		skipOperations: options.typesOnly,
		hooks,
	});

	// Handle dry-run output
	if (options.dryRun && result.dryRunResult) {
		logger.done("Dry run complete - no files written");
		logger.info(
			{ operations: result.dryRunResult.operationCount },
			"Operations found",
		);
		for (const file of result.dryRunResult.files) {
			const info = file.lines > 0 ? ` (${file.lines} lines)` : " (types)";
			logger.info(`Would ${file.action}: ${file.path}${info}`);
		}
		return {
			specChanged: true,
			fromCache: fetchResult.fromCache,
			operationCount: result.dryRunResult.operationCount,
			durationMs: Date.now() - startTime,
			typesGenerated: false,
			operationsGenerated: false,
			clientFilesCreated: clientFiles,
			dryRunResult: result.dryRunResult,
		};
	}

	// Report success
	logger.done(
		`Completed in ${formatDuration(result.durationMs)} - ${result.operationCount} operations`,
	);
	if (result.typesGenerated) {
		logger.info({ types: outputPaths.types }, "Types output");
	}
	if (result.operationsGenerated) {
		logger.info(
			{ operations: outputPaths.operations },
			"Operations output",
		);
	}

	if (
		clientFiles.helpers ||
		clientFiles.instance ||
		clientFiles.error ||
		clientFiles.client
	) {
		logger.info("Client files created:");
		if (clientFiles.helpers) logger.info(`  - ${outputPaths.helpers}`);
		if (clientFiles.instance) logger.info(`  - ${outputPaths.instance}`);
		if (clientFiles.error) logger.info(`  - ${outputPaths.error}`);
		if (clientFiles.client) logger.info(`  - ${outputPaths.client}`);
	}

	// [bus]/[fetch.auth]/[fetch.headers] sync the Type Bus alongside the spec
	// (spec §5/§7). No-ops (returns null, no logging) when [bus] isn't
	// configured. Shared with watch's runCycle so both entry points stay in
	// lockstep. A bus-endpoint failure here only warns — it must not
	// discard the types/operations that were just generated successfully.
	await syncBusResilient(config, outputPaths, logger, resolvedAuth);

	return {
		specChanged: true,
		fromCache: fetchResult.fromCache,
		operationCount: result.operationCount,
		durationMs: Date.now() - startTime,
		typesGenerated: result.typesGenerated,
		operationsGenerated: result.operationsGenerated,
		clientFilesCreated: clientFiles,
	};
}
