import { describe, expect, it } from "vitest";

import { extractBusTypes } from "../src/core/bus/extract.js";
import { makeBusFixture } from "./helpers/bus-fixture.js";

describe("extractBusTypes: sweep", () => {
	it("collects exported types from *.chowbea.ts barrels, keyed by rootDir-relative path", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/exams/models.ts": `export type Grade = "A" | "B";\nexport type StudentId = string;\n`,
			"src/exams/grade.chowbea.ts": `export type { Grade, StudentId } from "./models.js";\nexport type GradeMap = Map<StudentId, Grade>;\n`,
		});
		try {
			const out = extractBusTypes({ projectRoot: dir });
			expect(out.errors).toEqual([]);
			const names = out.barrels["exams/grade"].map((e) => e.name).sort();
			expect(names).toEqual(["Grade", "GradeMap", "StudentId"]);
			const gradeMap = out.barrels["exams/grade"].find((e) => e.name === "GradeMap");
			expect(gradeMap?.kind).toBe("type");
			expect(gradeMap?.declaration).toContain("Map<StudentId, Grade>");
			expect(gradeMap?.source.endsWith("grade.chowbea.ts")).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("re-exported types slice the ORIGINAL declaration, adding export when missing", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/vocab.ts": `type Term = { id: string };\nexport type { Term };\n`,
			"src/bus.chowbea.ts": `export type { Term } from "./vocab.js";\n`,
		});
		try {
			const out = extractBusTypes({ projectRoot: dir });
			expect(out.errors).toEqual([]);
			const term = out.barrels["bus"].find((e) => e.name === "Term");
			expect(term?.declaration).toBe("export type Term = { id: string };");
			expect(term?.source.endsWith("vocab.ts")).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("collects @chowbea-export marked declarations under _marked/<dir>", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/billing/plans.ts": `/** @chowbea-export */\nexport interface Plan {\n\tname: string;\n}\nexport const ignored = 1;\n`,
		});
		try {
			const out = extractBusTypes({ projectRoot: dir });
			expect(out.errors).toEqual([]);
			const plan = out.barrels["_marked/billing"].find((e) => e.name === "Plan");
			expect(plan?.kind).toBe("interface");
			expect(plan?.declaration).toContain("interface Plan");
		} finally {
			cleanup();
		}
	});

	it("collects enums and reports kind", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/bus.chowbea.ts": `export enum Level {\n\tLow = "low",\n\tHigh = "high",\n}\n`,
		});
		try {
			const out = extractBusTypes({ projectRoot: dir });
			expect(out.errors).toEqual([]);
			expect(out.barrels["bus"][0]).toMatchObject({ name: "Level", kind: "enum" });
		} finally {
			cleanup();
		}
	});
});
