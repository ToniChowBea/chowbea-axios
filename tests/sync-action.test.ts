import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executeSync } from "../src/core/actions/sync.js";
import { buildManifest, hashText } from "../src/core/bus/manifest.js";
import { DEFAULT_CONFIG, generateConfigTemplate, getOutputPaths } from "../src/core/config.js";
import { buildBasicAuthHeader } from "../src/core/fetcher.js";
import { makeBusFixture } from "./helpers/bus-fixture.js";
import { SILENT_LOGGER } from "./helpers/logger.js";

const PETSTORE_SPEC = readFileSync(new URL("./fixtures/petstore.json", import.meta.url), "utf8");

function entry(name: string, declaration: string, source = "src/types.chowbea.ts") {
	return { name, kind: "type" as const, declaration, source, line: 1, hash: hashText(declaration) };
}

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

/** Serves the spec at /openapi.json and the manifest at /bus.json; records bus request headers. */
function serveBackend(spec: string, manifestJson: string, seenBusHeaders: Record<string, string | string[] | undefined>[] = []): Promise<string> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			if (req.url === "/openapi.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(spec); return; }
			if (req.url === "/bus.json") {
				seenBusHeaders.push(req.headers);
				res.writeHead(200, { "content-type": "application/json" }); res.end(manifestJson); return;
			}
			res.writeHead(404); res.end();
		});
		servers.push(server);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as { port: number };
			resolve(`http://127.0.0.1:${addr.port}`);
		});
	});
}

/** Like serveBackend, but /bus.json replies 304 (no body) when If-None-Match matches the manifest's quoted hash. */
function serveBackendConditionalBus(spec: string, manifest: { hash: string }, manifestJson: string): Promise<string> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			if (req.url === "/openapi.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(spec); return; }
			if (req.url === "/bus.json") {
				if (req.headers["if-none-match"] === `"${manifest.hash}"`) { res.writeHead(304); res.end(); return; }
				res.writeHead(200, { "content-type": "application/json" }); res.end(manifestJson); return;
			}
			res.writeHead(404); res.end();
		});
		servers.push(server);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as { port: number };
			resolve(`http://127.0.0.1:${addr.port}`);
		});
	});
}

function fixture(baseUrl: string, extra: Record<string, string> = {}) {
	const config = {
		...DEFAULT_CONFIG,
		api_endpoint: `${baseUrl}/openapi.json`,
		spec_file: "openapi.json",
		output: { folder: "api" },
		bus: { endpoint: `${baseUrl}/bus.json`, file: "chowbea.bus.json" },
	};
	const { dir, cleanup } = makeBusFixture({
		"package.json": JSON.stringify({ name: "consumer", version: "0.0.0" }),
		"api.config.toml": generateConfigTemplate(config),
		...extra,
	});
	return { dir, cleanup, config };
}

/** loadConfig resolves projectRoot from cwd — every executeSync runs chdir'd into the fixture. */
async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	const orig = process.cwd();
	process.chdir(dir);
	try {
		return await fn();
	} finally {
		process.chdir(orig);
	}
}

function runSync(dir: string) {
	return inDir(dir, () => executeSync({ configPath: join(dir, "api.config.toml") }, SILENT_LOGGER));
}

const manifest = buildManifest({ core: [entry("Grade", `export type Grade = "A" | "B";`)] });
const manifestJson = `${JSON.stringify(manifest, null, "\t")}\n`;

describe("executeSync", () => {
	it("first sync writes both pinned files and regenerates", async () => {
		const base = await serveBackend(PETSTORE_SPEC, manifestJson);
		const { dir, cleanup, config } = fixture(base);
		try {
			const result = await runSync(dir);
			expect(result.specChanged).toBe(true);
			expect(result.busChanged).toBe(true);
			expect(JSON.parse(readFileSync(join(dir, "openapi.json"), "utf8"))).toEqual(JSON.parse(PETSTORE_SPEC));
			expect(readFileSync(join(dir, "chowbea.bus.json"), "utf8")).toBe(manifestJson);
			const paths = getOutputPaths(config, dir);
			expect(readFileSync(join(paths.busDir, "core.ts"), "utf8")).toContain("Grade");
			expect(existsSync(paths.operations)).toBe(true);
			expect(result.typeCount).toBe(1);
			expect(result.operationCount).toBeGreaterThan(0);
			expect(result.busDiff).toBeNull();
		} finally { cleanup(); }
	});

	it("unchanged upstream writes nothing (byte-identical pins) and sends If-None-Match", async () => {
		const seen: Record<string, string | string[] | undefined>[] = [];
		const base = await serveBackend(PETSTORE_SPEC, manifestJson, seen);
		const { dir, cleanup } = fixture(base);
		try {
			await runSync(dir);
			const specBytes = readFileSync(join(dir, "openapi.json"));
			const busBytes = readFileSync(join(dir, "chowbea.bus.json"));
			const second = await runSync(dir);
			expect(second.specChanged).toBe(false);
			expect(second.busChanged).toBe(false);
			expect(readFileSync(join(dir, "openapi.json"))).toEqual(specBytes);
			expect(readFileSync(join(dir, "chowbea.bus.json"))).toEqual(busBytes);
			expect(seen[1]["if-none-match"]).toBe(`"${manifest.hash}"`);
		} finally { cleanup(); }
	});

	it("reports the bus diff against the previous pin", async () => {
		const base = await serveBackend(PETSTORE_SPEC, manifestJson);
		const { dir, cleanup } = fixture(base, {
			"chowbea.bus.json": `${JSON.stringify(buildManifest({ core: [entry("Old", "export type Old = 1;")] }), null, "\t")}\n`,
		});
		try {
			const result = await runSync(dir);
			expect(result.busDiff).toEqual({ added: ["Grade"], removed: ["Old"], changed: [] });
		} finally { cleanup(); }
	});

	it("a failing bus endpoint writes nothing at all — not even the changed spec", async () => {
		const base = await serveBackend(PETSTORE_SPEC, manifestJson);
		const { dir, cleanup } = fixture(base);
		writeFileSync(
			join(dir, "api.config.toml"),
			readFileSync(join(dir, "api.config.toml"), "utf8").replace("/bus.json", "/missing.json"),
			"utf8",
		);
		try {
			await expect(runSync(dir)).rejects.toThrow(/404/);
			expect(existsSync(join(dir, "openapi.json"))).toBe(false);
		} finally { cleanup(); }
	});

	it("ignores api.config.local.toml", async () => {
		const base = await serveBackend(PETSTORE_SPEC, manifestJson);
		const { dir, cleanup } = fixture(base, {
			"api.config.local.toml": `api_endpoint = "http://127.0.0.1:1/openapi.json"\n`,
		});
		try {
			const result = await runSync(dir);
			expect(result.specChanged).toBe(true); // used the committed endpoint, not the dead local one
		} finally { cleanup(); }
	});

	it("requires pinned-mode config", async () => {
		const { dir, cleanup } = fixture("http://127.0.0.1:1");
		writeFileSync(
			join(dir, "api.config.toml"),
			readFileSync(join(dir, "api.config.toml"), "utf8").replace(/spec_file = .*\n/, ""),
			"utf8",
		);
		try {
			await expect(runSync(dir)).rejects.toThrow(/spec_file/);
		} finally { cleanup(); }
	});

	it("a 304 from the bus endpoint counts as unchanged", async () => {
		const base = await serveBackendConditionalBus(PETSTORE_SPEC, manifest, manifestJson);
		const { dir, cleanup } = fixture(base);
		try {
			await runSync(dir);
			const specBytes = readFileSync(join(dir, "openapi.json"));
			const busBytes = readFileSync(join(dir, "chowbea.bus.json"));
			const second = await runSync(dir);
			expect(second.specChanged).toBe(false);
			expect(second.busChanged).toBe(false);
			expect(readFileSync(join(dir, "openapi.json"))).toEqual(specBytes);
			expect(readFileSync(join(dir, "chowbea.bus.json"))).toEqual(busBytes);
		} finally { cleanup(); }
	});

	it("refuses to pin from the cache fallback after network failure", async () => {
		const base = await serveBackend(PETSTORE_SPEC, manifestJson);
		const server = servers.at(-1)!;
		const { dir, cleanup } = fixture(base);
		try {
			await runSync(dir); // populates the _internal spec + cache metadata
			server.close();
			server.closeAllConnections();
			await expect(runSync(dir)).rejects.toThrow(/refusing to pin from the cache fallback/);
		} finally { cleanup(); }
	}, 10_000);

	it("sends Basic Auth, not the explicit header, to the bus endpoint when [fetch.auth] is configured", async () => {
		const seen: Record<string, string | string[] | undefined>[] = [];
		const base = await serveBackend(PETSTORE_SPEC, manifestJson, seen);
		const { dir, cleanup } = fixture(base);
		process.env.SYNC_TEST_USER = "test-user";
		process.env.SYNC_TEST_PASS = "test-basic-auth-placeholder";
		try {
			writeFileSync(
				join(dir, "api.config.toml"),
				`${readFileSync(join(dir, "api.config.toml"), "utf8")}\n[fetch.headers]\nAuthorization = "Bearer wrong"\n\n[fetch.auth]\ntype = "basic"\nusername = "$SYNC_TEST_USER"\npassword = "$SYNC_TEST_PASS"\n`,
				"utf8",
			);
			await runSync(dir);
			const expected = buildBasicAuthHeader({ username: "test-user", password: "test-basic-auth-placeholder" });
			expect(seen[0]["authorization"]).toBe(expected);
		} finally {
			delete process.env.SYNC_TEST_USER;
			delete process.env.SYNC_TEST_PASS;
			cleanup();
		}
	});
});
