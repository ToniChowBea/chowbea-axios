import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../../adapters/logger-interface.js";
import { writeBusFiles } from "./emit.js";
import { diffManifests, parseManifest, type BusDiff, type BusManifest } from "./manifest.js";

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

	const response = await fetch(options.endpoint, { headers });
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
