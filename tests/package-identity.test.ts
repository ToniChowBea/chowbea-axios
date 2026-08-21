import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
	name: string;
	bin: Record<string, string>;
	repository: { url: string };
	bugs: { url: string };
	exports: Record<string, unknown>;
};

describe("package identity (rebrand)", () => {
	it("publishes as chowbea", () => {
		expect(pkg.name).toBe("chowbea");
	});

	it("ships both bin names, pointing at the same entry", () => {
		expect(pkg.bin.chowbea).toBeDefined();
		expect(pkg.bin["chowbea-axios"]).toBeDefined();
		expect(pkg.bin.chowbea).toBe(pkg.bin["chowbea-axios"]);
	});

	it("points repository and bugs at the renamed repo", () => {
		expect(pkg.repository.url).toContain("ToniChowBea/chowbea");
		expect(pkg.repository.url).not.toContain("chowbea-axios");
		expect(pkg.bugs.url).toContain("ToniChowBea/chowbea");
	});

	it("keeps the public entry points, plus package.json for bin resolution", () => {
		expect(Object.keys(pkg.exports).sort()).toEqual([
			".",
			"./api",
			"./package.json",
			"./vite",
		]);
		expect(pkg.exports["./package.json"]).toBe("./package.json");
	});
});

describe("user-facing docs use the new name", () => {
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

	it("installs and invokes chowbea", () => {
		expect(readme).toMatch(/npm install chowbea\b/);
		expect(readme).toMatch(/npx chowbea init/);
	});

	it("keeps a migration note for the old name", () => {
		expect(readme.toLowerCase()).toContain("renamed from");
		expect(readme).toContain("chowbea-axios");
	});

	it("imports the Type Bus api surface from chowbea/api", () => {
		expect(readme).toContain('from "chowbea/api"');
		expect(readme).not.toContain('from "chowbea-axios/api"');
	});
});
