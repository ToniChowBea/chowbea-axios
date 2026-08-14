/**
 * chowbea-axios/api — the backend-side surface of the Type Bus.
 *
 * Deliberately tiny and framework-agnostic: read the build-time artifact,
 * serve it with ETag support. Mount in Express/Nest with one line:
 *
 *   app.use("/.well-known/chowbea.json", busHandler(readBusManifest()));
 */
import { readFileSync } from "node:fs";
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

export function busHandler(manifest: BusManifest): (req: BusRequest, res: BusResponse) => void {
	const body = JSON.stringify(manifest);
	const etag = `"${manifest.hash}"`;
	return (req, res) => {
		const ifNoneMatch = req.headers["if-none-match"];
		const headerValue = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(", ") : ifNoneMatch;
		if (headerValue !== undefined && matchesIfNoneMatch(headerValue, etag)) {
			res.statusCode = 304;
			res.setHeader("etag", etag);
			res.end();
			return;
		}
		res.statusCode = 200;
		res.setHeader("content-type", "application/json");
		res.setHeader("etag", etag);
		res.end(body);
	};
}
