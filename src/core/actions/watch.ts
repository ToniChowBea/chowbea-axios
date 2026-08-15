/**
 * Watch action - continuously polls for OpenAPI spec changes and regenerates.
 * Pure business logic extracted from the Watch command.
 * No oclif dependencies, no process.exit, no this.parse.
 *
 * Uses AbortSignal for cancellation support, making it safe for TUI integration.
 */

import type { Logger } from "../../adapters/logger-interface.js";
import { formatDuration } from "../../adapters/logger-interface.js";
import { syncBusFromConfig } from "../bus/fetch.js";
import {
	type ApiConfig,
	ensureOutputFolders,
	getOutputPaths,
	loadConfig,
	resolveSpecSource,
	type SpecSource,
} from "../config.js";
import {
	computeHash,
	fetchOpenApiSpec,
	loadCacheMetadata,
	loadLocalSpec,
	saveSpec,
} from "../fetcher.js";
import { generate, generateClientFiles } from "../generator.js";
import type { GenerationHooks } from "../generator.js";
import { loadHooks } from "../hooks-loader.js";

/**
 * Options for the watch action.
 */
export interface WatchActionOptions {
	/** Path to api.config.toml */
	configPath?: string;
	/** Polling interval in milliseconds (overrides config) */
	intervalMs?: number;
	/** Enable debug logging (overrides config) */
	debug?: boolean;
	/** AbortSignal for cancellation support (e.g., from TUI) */
	signal?: AbortSignal;
}

/**
 * Callbacks for watch lifecycle events.
 * The TUI can hook into these to update its display.
 */
export interface WatchCallbacks {
	/** Called when a new polling cycle starts */
	onCycleStart?(cycleId: number): void;
	/** Called when a cycle completes successfully */
	onCycleComplete?(cycleId: number, changed: boolean, durationMs: number): void;
	/** Called when a cycle fails with an error */
	onCycleError?(cycleId: number, error: Error): void;
	/** Called when watch mode is shutting down */
	onShutdown?(): void;
}

/**
 * Delays execution for the specified milliseconds.
 * Respects AbortSignal for early termination.
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}

		let onAbort: (() => void) | undefined;

		const timer = setTimeout(() => {
			if (onAbort && signal) {
				signal.removeEventListener("abort", onAbort);
			}
			resolve();
		}, ms);

		// Listen for abort to resolve early and clean up the timer
		if (signal) {
			onAbort = () => {
				clearTimeout(timer);
				resolve();
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

/**
 * Executes the watch action: continuously poll for spec changes and regenerate.
 *
 * The watch loop runs until the AbortSignal is triggered or the process is interrupted.
 * Returns a promise that resolves when the watch loop exits.
 *
 * @param options - Watch action options (replaces CLI flags)
 * @param logger - Logger instance for output
 * @param callbacks - Optional lifecycle callbacks for TUI integration
 */
export async function executeWatch(
	options: WatchActionOptions,
	logger: Logger,
	callbacks?: WatchCallbacks,
): Promise<void> {
	// Load configuration first (auto-creates if missing)
	const { config, projectRoot, configPath, wasCreated } = await loadConfig(
		options.configPath,
	);

	logger.header("chowbea watch");
	logger.debug("Configuration loaded successfully");

	if (wasCreated) {
		logger.warn(
			{ configPath },
			"Created default api.config.toml - please review and update settings",
		);
	}

	// Get output paths
	const outputPaths = getOutputPaths(config, projectRoot);
	logger.debug({ outputPaths }, "Resolved output paths");

	// Ensure output folders exist (_internal, _generated)
	await ensureOutputFolders(outputPaths);

	// Generate client files if they don't exist (once at startup)
	await generateClientFiles({
		paths: outputPaths,
		instanceConfig: config.instance,
		logger,
	});

	// Load optional generator hooks once at startup; reused on every cycle.
	const hooks = await loadHooks(projectRoot, logger);

	// Determine polling interval and spec source (local file or remote endpoint)
	const intervalMs = options.intervalMs ?? config.poll_interval_ms;
	const specSource = resolveSpecSource(config, projectRoot);
	const sourceLabel =
		specSource.type === "local" ? specSource.path : specSource.endpoint;

	// Announce the watch loop at info level so the user knows what's being
	// polled and at what cadence. In debug mode the full context also fires.
	logger.step(
		"watch",
		`Polling every ${formatDuration(intervalMs)} — ${sourceLabel}`,
	);
	logger.debug({ specSource, intervalMs }, "config");

	let cycleCounter = 0;
	let consecutiveFailures = 0;
	// Cap backoff at 5 minutes so a transiently broken endpoint doesn't
	// stay quiet forever once it recovers.
	const MAX_BACKOFF_MS = 5 * 60_000;
	// Stop the loop after this many consecutive failures so a permanently
	// broken setup (deleted spec file, 401 forever, malformed cached
	// spec) doesn't spam logs indefinitely. Issue #34.
	const MAX_CONSECUTIVE_FAILURES = 10;
	const signal = options.signal;

	// Main watch loop
	while (!signal?.aborted) {
		cycleCounter++;
		const cycleId = cycleCounter;

		const failed = await runCycle({
			cycleId,
			specSource,
			outputPaths,
			logger,
			headers: config.fetch?.headers,
			hooks,
			callbacks,
			config,
		});

		if (failed) {
			consecutiveFailures += 1;
			if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
				logger.error(
					{ failures: consecutiveFailures },
					`Watch loop exiting after ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Investigate and re-run 'chowbea watch'.`,
				);
				callbacks?.onShutdown?.();
				return;
			}
			// Exponential backoff: wait the normal interval × 2^(failures-1),
			// capped. After a successful cycle we reset to the base interval.
			const backoff = Math.min(
				intervalMs * 2 ** (consecutiveFailures - 1),
				MAX_BACKOFF_MS,
			);
			logger.warn(
				{ failures: consecutiveFailures, backoffMs: backoff },
				"Backing off after repeated failures",
			);
			if (!signal?.aborted) {
				await abortableDelay(backoff, signal);
			}
			continue;
		}

		consecutiveFailures = 0;

		// Wait before next cycle (respects abort signal)
		if (!signal?.aborted) {
			await abortableDelay(intervalMs, signal);
		}
	}

	// Shutdown
	logger.warn("Shutting down watch mode...");
	logger.info("Cache preserved for next run");
	callbacks?.onShutdown?.();
}

/**
 * Runs a single watch cycle - load (fetch or read) the spec, check for changes,
 * regenerate if needed.
 *
 * Returns `true` when the cycle failed (so the outer loop can apply
 * exponential backoff and exit after too many consecutive failures —
 * issue #34). Returns `false` on success.
 */
async function runCycle(options: {
	cycleId: number;
	specSource: SpecSource;
	outputPaths: ReturnType<typeof getOutputPaths>;
	logger: Logger;
	headers?: Record<string, string>;
	hooks: GenerationHooks;
	callbacks?: WatchCallbacks;
	config: ApiConfig;
}): Promise<boolean> {
	const {
		cycleId,
		specSource,
		outputPaths,
		logger,
		headers,
		hooks,
		callbacks,
		config,
	} = options;
	const startTime = Date.now();

	// Notify cycle start
	callbacks?.onCycleStart?.(cycleId);

	// Only show cycle separator in debug mode
	if (logger.level === "debug") {
		logger.step("cycle", `Cycle ${cycleId}`);
	}

	try {
		let newBuffer: Buffer;
		let newHash: string;
		let sourceIdentifier: string;
		let hasChanged: boolean;

		if (specSource.type === "local") {
			// Local file mode — hash file contents and compare against cache
			sourceIdentifier = specSource.path;
			logger.debug({ cycleId, path: specSource.path }, "Checking local spec...");
			const { buffer } = await loadLocalSpec(specSource.path);
			newBuffer = buffer;
			newHash = computeHash(buffer);

			// Compare against previously-saved spec hash
			const existingCache = await loadCacheMetadata(outputPaths.cache);
			hasChanged = existingCache?.hash !== newHash;
		} else {
			// Remote mode — fetch with retry
			sourceIdentifier = specSource.endpoint;
			logger.debug(
				{ cycleId, endpoint: specSource.endpoint },
				"Checking for API changes...",
			);
			const fetchResult = await fetchOpenApiSpec({
				endpoint: specSource.endpoint,
				specPath: outputPaths.spec,
				cachePath: outputPaths.cache,
				logger,
				force: false,
				headers,
			});

			if (fetchResult.fromCache) {
				logger.warn({ cycleId }, "Using cached spec due to network issues");
			}

			newBuffer = fetchResult.buffer;
			newHash = fetchResult.hash;
			hasChanged = fetchResult.hasChanged;
		}

		// Heartbeat: one line per cycle so watch mode isn't silent when
		// nothing changes. Compact format so it's tolerable at any interval.
		if (!hasChanged) {
			// Bus types change independently of the OpenAPI spec, so this
			// cycle still syncs the bus even though the spec itself didn't
			// change (spec §5/§7) — cheap when nothing changed (If-None-Match
			// + hash compare). A sync failure here throws and is caught by
			// the outer catch below, applying the same cycle-level
			// backoff/consecutive-failure handling as any other cycle
			// failure — no spec update to lose on this path since none
			// happened this cycle.
			await syncBusFromConfig(config, outputPaths, logger);

			const durationMs = Date.now() - startTime;
			logger.info(
				{ cycle: cycleId, duration: formatDuration(durationMs) },
				"no changes",
			);
			callbacks?.onCycleComplete?.(cycleId, false, durationMs);
			return false;
		}

		// Save the new spec
		await saveSpec({
			buffer: newBuffer,
			hash: newHash,
			endpoint: sourceIdentifier,
			specPath: outputPaths.spec,
			cachePath: outputPaths.cache,
		});

		logger.info(
			{ cycleId, bytes: newBuffer.length },
			"New spec detected, regenerating...",
		);

		// Run generation
		const result = await generate({
			paths: outputPaths,
			logger,
			hooks,
		});

		logger.info(
			{
				cycleId,
				operations: result.operationCount,
				duration: formatDuration(result.durationMs),
			},
			"Generation completed",
		);

		// [bus]/[fetch.auth]/[fetch.headers] sync the Type Bus alongside the
		// spec (spec §5/§7), same as `fetch`. No-op when [bus] isn't
		// configured. A sync failure here is caught below like any other
		// cycle failure — same backoff/consecutive-failure handling. Safe to
		// lose this cycle to backoff since the spec was already saved above.
		await syncBusFromConfig(config, outputPaths, logger);

		const durationMs = Date.now() - startTime;
		callbacks?.onCycleComplete?.(cycleId, true, durationMs);
		return false;
	} catch (error) {
		const cycleError = error instanceof Error ? error : new Error(String(error));

		// Log error and return failed=true so the outer loop can apply
		// exponential backoff. Issue #34.
		logger.error(
			{
				cycleId,
				error: cycleError.message,
			},
			"Cycle failed, backing off before retry",
		);

		callbacks?.onCycleError?.(cycleId, cycleError);
		return true;
	}
}
