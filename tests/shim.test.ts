import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) =>
	readFileSync(new URL(`../shim/${p}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json")) as {
	name: string;
	dependencies: Record<string, string>;
	bin: Record<string, string>;
	exports: Record<string, { import?: string; require?: string; types?: string }>;
	peerDependencies?: Record<string, string>;
	engines?: Record<string, string>;
};
const root = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { peerDependencies?: Record<string, string>; engines?: Record<string, string> };

describe("chowbea-axios shim", () => {
	it("is named chowbea-axios and depends on chowbea", () => {
		expect(pkg.name).toBe("chowbea-axios");
		expect(pkg.dependencies.chowbea).toMatch(/^\^3/);
	});

	it("mirrors the three entry points, with CJS support on ./api", () => {
		expect(Object.keys(pkg.exports).sort()).toEqual([".", "./api", "./vite"]);
		expect(pkg.exports["./api"].require).toBeDefined();
	});

	it("re-exports rather than reimplements", () => {
		expect(read("index.js")).toContain('from "chowbea"');
		expect(read("vite.js")).toContain('from "chowbea/vite"');
		expect(read("api.js")).toContain('from "chowbea/api"');
		expect(read("api.cjs")).toContain('require("chowbea/api")');
	});

	it("forwards the chowbea-axios bin", () => {
		expect(pkg.bin["chowbea-axios"]).toBe("bin.js");
		expect(read("bin.js")).toContain("chowbea");
	});

	it("mirrors engines and peerDependencies so installs resolve identically", () => {
		expect(pkg.engines).toEqual(root.engines);
		expect(pkg.peerDependencies ?? {}).toEqual(root.peerDependencies ?? {});
	});
});
