import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../../adapters/logger-interface.js";
import type { ApiConfig, OutputPaths } from "../config.js";
import { buildBasicAuthHeader, interpolateHeaders, resolveBasicAuthNonInteractive } from "../fetcher.js";
import { writeBusFiles } from "./emit.js";
import { diffManifests, parseManifest, type BusDiff, type BusManifest } from "./manifest.js";

/**
 * Shared HTTP timeout for bus manifest fetches (syncBus's own fetch, and
 * `extract --diff <url>`'s baseline fetch) — CI must never hang indefinitely
 * on a dead/unreachable bus endpoint.
 */
export const BUS_FETCH_TIMEOUT_MS = 30_000;

export interface BusSyncResult {
	/** false when the endpoint returned 304, or the fetched manifest hash is unchanged. */
	fetched: boolean;
	typeCount: number;
	/** Diff vs. the previously cached manifest; null on first sync. */
	diff: BusDiff | null;
	/** Emitted file paths; [] when emission was skipped as unchanged. */
	written: string[];
}

async function loadCached(busCachePath: string): Promise<BusManifest | null> {
	try {
		return parseManifest(await readFile(busCachePath, "utf8"));
	} catch {
		return null; // no cache / stale format — treat as first sync
	}
}

/**
 * Fetches the published Type Bus manifest, version-gates it, diffs against
 * the previously cached manifest, then caches and emits the barrel files.
 *
 * Version mismatches (BusVersionError) and network failures propagate to the
 * caller verbatim — this mirrors how spec fetching surfaces errors.
 */
export async function syncBus(options: {
	endpoint: string;
	headers?: Record<string, string>;
	busCachePath: string;
	busDir: string;
	logger: Logger;
}): Promise<BusSyncResult> {
	const cached = await loadCached(options.busCachePath);
	const headers: Record<string, string> = { ...options.headers };
	if (cached) headers["if-none-match"] = `"${cached.hash}"`;

	const response = await fetch(options.endpoint, {
		headers,
		signal: AbortSignal.timeout(BUS_FETCH_TIMEOUT_MS),
	});
	if (response.status === 304) {
		return { fetched: false, typeCount: 0, diff: null, written: [] };
	}
	if (!response.ok) {
		throw new Error(`Type bus fetch failed: ${response.status} ${response.statusText} from ${options.endpoint}`);
	}
	const manifest = parseManifest(await response.text()); // BusVersionError propagates
	if (cached && cached.hash === manifest.hash) {
		return { fetched: false, typeCount: 0, diff: null, written: [] };
	}

	const diff = cached ? diffManifests(cached, manifest) : null;
	if (diff) {
		for (const name of diff.added) options.logger.info(`bus: + ${name}`);
		for (const name of diff.changed) options.logger.info(`bus: ~ ${name}`);
		for (const name of diff.removed) options.logger.warn(`bus: - ${name} (removed)`);
	}

	// Emit first: writeBusFiles throws on filename collisions, and the cache
	// must never be stamped with a manifest that failed to emit — otherwise
	// the next sync sees a matching hash and silently reports "unchanged"
	// while busDir stays empty (the failure would be permanently masked).
	const written = await writeBusFiles(manifest, options.busDir);
	await mkdir(path.dirname(options.busCachePath), { recursive: true });
	await writeFile(options.busCachePath, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
	const typeCount = Object.values(manifest.barrels).flat().length;
	return { fetched: true, typeCount, diff, written };
}

/**
 * Runs `syncBus()` using `[bus]`/`[fetch.auth]`/`[fetch.headers]` from a
 * loaded `ApiConfig`. Returns `null` when `[bus]` isn't configured — the
 * shared no-op both `fetch` and `watch` need (spec §5/§7: both entry points
 * sync the bus alongside the spec).
 *
 * `[fetch.auth]` and `[fetch.headers]` apply to bus fetches too, same as
 * spec fetching: Basic Auth is resolved non-interactively (never prompts —
 * a bus sync must never block on a TTY) and wins over any explicit
 * Authorization header, matching `fetchOpenApiSpec`'s own precedence.
 *
 * `resolvedAuth`, when provided, is used INSTEAD of resolving
 * `[fetch.auth]` non-interactively. This lets a caller that already
 * resolved Basic Auth interactively for the spec request (env vars unset,
 * prompted a human) reuse those credentials here rather than re-resolving
 * non-interactively — which would fail outright, since a bus sync has no
 * TTY to prompt on.
 */
export async function syncBusFromConfig(
	config: ApiConfig,
	outputPaths: OutputPaths,
	logger: Logger,
	resolvedAuth?: { username: string; password: string },
): Promise<BusSyncResult | null> {
	if (!config.bus) return null;

	const headers: Record<string, string> = config.fetch?.headers
		? interpolateHeaders(config.fetch.headers)
		: {};
	const auth =
		resolvedAuth ??
		(config.fetch?.auth?.type === "basic" ? resolveBasicAuthNonInteractive(config.fetch.auth) : undefined);
	if (auth) {
		for (const key of Object.keys(headers)) {
			if (key.toLowerCase() === "authorization") delete headers[key];
		}
		headers["Authorization"] = buildBasicAuthHeader(auth);
	}

	const result = await syncBus({
		endpoint: config.bus.endpoint,
		headers: Object.keys(headers).length > 0 ? headers : undefined,
		busCachePath: outputPaths.busCache,
		busDir: outputPaths.busDir,
		logger,
	});
	if (result.fetched) {
		logger.done(`Type bus: ${result.typeCount} type(s) synced`);
	} else {
		logger.info("Type bus: unchanged");
	}
	return result;
}
