import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { busHandler, readBusManifest } from "../src/api/index.js";
import { buildManifest, hashText } from "../src/core/bus/manifest.js";
import { makeBusFixture } from "./helpers/bus-fixture.js";

const entry = (name: string, declaration: string) => ({
	name,
	kind: "type" as const,
	declaration,
	source: "src/x.chowbea.ts",
	line: 1,
	hash: hashText(declaration),
});

/** Same-second writes can share an mtime; force it forward so the file-mode cache sees a change. */
function bumpMtime(path: string) {
	const future = new Date(Date.now() + 5000);
	utimesSync(path, future, future);
}

function mockRes() {
	const headers: Record<string, string> = {};
	let body = "";
	return {
		statusCode: 200,
		setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
		end(chunk?: string) { body = chunk ?? ""; },
		get headers() { return headers; },
		get body() { return body; },
	};
}

describe("chowbea-axios/api", () => {
	it("readBusManifest loads and validates the artifact", () => {
		const { dir, cleanup } = makeBusFixture({});
		try {
			const manifest = buildManifest({}, new Date(0));
			writeFileSync(join(dir, "chowbea.bus.json"), JSON.stringify(manifest));
			expect(readBusManifest(join(dir, "chowbea.bus.json"))).toEqual(manifest);
		} finally {
			cleanup();
		}
	});

	it("busHandler serves JSON with the manifest hash as ETag", () => {
		const manifest = buildManifest({}, new Date(0));
		const res = mockRes();
		busHandler(manifest)({ headers: {} }, res);
		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toBe("application/json");
		expect(res.headers.etag).toBe(`"${manifest.hash}"`);
		expect(JSON.parse(res.body).chowbeaBus).toBe("1");
	});

	it("busHandler answers 304 to a matching If-None-Match", () => {
		const manifest = buildManifest({}, new Date(0));
		const res = mockRes();
		busHandler(manifest)({ headers: { "if-none-match": `"${manifest.hash}"` } }, res);
		expect(res.statusCode).toBe(304);
		expect(res.body).toBe("");
	});

	// Finding F1: If-None-Match is a comma-separated list per RFC 9110 §13.1.2,
	// each entry optionally weak (`W/"..."`), or the wildcard `*`. The naive
	// `=== etag` check missed all of these, and 304 responses never carried
	// their own ETag header.
	describe("busHandler: conditional ETag completeness (finding F1)", () => {
		it("304 response carries the etag header", () => {
			const manifest = buildManifest({}, new Date(0));
			const res = mockRes();
			busHandler(manifest)({ headers: { "if-none-match": `"${manifest.hash}"` } }, res);
			expect(res.statusCode).toBe(304);
			expect(res.headers.etag).toBe(`"${manifest.hash}"`);
		});

		it('a weak-tagged If-None-Match (W/"<hash>") matches and answers 304', () => {
			const manifest = buildManifest({}, new Date(0));
			const res = mockRes();
			busHandler(manifest)({ headers: { "if-none-match": `W/"${manifest.hash}"` } }, res);
			expect(res.statusCode).toBe(304);
		});

		it('a comma-separated list containing the etag ("other", "<hash>") matches and answers 304', () => {
			const manifest = buildManifest({}, new Date(0));
			const res = mockRes();
			busHandler(manifest)({ headers: { "if-none-match": `"other", "${manifest.hash}"` } }, res);
			expect(res.statusCode).toBe(304);
		});

		it("a wildcard If-None-Match (*) always matches and answers 304", () => {
			const manifest = buildManifest({}, new Date(0));
			const res = mockRes();
			busHandler(manifest)({ headers: { "if-none-match": "*" } }, res);
			expect(res.statusCode).toBe(304);
		});

		it("a non-matching list answers 200 with the body and etag", () => {
			const manifest = buildManifest({}, new Date(0));
			const res = mockRes();
			busHandler(manifest)({ headers: { "if-none-match": `"other", "another"` } }, res);
			expect(res.statusCode).toBe(200);
			expect(res.headers.etag).toBe(`"${manifest.hash}"`);
			expect(JSON.parse(res.body).chowbeaBus).toBe("1");
		});
	});

	describe("busHandler: file mode (mtime-aware, re-reads chowbea.bus.json)", () => {
		it("serves the manifest from disk with the correct ETag", () => {
			const { dir, cleanup } = makeBusFixture({});
			try {
				const manifestPath = join(dir, "chowbea.bus.json");
				const manifest = buildManifest({ one: [entry("A", "export type A = 1;")] }, new Date(0));
				writeFileSync(manifestPath, JSON.stringify(manifest));

				const handler = busHandler(manifestPath);
				const res = mockRes();
				handler({ headers: {} }, res);

				expect(res.statusCode).toBe(200);
				expect(res.headers.etag).toBe(`"${manifest.hash}"`);
				expect(JSON.parse(res.body)).toEqual(manifest);
			} finally {
				cleanup();
			}
		});

		it("re-reads and serves a changed manifest once mtime advances", () => {
			const { dir, cleanup } = makeBusFixture({});
			try {
				const manifestPath = join(dir, "chowbea.bus.json");
				const first = buildManifest({ one: [entry("A", "export type A = 1;")] }, new Date(0));
				writeFileSync(manifestPath, JSON.stringify(first));

				const handler = busHandler(manifestPath);
				const res1 = mockRes();
				handler({ headers: {} }, res1);
				expect(res1.headers.etag).toBe(`"${first.hash}"`);

				const second = buildManifest({ two: [entry("B", "export type B = 2;")] }, new Date(1000));
				writeFileSync(manifestPath, JSON.stringify(second));
				bumpMtime(manifestPath);

				const res2 = mockRes();
				handler({ headers: {} }, res2);
				expect(res2.statusCode).toBe(200);
				expect(res2.headers.etag).toBe(`"${second.hash}"`);
				expect(res2.headers.etag).not.toBe(res1.headers.etag);
				expect(JSON.parse(res2.body)).toEqual(second);
			} finally {
				cleanup();
			}
		});

		it("keeps serving the last-good manifest across a bad write, then recovers once content is valid again", () => {
			const { dir, cleanup } = makeBusFixture({});
			try {
				const manifestPath = join(dir, "chowbea.bus.json");
				const good = buildManifest({ one: [entry("A", "export type A = 1;")] }, new Date(0));
				writeFileSync(manifestPath, JSON.stringify(good));

				const handler = busHandler(manifestPath);
				const res1 = mockRes();
				handler({ headers: {} }, res1);
				expect(res1.statusCode).toBe(200);
				expect(res1.headers.etag).toBe(`"${good.hash}"`);

				// Simulate a mid-write partial JSON blob from `extract`.
				writeFileSync(manifestPath, '{"chowbeaBus": "1", "barrels": {');
				bumpMtime(manifestPath);

				const res2 = mockRes();
				handler({ headers: {} }, res2);
				expect(res2.statusCode).toBe(200);
				expect(res2.headers.etag).toBe(`"${good.hash}"`);
				expect(JSON.parse(res2.body)).toEqual(good);

				// Retry: mtime wasn't advanced on failure, so this bump is what lets it pick up the fix.
				const recovered = buildManifest({ two: [entry("B", "export type B = 2;")] }, new Date(2000));
				writeFileSync(manifestPath, JSON.stringify(recovered));
				bumpMtime(manifestPath);

				const res3 = mockRes();
				handler({ headers: {} }, res3);
				expect(res3.statusCode).toBe(200);
				expect(res3.headers.etag).toBe(`"${recovered.hash}"`);
				expect(JSON.parse(res3.body)).toEqual(recovered);
			} finally {
				cleanup();
			}
		});

		it("503s with a plain-text hint when the file is missing, then serves once it's created", () => {
			const { dir, cleanup } = makeBusFixture({});
			try {
				const manifestPath = join(dir, "chowbea.bus.json");
				const handler = busHandler(manifestPath);

				const res1 = mockRes();
				handler({ headers: {} }, res1);
				expect(res1.statusCode).toBe(503);
				expect(res1.headers["content-type"]).toBe("text/plain");
				expect(res1.body).toBe("chowbea bus manifest unavailable — run chowbea-axios extract");

				const manifest = buildManifest({ one: [entry("A", "export type A = 1;")] }, new Date(0));
				writeFileSync(manifestPath, JSON.stringify(manifest));

				const res2 = mockRes();
				handler({ headers: {} }, res2);
				expect(res2.statusCode).toBe(200);
				expect(res2.headers.etag).toBe(`"${manifest.hash}"`);
			} finally {
				cleanup();
			}
		});

		it("answers 304 to a matching If-None-Match, proving the shared response path", () => {
			const { dir, cleanup } = makeBusFixture({});
			try {
				const manifestPath = join(dir, "chowbea.bus.json");
				const manifest = buildManifest({ one: [entry("A", "export type A = 1;")] }, new Date(0));
				writeFileSync(manifestPath, JSON.stringify(manifest));

				const handler = busHandler(manifestPath);
				const res = mockRes();
				handler({ headers: { "if-none-match": `"${manifest.hash}"` } }, res);
				expect(res.statusCode).toBe(304);
				expect(res.headers.etag).toBe(`"${manifest.hash}"`);
				expect(res.body).toBe("");
			} finally {
				cleanup();
			}
		});
	});
});
