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

export function busHandler(manifest: BusManifest): (req: BusRequest, res: BusResponse) => void {
	const body = JSON.stringify(manifest);
	const etag = `"${manifest.hash}"`;
	return (req, res) => {
		if (req.headers["if-none-match"] === etag) {
			res.statusCode = 304;
			res.end();
			return;
		}
		res.statusCode = 200;
		res.setHeader("content-type", "application/json");
		res.setHeader("etag", etag);
		res.end(body);
	};
}
