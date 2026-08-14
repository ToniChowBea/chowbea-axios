import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { busHandler, readBusManifest } from "../src/api/index.js";
import { buildManifest } from "../src/core/bus/manifest.js";
import { makeBusFixture } from "./helpers/bus-fixture.js";

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
});
