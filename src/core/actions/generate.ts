/**
 * Generate action - generates TypeScript types and operations from local OpenAPI spec.
 * Pure business logic extracted from the Generate command.
 * No oclif dependencies, no process.exit, no this.parse.
 */

import { writeFile } from "node:fs/promises";

import type { Logger } from "../../adapters/logger-interface.js";
import { formatDuration } from "../../adapters/logger-interface.js";
import {
	ensureOutputFolders,
	getOutputPaths,
	loadConfig,
	resolveSpecSource,
} from "../config.js";
import { SpecNotFoundError } from "../errors.js";
import {
	computeHash,
	hasLocalSpec,
	loadLocalSpec,
	saveCacheMetadata,
} from "../fetcher.js";
import { generate, generateClientFiles } from "../generator.js";
import { loadHooks } from "../hooks-loader.js";
import type { ClientFilesResult, DryRunResult } from "./types.js";

/**
 * Options for the generate action.
 */
export interface GenerateActionOptions {
	/** Path to api.config.toml */
	configPath?: string;
	/** Use local spec file (copies to cache before generating) */
	specFile?: string;
	/** Show what would be generated without writing files */
	dryRun: boolean;
	/** Generate only TypeScript types (skip operations) */
	typesOnly: boolean;
	/** Generate only operations (skip types) */
	operationsOnly: boolean;
}

/**
 * Result of the generate action.
 */
export interface GenerateActionResult {
	/** Number of operations generated */
	operationCount: number;
	/** Duration of the generation process in milliseconds */
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
 * Executes the generate action: generate types/operations from cached or local spec.
 *
 * @param options - Generate action options (replaces CLI flags)
 * @param logger - Logger instance for output
 * @returns Structured result with all data the UI needs
 */
export async function executeGenerate(
	options: GenerateActionOptions,
	logger: Logger,
): Promise<GenerateActionResult> {
	const startTime = Date.now();

	logger.header("chowbea-axios generate");

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

	// Resolve spec source — honors both --spec-file CLI flag AND config.spec_file
	// (priority: flag > config.spec_file > config.api_endpoint, per resolveSpecSource).
	// For local sources, copy into the cache location so the rest of the pipeline
	// reads from a consistent place.
	const specSource = resolveSpecSource(config, projectRoot, options.specFile);
	if (specSource.type === "local") {
		logger.info(
			{ specFile: specSource.path },
			"Loading local spec file...",
		);

		// Load and validate the spec
		const { buffer } = await loadLocalSpec(specSource.path);
		const hash = computeHash(buffer);

		// Copy to cache location
		await writeFile(outputPaths.spec, buffer);
		await saveCacheMetadata(outputPaths.cache, {
			hash,
			timestamp: Date.now(),
			endpoint: specSource.path,
		});

		logger.info(
			{ bytes: buffer.length, hash: hash.slice(0, 8) },
			"Spec copied to cache",
		);
	}

	// Check if local spec exists
	const specExists = await hasLocalSpec(outputPaths.spec);

	if (!specExists) {
		throw new SpecNotFoundError(outputPaths.spec);
	}

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

	if (config.bus) {
		const { readFile } = await import("node:fs/promises");
		const { parseManifest } = await import("../bus/manifest.js");
		const { writeBusFiles } = await import("../bus/emit.js");

		// Only an absent cache file is the expected "never ran fetch" case —
		// swallow that one as a warning. A cache file that exists but fails to
		// parse/validate, or an emission failure (e.g. filename collision),
		// is a real problem and must fail generate loudly, same as any other
		// failure in this action (e.g. SpecNotFoundError above).
		let cached: string | null = null;
		try {
			cached = await readFile(outputPaths.busCache, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			logger.warn("Type bus configured but no cached manifest — run fetch first");
		}
		if (cached !== null) {
			const manifest = parseManifest(cached);
			await writeBusFiles(manifest, outputPaths.busDir);
			logger.info("Type bus: regenerated from cache");
		}
	}

	return {
		operationCount: result.operationCount,
		durationMs: Date.now() - startTime,
		typesGenerated: result.typesGenerated,
		operationsGenerated: result.operationsGenerated,
		clientFilesCreated: clientFiles,
	};
}
