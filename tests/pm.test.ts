import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { commandExists, detectPackageManager, resolveCommand } from "../src/core/pm.js";

async function withFixture<T>(
	files: string[],
	fn: (root: string) => Promise<T>,
): Promise<T> {
	const root = join(
		tmpdir(),
		`chowbea-pm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(root, { recursive: true });
	try {
		for (const f of files) {
			await writeFile(join(root, f), "", "utf8");
		}
		return await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("detectPackageManager (#24)", () => {
	it("detects pnpm via pnpm-lock.yaml", async () => {
		await withFixture(["pnpm-lock.yaml"], async (root) => {
			expect(await detectPackageManager(root)).toBe("pnpm");
		});
	});

	it("detects yarn via yarn.lock", async () => {
		await withFixture(["yarn.lock"], async (root) => {
			expect(await detectPackageManager(root)).toBe("yarn");
		});
	});

	it("detects bun via the modern text lockfile (bun.lock)", async () => {
		await withFixture(["bun.lock"], async (root) => {
			expect(await detectPackageManager(root)).toBe("bun");
		});
	});

	it("detects bun via the legacy binary lockfile (bun.lockb)", async () => {
		await withFixture(["bun.lockb"], async (root) => {
			expect(await detectPackageManager(root)).toBe("bun");
		});
	});

	it("detects npm via package-lock.json", async () => {
		await withFixture(["package-lock.json"], async (root) => {
			expect(await detectPackageManager(root)).toBe("npm");
		});
	});

	it("defaults to npm when no lockfile is present", async () => {
		await withFixture([], async (root) => {
			expect(await detectPackageManager(root)).toBe("npm");
		});
	});

	it("prefers pnpm over yarn over bun over npm when multiple lockfiles coexist", async () => {
		await withFixture(
			["pnpm-lock.yaml", "yarn.lock", "bun.lock", "package-lock.json"],
			async (root) => {
				expect(await detectPackageManager(root)).toBe("pnpm");
			},
		);
	});
});

describe("commandExists", () => {
	// Regression: on Windows Node >= 20.12, spawning a `.cmd` shim without a
	// shell fails with EINVAL, so probing `npm.cmd --version` reported every
	// package manager as missing. The where/which probe works on all platforms.
	it("finds a command that is on PATH and rejects one that is not", () => {
		expect(commandExists("node")).toBe(true);
		expect(commandExists("definitely-not-a-real-command-4471")).toBe(false);
	});
});

describe("resolveCommand", () => {
	it("on non-Windows platforms returns the input unchanged", () => {
		// We can't reliably stub process.platform in vitest without
		// affecting other tests; on macOS / Linux dev machines the
		// helper just passes through.
		if (process.platform !== "win32") {
			expect(resolveCommand("npm")).toBe("npm");
			expect(resolveCommand("pnpm")).toBe("pnpm");
			expect(resolveCommand("/usr/local/bin/bun")).toBe("/usr/local/bin/bun");
		}
	});
});
