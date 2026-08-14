import { describe, expect, it } from "vitest";

import {
	BUS_VERSION,
	BusVersionError,
	buildManifest,
	diffManifests,
	hashBarrels,
	hashText,
	parseManifest,
} from "../src/core/bus/manifest.js";

const entry = (name: string, declaration: string) => ({
	name,
	kind: "type" as const,
	declaration,
	source: "src/x.chowbea.ts",
	line: 1,
	hash: hashText(declaration),
});

describe("bus manifest", () => {
	it("hashText is stable and content-sensitive", () => {
		expect(hashText("export type A = 1;")).toBe(hashText("export type A = 1;"));
		expect(hashText("export type A = 1;")).not.toBe(hashText("export type A = 2;"));
	});

	it("hashBarrels is independent of key insertion order", () => {
		const a = { one: [entry("A", "export type A = 1;")], two: [entry("B", "export type B = 2;")] };
		const b = { two: [entry("B", "export type B = 2;")], one: [entry("A", "export type A = 1;")] };
		expect(hashBarrels(a)).toBe(hashBarrels(b));
	});

	it("buildManifest stamps version, timestamp, and hash", () => {
		const m = buildManifest({ one: [entry("A", "export type A = 1;")] }, new Date("2026-08-14T00:00:00Z"));
		expect(m.chowbeaBus).toBe(BUS_VERSION);
		expect(m.generatedAt).toBe("2026-08-14T00:00:00.000Z");
		expect(m.hash).toBe(hashBarrels(m.barrels));
	});

	it("parseManifest round-trips and rejects unknown versions", () => {
		const m = buildManifest({ one: [entry("A", "export type A = 1;")] }, new Date(0));
		expect(parseManifest(JSON.stringify(m))).toEqual(m);
		const wrong = JSON.stringify({ ...m, chowbeaBus: "99" });
		expect(() => parseManifest(wrong)).toThrow(BusVersionError);
		expect(() => parseManifest("{}")).toThrow(/malformed/i);
		expect(() => parseManifest("not json")).toThrow();
	});

	it("diffManifests reports added/removed/changed by type name", () => {
		const base = buildManifest(
			{ one: [entry("A", "export type A = 1;"), entry("B", "export type B = 2;")] },
			new Date(0),
		);
		const next = buildManifest(
			{ one: [entry("A", "export type A = 111;"), entry("C", "export type C = 3;")] },
			new Date(0),
		);
		expect(diffManifests(base, next)).toEqual({ added: ["C"], removed: ["B"], changed: ["A"] });
	});
});
