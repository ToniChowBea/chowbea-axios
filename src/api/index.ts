/**
 * chowbea/api — the backend-side surface of the Type Bus.
 *
 * Deliberately tiny and framework-agnostic: read the build-time artifact,
 * serve it with ETag support. Mount in Express/Nest with one line:
 *
 *   app.use("/.well-known/chowbea.json", busHandler(readBusManifest()));
 */
import { readFileSync, statSync, type Stats } from "node:fs";
import path from "node:path";

import { parseManifest, type BusManifest } from "../core/bus/manifest.js";

export type { BusManifest } from "../core/bus/manifest.js";

/** Conventional mount path for {@link busHandler} — matches the frontend's default bus fetch URL. */
export const DEFAULT_API_ROUTE = "/.well-known/chowbea.json";

export function readBusManifest(manifestPath?: string): BusManifest {
	const resolved = path.resolve(manifestPath ?? path.join(process.cwd(), "chowbea.bus.json"));
	return parseManifest(readFileSync(resolved, "utf8"));
}

export interface BusRequest {
	headers: Record<string, string | string[] | undefined>;
}

export interface BusResponse {
	statusCode: number;
	setHeader(name: string, value: string): void;
	end(body?: string): void;
}

/**
 * Per RFC 9110 §13.1.2: `If-None-Match` is a comma-separated list of etags,
 * each optionally weak (`W/"..."`), or the wildcard `*` (matches any
 * representation). Weak comparison is enough here — we only compare against
 * our own strong etag, so a client's weak-tagged copy still counts as a
 * match.
 */
function matchesIfNoneMatch(headerValue: string, strongEtag: string): boolean {
	const trimmed = headerValue.trim();
	if (trimmed === "*") return true;
	return trimmed
		.split(",")
		.map((tag) => tag.trim())
		.map((tag) => (tag.startsWith("W/") ? tag.slice(2) : tag))
		.includes(strongEtag);
}

interface BusSnapshot {
	body: string;
	etag: string;
}

function snapshotFromManifest(manifest: BusManifest): BusSnapshot {
	return { body: JSON.stringify(manifest), etag: `"${manifest.hash}"` };
}

/** Shared response-writing path for both the static and file-backed `busHandler` modes. */
function writeBusSnapshot(snapshot: BusSnapshot, req: BusRequest, res: BusResponse): void {
	const ifNoneMatch = req.headers["if-none-match"];
	const headerValue = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(", ") : ifNoneMatch;
	if (headerValue !== undefined && matchesIfNoneMatch(headerValue, snapshot.etag)) {
		res.statusCode = 304;
		res.setHeader("etag", snapshot.etag);
		res.end();
		return;
	}
	res.statusCode = 200;
	res.setHeader("content-type", "application/json");
	res.setHeader("etag", snapshot.etag);
	res.end(snapshot.body);
}

function writeBusUnavailable(res: BusResponse): void {
	res.statusCode = 503;
	res.setHeader("content-type", "text/plain");
	res.end("chowbea bus manifest unavailable — run chowbea extract");
}

interface CachedBusFile {
	mtimeMs: number;
	size: number;
	snapshot: BusSnapshot;
}

/**
 * File-backed mode: re-stats `manifestPath` on every request (one `statSync`
 * — negligible in prod) and only re-reads + re-parses when mtime or size
 * changed, so `chowbea extract` writes show up without a server
 * restart. A read/parse failure (e.g. a partial write mid-`extract`) keeps
 * serving the last-good snapshot and leaves the cached mtime untouched so
 * the next request retries; with no last-good snapshot yet, it answers 503.
 */
function busHandlerForFile(manifestPath?: string): (req: BusRequest, res: BusResponse) => void {
	const resolved = path.resolve(manifestPath ?? path.join(process.cwd(), "chowbea.bus.json"));
	let cached: CachedBusFile | undefined;

	return (req, res) => {
		let stat: Stats | undefined;
		try {
			stat = statSync(resolved);
		} catch {
			stat = undefined;
		}

		if (stat && (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size)) {
			try {
				const manifest = parseManifest(readFileSync(resolved, "utf8"));
				cached = { mtimeMs: stat.mtimeMs, size: stat.size, snapshot: snapshotFromManifest(manifest) };
			} catch {
				// Partial write mid-extract, or invalid content: keep the last-good
				// snapshot (if any) and don't touch `cached`, so the stale mtime
				// forces a retry on the next request instead of wedging on bad data.
			}
		}

		if (!cached) {
			writeBusUnavailable(res);
			return;
		}
		writeBusSnapshot(cached.snapshot, req, res);
	};
}

export function busHandler(manifest: BusManifest): (req: BusRequest, res: BusResponse) => void;
export function busHandler(manifestPath?: string): (req: BusRequest, res: BusResponse) => void;
export function busHandler(arg?: BusManifest | string): (req: BusRequest, res: BusResponse) => void {
	if (typeof arg === "object") {
		const snapshot = snapshotFromManifest(arg);
		return (req, res) => writeBusSnapshot(snapshot, req, res);
	}
	return busHandlerForFile(arg);
}
