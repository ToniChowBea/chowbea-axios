import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildManifest, hashText } from "../src/core/bus/manifest.js";
import { syncBus } from "../src/core/bus/fetch.js";
import { makeBusFixture } from "./helpers/bus-fixture.js";
import { SILENT_LOGGER } from "./helpers/logger.js";

const entry = (name: string, declaration: string) => ({
	name,
	kind: "type" as const,
	declaration,
	source: "src/bus.chowbea.ts",
	line: 1,
	hash: hashText(declaration),
});

let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

function serve(manifest: object): Promise<string> {
	return new Promise((resolve) => {
		server = createServer((req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(manifest));
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server!.address() as { port: number };
			resolve(`http://127.0.0.1:${addr.port}/.well-known/chowbea.json`);
		});
	});
}

describe("syncBus", () => {
	it("first sync fetches, caches, and emits", async () => {
		const { dir, cleanup } = makeBusFixture({});
		try {
			const manifest = buildManifest({ core: [entry("A", "export type A = 1;")] }, new Date(0));
			const endpoint = await serve(manifest);
			const busCachePath = join(dir, "_internal", "chowbea.bus.json");
			const busDir = join(dir, "_generated", "bus");
			const result = await syncBus({ endpoint, busCachePath, busDir, logger: SILENT_LOGGER });
			expect(result).toMatchObject({ fetched: true, typeCount: 1, diff: null });
			expect(existsSync(busCachePath)).toBe(true);
			expect(readFileSync(join(busDir, "core.ts"), "utf8")).toContain("export type A = 1;");
		} finally {
			cleanup();
		}
	});

	it("unchanged hash skips emission; changed manifest diffs against cache", async () => {
		const { dir, cleanup } = makeBusFixture({});
		try {
			const v1 = buildManifest({ core: [entry("A", "export type A = 1;")] }, new Date(0));
			const busCachePath = join(dir, "cache.json");
			const busDir = join(dir, "bus");
			const first = await syncBus({ endpoint: await serve(v1), busCachePath, busDir, logger: SILENT_LOGGER });
			expect(first.fetched).toBe(true);
			server?.close();

			const again = await syncBus({ endpoint: await serve(v1), busCachePath, busDir, logger: SILENT_LOGGER });
			expect(again).toMatchObject({ fetched: false, written: [] });
			server?.close();

			const v2 = buildManifest(
				{ core: [entry("A", "export type A = 2;"), entry("B", "export type B = 1;")] },
				new Date(0),
			);
			const changed = await syncBus({ endpoint: await serve(v2), busCachePath, busDir, logger: SILENT_LOGGER });
			expect(changed.fetched).toBe(true);
			expect(changed.diff).toEqual({ added: ["B"], removed: [], changed: ["A"] });
		} finally {
			cleanup();
		}
	});

	it("unknown manifest version fails loud with the upgrade message", async () => {
		const { dir, cleanup } = makeBusFixture({});
		try {
			const endpoint = await serve({ chowbeaBus: "99", hash: "x", barrels: {}, generatedAt: "" });
			await expect(
				syncBus({
					endpoint,
					busCachePath: join(dir, "c.json"),
					busDir: join(dir, "bus"),
					logger: SILENT_LOGGER,
				}),
			).rejects.toThrow(/upgrade chowbea-axios/i);
		} finally {
			cleanup();
		}
	});

	it("emission collision does not stamp the cache — retry stays a real retry", async () => {
		const { dir, cleanup } = makeBusFixture({});
		try {
			const colliding = buildManifest(
				{
					"v1.2/foo": [entry("A", "export type A = 1;")],
					"v1/2/foo": [entry("B", "export type B = 2;")],
				},
				new Date(0),
			);
			const endpoint = await serve(colliding);
			const busCachePath = join(dir, "cache.json");
			const busDir = join(dir, "bus");

			await expect(
				syncBus({ endpoint, busCachePath, busDir, logger: SILENT_LOGGER }),
			).rejects.toThrow(/filename collision/);
			expect(existsSync(busCachePath)).toBe(false);

			// Same server, same manifest — must fail loud again, not silently
			// report {fetched:false} because the (never-written) cache now
			// "matches".
			await expect(
				syncBus({ endpoint, busCachePath, busDir, logger: SILENT_LOGGER }),
			).rejects.toThrow(/filename collision/);
		} finally {
			cleanup();
		}
	});
});
