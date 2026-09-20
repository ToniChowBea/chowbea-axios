/**
 * `sync` action — the ONLY writer of the pinned input files (`spec_file`,
 * `[bus].file`). Fetches from the committed stable endpoints (the local
 * overlay is deliberately ignored), validates everything BEFORE writing
 * anything, writes only artifacts whose content hash changed, then
 * regenerates types from the pins. Fails loud: a bot must never open a PR
 * from a half-updated or unvalidated state, so unlike `fetch` there is no
 * cache fallback and no swallowed bus failure.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../../adapters/logger-interface.js";
import { ensureOutputFolders, getOutputPaths, isPinnedMode, loadConfig } from "../config.js";
import {
	buildBasicAuthHeader,
	computeHash,
	fetchOpenApiSpec,
	interpolateHeaders,
	resolveBasicAuthNonInteractive,
	saveCacheMetadata,
} from "../fetcher.js";
import { BUS_FETCH_TIMEOUT_MS } from "../bus/fetch.js";
import { writeBusFiles } from "../bus/emit.js";
import { diffManifests, parseManifest, type BusDiff, type BusManifest } from "../bus/manifest.js";
import { generate, generateClientFiles } from "../generator.js";
import { loadHooks } from "../hooks-loader.js";

export interface SyncActionOptions {
	configPath?: string;
}

export interface SyncActionResult {
	specChanged: boolean;
	/** null when `[bus]` is not configured. */
	busChanged: boolean | null;
	busDiff: BusDiff | null;
	typeCount: number;
	operationCount: number;
}

async function readIfExists(filePath: string): Promise<Buffer | null> {
	try {
		return await readFile(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return null;
	}
}

export async function executeSync(
	options: SyncActionOptions,
	logger: Logger,
): Promise<SyncActionResult> {
	logger.header("chowbea-axios sync");

	// Committed truth in, committed truth out: never merge the local overlay.
	const { config, projectRoot, localOverridePresent } = await loadConfig(options.configPath, {
		localOverlay: false,
	});
	if (localOverridePresent) {
		logger.info("api.config.local.toml present — ignored by sync (pins come from the committed config)");
	}

	if (!isPinnedMode(config)) {
		throw new Error(
			"sync requires pinned-inputs mode: set both api_endpoint (stable source) and spec_file (committed pin path) in api.config.toml",
		);
	}
	if (config.bus && !config.bus.file) {
		throw new Error(
			"sync requires [bus].file when [bus] is configured — the committed manifest path (e.g. \"chowbea.bus.json\")",
		);
	}

	const outputPaths = getOutputPaths(config, projectRoot);
	await ensureOutputFolders(outputPaths);

	// Shared headers/auth, same precedence as fetch: Basic Auth (resolved
	// non-interactively — sync must never block on a TTY) wins over any
	// explicit Authorization header.
	const headers: Record<string, string> = config.fetch?.headers
		? interpolateHeaders(config.fetch.headers)
		: {};
	const auth =
		config.fetch?.auth?.type === "basic"
			? resolveBasicAuthNonInteractive(config.fetch.auth)
			: undefined;

	// --- Fetch + validate EVERYTHING before writing anything. ---

	const specResult = await fetchOpenApiSpec({
		endpoint: config.api_endpoint as string,
		specPath: outputPaths.spec,
		cachePath: outputPaths.cache,
		logger,
		force: true,
		headers: Object.keys(headers).length > 0 ? { ...headers } : undefined,
		auth,
	});
	if (specResult.fromCache) {
		throw new Error(
			"sync requires the live endpoint — refusing to pin from the cache fallback after network failure",
		);
	}
	const pinnedSpecPath = path.resolve(projectRoot, config.spec_file as string);
	const existingSpec = await readIfExists(pinnedSpecPath);
	const specChanged = existingSpec === null || computeHash(existingSpec) !== specResult.hash;

	let busChanged: boolean | null = null;
	let busDiff: BusDiff | null = null;
	let newManifest: BusManifest | null = null;
	let manifestToEmit: BusManifest | null = null;
	let pinnedBusPath: string | null = null;
	if (config.bus) {
		pinnedBusPath = path.resolve(projectRoot, config.bus.file as string);
		const existingBusText = (await readIfExists(pinnedBusPath))?.toString("utf8") ?? null;
		let previous: BusManifest | null = null;
		if (existingBusText !== null) {
			try {
				previous = parseManifest(existingBusText);
			} catch {
				previous = null; // unreadable pin: treat as first sync, rewrite it
			}
		}

		const busHeaders: Record<string, string> = { ...headers };
		if (auth) {
			for (const key of Object.keys(busHeaders)) {
				if (key.toLowerCase() === "authorization") delete busHeaders[key];
			}
			busHeaders["Authorization"] = buildBasicAuthHeader(auth);
		}
		if (previous) busHeaders["if-none-match"] = `"${previous.hash}"`;

		const response = await fetch(config.bus.endpoint, {
			headers: busHeaders,
			signal: AbortSignal.timeout(BUS_FETCH_TIMEOUT_MS),
		});
		if (response.status === 304) {
			busChanged = false;
			manifestToEmit = previous;
		} else if (!response.ok) {
			throw new Error(
				`Type bus fetch failed: ${response.status} ${response.statusText} from ${config.bus.endpoint}`,
			);
		} else {
			newManifest = parseManifest(await response.text()); // trust boundary; throws loud
			busChanged = previous === null || previous.hash !== newManifest.hash;
			manifestToEmit = newManifest;
			busDiff = previous && busChanged ? diffManifests(previous, newManifest) : null;
		}
	}

	// --- All fetched and validated: write the pins that changed. ---

	if (specChanged) {
		await writeFile(pinnedSpecPath, specResult.buffer);
		logger.info({ path: pinnedSpecPath }, "Pinned spec updated");
	}
	if (config.bus && busChanged && newManifest && pinnedBusPath) {
		await writeFile(pinnedBusPath, `${JSON.stringify(newManifest, null, "\t")}\n`, "utf8");
		logger.info({ path: pinnedBusPath }, "Pinned bus manifest updated");
	}
	if (busDiff) {
		for (const name of busDiff.added) logger.info(`bus: + ${name}`);
		for (const name of busDiff.changed) logger.info(`bus: ~ ${name}`);
		for (const name of busDiff.removed) logger.warn(`bus: - ${name} (removed)`);
	}

	// --- Regenerate from the pins so the tree is consistent after a sync. ---

	await writeFile(outputPaths.spec, specResult.buffer);
	await saveCacheMetadata(outputPaths.cache, {
		hash: specResult.hash,
		timestamp: Date.now(),
		endpoint: config.api_endpoint as string,
	});
	await generateClientFiles({ paths: outputPaths, instanceConfig: config.instance, logger });
	const hooks = await loadHooks(projectRoot, logger);
	const genResult = await generate({
		paths: outputPaths,
		logger,
		dryRun: false,
		skipTypes: false,
		skipOperations: false,
		hooks,
	});
	let typeCount = 0;
	if (manifestToEmit) {
		await writeBusFiles(manifestToEmit, outputPaths.busDir);
		typeCount = Object.values(manifestToEmit.barrels).flat().length;
	}

	logger.done(
		`sync complete — spec ${specChanged ? "changed" : "unchanged"}` +
			(busChanged === null ? "" : `, bus ${busChanged ? "changed" : "unchanged"}`),
	);

	return {
		specChanged,
		busChanged,
		busDiff,
		typeCount,
		operationCount: genResult.operationCount,
	};
}
