import { describe, expect, it } from "vitest";

import { extractBusManifest, extractBusTypes } from "../src/core/bus/extract.js";
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

	it("marking a non-type declaration reports the types-only error instead of silently dropping it", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/svc.ts": `/** @chowbea-export */\nexport class Svc {}\n/** @chowbea-export */\nexport const LIMIT = 1;\n`,
		});
		try {
			const out = extractBusTypes({ projectRoot: dir });
			expect(out.errors).toHaveLength(2);
			expect(out.errors.every((e) => /only types ride the bus/.test(e.message))).toBe(true);
			expect(out.barrels).toEqual({});
		} finally {
			cleanup();
		}
	});
});

describe("extractBusTypes: validation", () => {
	it("duplicate registration errors name both sites", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/models.ts": `/** @chowbea-export */\nexport type Grade = "A";\n`,
			"src/bus.chowbea.ts": `export type { Grade } from "./models.js";\n`,
		});
		try {
			const out = extractBusTypes({ projectRoot: dir });
			expect(out.errors).toHaveLength(1);
			expect(out.errors[0].message).toContain('"Grade" is registered twice');
			expect(out.errors[0].message).toContain("src/models.ts");
			expect(out.errors[0].message).toContain("src/bus.chowbea.ts");
		} finally {
			cleanup();
		}
	});

	it("closed world: referencing a non-bus project type errors with a fix instruction", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/models.ts": `export type Grade = "A" | "B";\n`,
			"src/bus.chowbea.ts": `import type { Grade } from "./models.js";\nexport type GradeMap = Map<string, Grade>;\n`,
		});
		try {
			const out = extractBusTypes({ projectRoot: dir });
			expect(out.errors).toHaveLength(1);
			expect(out.errors[0].message).toContain('"GradeMap" references "Grade"');
			expect(out.errors[0].message).toContain("src/models.ts");
			expect(out.errors[0].message).toContain(".chowbea.ts barrel or mark it @chowbea-export");
		} finally {
			cleanup();
		}
	});

	it("closed world: `typeof` a non-bus const always errors — values never ride the bus", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/consts.ts": `export const LIMIT = 10;\n`,
			"src/bus.chowbea.ts": `import { LIMIT } from "./consts.js";\nexport type T = typeof LIMIT;\n`,
		});
		try {
			const out = extractBusTypes({ projectRoot: dir });
			expect(out.errors).toHaveLength(1);
			expect(out.errors[0].message).toMatch(/typeof/);
			expect(out.errors[0].message).toMatch(/values/i);
		} finally {
			cleanup();
		}
	});

	it("closed world: import(\"./x.js\").Foo referencing a non-bus type is a standard closed-world error", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/models.ts": `export type Foo = { x: number };\n`,
			"src/bus.chowbea.ts": `export type T = import("./models.js").Foo;\n`,
		});
		try {
			const out = extractBusTypes({ projectRoot: dir });
			expect(out.errors).toHaveLength(1);
			expect(out.errors[0].message).toContain('"T" references "Foo"');
			expect(out.errors[0].message).toContain("src/models.ts");
			expect(out.errors[0].message).toContain(".chowbea.ts barrel or mark it @chowbea-export");
		} finally {
			cleanup();
		}
	});

	it('closed world: import("./x.js").Foo is fine when Foo is itself on the bus', () => {
		const { dir, cleanup } = makeBusFixture({
			"src/models.ts": `/** @chowbea-export */\nexport type Foo = { x: number };\n`,
			"src/bus.chowbea.ts": `export type T = import("./models.js").Foo;\n`,
		});
		try {
			expect(extractBusTypes({ projectRoot: dir }).errors).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("closed world: TS lib built-ins, primitives, generics, and bus-to-bus refs are fine", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/bus.chowbea.ts": [
				`export type Id = string;`,
				`export interface Box<T> { value: T; at: Date }`,
				`export type Lookup = Map<Id, Partial<Box<number>>>;`,
				"export type Tpl = `id-${string}`;",
			].join("\n"),
		});
		try {
			expect(extractBusTypes({ projectRoot: dir }).errors).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("closed world: node_modules type references error in v1", () => {
		const { dir, cleanup } = makeBusFixture({
			"node_modules/somepkg/index.d.ts": `export type External = { x: number };\n`,
			"node_modules/somepkg/package.json": `{ "name": "somepkg", "types": "index.d.ts" }`,
			"src/bus.chowbea.ts": `import type { External } from "somepkg";\nexport type Wrapped = { inner: External };\n`,
		});
		try {
			const out = extractBusTypes({ projectRoot: dir });
			expect(out.errors).toHaveLength(1);
			expect(out.errors[0].message).toContain("node_modules");
		} finally {
			cleanup();
		}
	});

	it("a barrel under a _marked/ directory is rejected (reserved prefix)", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/_marked/x.chowbea.ts": `export type A = 1;\n`,
		});
		try {
			const out = extractBusTypes({ projectRoot: dir });
			expect(out.errors).toHaveLength(1);
			expect(out.errors[0].message).toContain("_marked");
			expect(out.errors[0].message).toContain("reserved");
		} finally {
			cleanup();
		}
	});

	// Finding B2: `key.startsWith(RESERVED_PREFIX)` wrongly rejected any key
	// beginning with the literal substring "_marked", not just the reserved
	// "_marked" / "_marked/*" segment — "_markedly" is a legitimate directory.
	it("a barrel under _markedly/ (shares a prefix with, but isn't, the reserved _marked/ namespace) extracts clean", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/_markedly/x.chowbea.ts": `export type A = 1;\n`,
		});
		try {
			const out = extractBusTypes({ projectRoot: dir });
			expect(out.errors).toEqual([]);
			expect(out.barrels["_markedly/x"]?.map((e) => e.name)).toEqual(["A"]);
		} finally {
			cleanup();
		}
	});

	// Finding B1: barrelKey/markedKey derive a manifest key via
	// `path.relative(rootDir, fileName)` — a `.chowbea.ts` file outside
	// `rootDir` but still swept in via tsconfig `include` produces a `..`
	// segment, the same path-traversal shape parseManifest's
	// isSafeBarrelKey rejects at the network trust boundary.
	it("a barrel outside the tsconfig rootDir is rejected, not turned into a path-traversal key", () => {
		const { dir, cleanup } = makeBusFixture({
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					rootDir: "src",
					noEmit: true,
					skipLibCheck: true,
					module: "nodenext",
					moduleResolution: "nodenext",
				},
				include: ["src/**/*.ts", "outside/**/*.ts"],
			}),
			"src/empty.ts": `export {};\n`,
			"outside/x.chowbea.ts": `export type A = 1;\n`,
		});
		try {
			const out = extractBusTypes({ projectRoot: dir });
			expect(out.errors).toHaveLength(1);
			expect(out.errors[0].message).toContain("outside the tsconfig rootDir");
			expect(out.barrels).toEqual({});
		} finally {
			cleanup();
		}
	});

	it('barrel key "index" is reserved for the generated re-export index', () => {
		const { dir, cleanup } = makeBusFixture({
			"src/index.chowbea.ts": `export type Special = string;\n`,
		});
		try {
			const out = extractBusTypes({ projectRoot: dir });
			expect(out.errors).toHaveLength(1);
			expect(out.errors[0].message).toContain("index");
			expect(out.errors[0].message).toContain("reserved");
		} finally {
			cleanup();
		}
	});

	it("class on the bus is a types-only error (already covered by sweep) — const via barrel too", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/bus.chowbea.ts": `export const LIMIT = 10;\nexport class Svc {}\n`,
		});
		try {
			const out = extractBusTypes({ projectRoot: dir });
			expect(out.errors).toHaveLength(2);
			for (const err of out.errors) expect(err.message).toContain("only types ride the bus");
		} finally {
			cleanup();
		}
	});

	it("reports ALL violations in one pass, not fail-on-first", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/a.ts": `export type Hidden = 1;\n`,
			"src/bus.chowbea.ts": `import type { Hidden } from "./a.js";\nexport type UsesHidden = { h: Hidden };\nexport const nope = 1;\n`,
		});
		try {
			expect(extractBusTypes({ projectRoot: dir }).errors).toHaveLength(2);
		} finally {
			cleanup();
		}
	});

	it("closed world: two different non-bus types sharing a name both error (dedup is by identity, not name)", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/a.ts": `export type Hidden = 1;\n`,
			"src/b.ts": `export type Hidden = 2;\n`,
			"src/bus.chowbea.ts": [
				`import type { Hidden } from "./a.js";`,
				`import type { Hidden as AlsoHidden } from "./b.js";`,
				`export type Uses = { a: Hidden; b: AlsoHidden };`,
			].join("\n"),
		});
		try {
			const out = extractBusTypes({ projectRoot: dir });
			expect(out.errors).toHaveLength(2);
			const files = out.errors.map((e) => e.message).sort();
			expect(files.some((m) => m.includes("src/a.ts"))).toBe(true);
			expect(files.some((m) => m.includes("src/b.ts"))).toBe(true);
		} finally {
			cleanup();
		}
	});
});

describe("extractBusManifest: fidelity + assembly", () => {
	it("slices generics, mapped, conditional, and template-literal types verbatim", () => {
		const decls = [
			`export type Keys<T> = { [K in keyof T]: T[K] extends string ? K : never };`,
			`export type Route = \`/api/\${string}\`;`,
			`export interface Paged<T> {\n\titems: T[];\n\tnext?: Route;\n}`,
		].join("\n");
		const { dir, cleanup } = makeBusFixture({ "src/bus.chowbea.ts": `${decls}\n` });
		try {
			const { manifest, errors } = extractBusManifest({ projectRoot: dir, now: new Date(0) });
			expect(errors).toEqual([]);
			const byName = Object.fromEntries(
				Object.values(manifest!.barrels).flat().map((e) => [e.name, e.declaration]),
			);
			expect(byName.Keys).toBe(
				`export type Keys<T> = { [K in keyof T]: T[K] extends string ? K : never };`,
			);
			expect(byName.Route).toBe("export type Route = `/api/${string}`;");
			expect(byName.Paged).toContain("next?: Route;");
		} finally {
			cleanup();
		}
	});

	it("returns null manifest when any error exists", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/bus.chowbea.ts": `export const nope = 1;\n`,
		});
		try {
			const { manifest, errors } = extractBusManifest({ projectRoot: dir });
			expect(manifest).toBeNull();
			expect(errors).toHaveLength(1);
		} finally {
			cleanup();
		}
	});

	it("manifest snapshot: stable shape and version", () => {
		const { dir, cleanup } = makeBusFixture({
			"src/exams/grade.chowbea.ts": `export type Grade = "A" | "B";\n`,
			"src/billing/plans.ts": `/** @chowbea-export */\nexport interface Plan { name: string }\n`,
		});
		try {
			const { manifest } = extractBusManifest({ projectRoot: dir, now: new Date(0) });
			expect(manifest).toMatchSnapshot();
		} finally {
			cleanup();
		}
	});
});
