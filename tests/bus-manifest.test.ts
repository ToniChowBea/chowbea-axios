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

	// Finding B3: a manifest arrives over the network from the configured bus
	// endpoint — a hostile/compromised endpoint is untrusted input. parseManifest
	// is the trust boundary every fetched manifest passes through.
	describe("parseManifest: structural validation of untrusted input", () => {
		it("rejects a barrel key that could path-traverse out of busDir", () => {
			const m = buildManifest({ one: [entry("A", "export type A = 1;")] }, new Date(0));
			const evil = JSON.stringify({ ...m, barrels: { "..\\evil": m.barrels.one } });
			expect(() => parseManifest(evil)).toThrow(/unsafe barrel key/i);
			expect(() => parseManifest(evil)).toThrow(/\.\.\\evil/);
		});

		it("rejects a barrel key with a `..` path segment", () => {
			const m = buildManifest({ one: [entry("A", "export type A = 1;")] }, new Date(0));
			const evil = JSON.stringify({ ...m, barrels: { "foo/../../evil": m.barrels.one } });
			expect(() => parseManifest(evil)).toThrow(/unsafe barrel key/i);
		});

		it("rejects an entry with a non-string declaration instead of silently emitting `undefined`", () => {
			const m = buildManifest({ one: [entry("A", "export type A = 1;")] }, new Date(0));
			const bad = JSON.stringify({
				...m,
				barrels: { one: [{ ...m.barrels.one[0], declaration: 12345 }] },
			});
			expect(() => parseManifest(bad)).toThrow(/declaration/);
			expect(() => parseManifest(bad)).toThrow(/must be a string/);
		});

		it("rejects an entry with an invalid kind", () => {
			const m = buildManifest({ one: [entry("A", "export type A = 1;")] }, new Date(0));
			const bad = JSON.stringify({
				...m,
				barrels: { one: [{ ...m.barrels.one[0], kind: "class" }] },
			});
			expect(() => parseManifest(bad)).toThrow(/kind/);
		});

		it("rejects an entry with a non-number line", () => {
			const m = buildManifest({ one: [entry("A", "export type A = 1;")] }, new Date(0));
			const bad = JSON.stringify({
				...m,
				barrels: { one: [{ ...m.barrels.one[0], line: "1" }] },
			});
			expect(() => parseManifest(bad)).toThrow(/line/);
		});

		// Finding A1: `declaration` is written verbatim into a generated .ts file
		// the consumer app imports — an executable-code injection surface if a
		// hostile/compromised bus endpoint could smuggle arbitrary statements
		// past a naive "it's a string" check.
		describe("declaration content validation (A1)", () => {
			it("rejects an entry whose declaration is executable code disguised as a type", () => {
				const evilDeclaration = "export const x = 1;";
				const m = buildManifest(
					{
						one: [
							{
								name: "x",
								kind: "type" as const,
								declaration: evilDeclaration,
								source: "src/x.chowbea.ts",
								line: 1,
								hash: hashText(evilDeclaration),
							},
						],
					},
					new Date(0),
				);
				expect(() => parseManifest(JSON.stringify(m))).toThrow(/does not match its declared kind/);
			});

			it("rejects an entry whose declared name doesn't match the entry name", () => {
				const declaration = "export type Other = 1;";
				const m = buildManifest(
					{
						one: [
							{
								name: "A",
								kind: "type" as const,
								declaration,
								source: "src/x.chowbea.ts",
								line: 1,
								hash: hashText(declaration),
							},
						],
					},
					new Date(0),
				);
				expect(() => parseManifest(JSON.stringify(m))).toThrow(
					/declares name "Other" but the entry is named "A"/,
				);
			});

			it("rejects an enum member initializer that isn't a string/numeric literal", () => {
				const declaration = "export enum Level {\n\tLow = someFunction(),\n}";
				const m = buildManifest(
					{
						one: [
							{
								name: "Level",
								kind: "enum" as const,
								declaration,
								source: "src/x.chowbea.ts",
								line: 1,
								hash: hashText(declaration),
							},
						],
					},
					new Date(0),
				);
				expect(() => parseManifest(JSON.stringify(m))).toThrow(
					/enum member initializers must be a string or numeric literal/,
				);
			});

			it("accepts enum members with string, numeric, and negative-numeric initializers", () => {
				const declaration = 'export enum Level {\n\tLow = "low",\n\tMid = 1,\n\tHigh = -2,\n}';
				const m = buildManifest(
					{
						one: [
							{
								name: "Level",
								kind: "enum" as const,
								declaration,
								source: "src/x.chowbea.ts",
								line: 1,
								hash: hashText(declaration),
							},
						],
					},
					new Date(0),
				);
				expect(() => parseManifest(JSON.stringify(m))).not.toThrow();
			});
		});

		// Finding A2: a stale hash otherwise masks real declaration/barrel
		// changes and poisons the If-None-Match / hash-compare cache-skip.
		describe("hash integrity (A2)", () => {
			it("rejects a manifest missing generatedAt", () => {
				const m = buildManifest({ one: [entry("A", "export type A = 1;")] }, new Date(0));
				const { generatedAt: _generatedAt, ...rest } = m;
				expect(() => parseManifest(JSON.stringify(rest))).toThrow(/generatedAt/);
			});

			it("rejects a manifest whose top-level hash doesn't match its barrels content", () => {
				const m = buildManifest({ one: [entry("A", "export type A = 1;")] }, new Date(0));
				const stale = JSON.stringify({ ...m, hash: "0".repeat(64) });
				expect(() => parseManifest(stale)).toThrow(/hash does not match barrels content/);
			});

			it("rejects an entry whose own hash doesn't match its declaration, even when the (unaffected) root hash still matches", () => {
				const m = buildManifest({ one: [entry("A", "export type A = 1;")] }, new Date(0));
				// hashBarrels' canonical projection is [name, kind, declaration,
				// source, line] — it never includes entry.hash — so tampering with
				// only entry.hash leaves the root hash unchanged. Only the
				// per-entry check catches this.
				const stale = JSON.stringify({
					...m,
					barrels: { one: [{ ...m.barrels.one[0], hash: "0".repeat(64) }] },
				});
				expect(() => parseManifest(stale)).toThrow(/hash does not match its declaration content/);
			});
		});

		it("still accepts a well-formed manifest with nested barrel keys and multiple entries", () => {
			const m = buildManifest(
				{
					"exams/grade": [entry("Grade", "export type Grade = 1;"), entry("Id", "export type Id = string;")],
					_marked: [{ ...entry("Plan", "export interface Plan {}"), kind: "interface" as const }],
				},
				new Date(0),
			);
			expect(parseManifest(JSON.stringify(m))).toEqual(m);
		});
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
