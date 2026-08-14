import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { renderBusFiles, writeBusFiles } from "../src/core/bus/emit.js";
import { buildManifest, hashText } from "../src/core/bus/manifest.js";
import { makeBusFixture } from "./helpers/bus-fixture.js";

const entry = (name: string, declaration: string, source: string) => ({
	name,
	kind: "type" as const,
	declaration,
	source,
	line: 1,
	hash: hashText(declaration),
});

const manifest = buildManifest(
	{
		"exams/grade": [entry("Grade", `export type Grade = "A" | "B";`, "src/exams/grade.chowbea.ts")],
		"_marked/billing": [entry("Plan", "export interface Plan { name: string }", "src/billing/plans.ts")],
	},
	new Date(0),
);

describe("bus emission", () => {
	it("renders one file per barrel key with flattened names, plus index", () => {
		const files = renderBusFiles(manifest);
		expect(Object.keys(files).sort()).toEqual(["_marked.billing.ts", "exams.grade.ts", "index.ts"]);
		expect(files["exams.grade.ts"]).toContain(`export type Grade = "A" | "B";`);
		expect(files["exams.grade.ts"]).toContain("DO NOT EDIT MANUALLY");
		expect(files["index.ts"]).toContain(`export * from "./exams.grade";`);
		expect(files["index.ts"]).toContain(`export * from "./_marked.billing";`);
	});

	it("emits no volatile fields (no timestamps, counts, or manifest hash)", () => {
		const files = renderBusFiles(manifest);
		for (const content of Object.values(files)) {
			expect(content).not.toContain(manifest.generatedAt);
			expect(content).not.toContain(manifest.hash);
			expect(content).not.toMatch(/Total|count:/i);
		}
	});

	it("cites the backend source of each type", () => {
		const files = renderBusFiles(manifest);
		expect(files["exams.grade.ts"]).toContain("src/exams/grade.chowbea.ts");
	});

	it("writeBusFiles wipes stale files and writes the current set", async () => {
		const { dir, cleanup } = makeBusFixture({});
		try {
			const busDir = join(dir, "bus");
			await writeBusFiles(manifest, busDir);
			// Second write from a manifest missing one barrel must remove its file.
			const smaller = buildManifest(
				{ "exams/grade": manifest.barrels["exams/grade"] },
				new Date(0),
			);
			await writeBusFiles(smaller, busDir);
			expect(readdirSync(busDir).sort()).toEqual(["exams.grade.ts", "index.ts"]);
			expect(readFileSync(join(busDir, "index.ts"), "utf8")).not.toContain("_marked.billing");
		} finally {
			cleanup();
		}
	});

	it("snapshot", () => {
		expect(renderBusFiles(manifest)).toMatchSnapshot();
	});
});
