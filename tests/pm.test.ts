import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { commandExists, detectPackageManager, resolveCommand, safeSpawnSync } from "../src/core/pm.js";

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

describe("safeSpawnSync", () => {
	it("successfully spawns a simple command (node --version)", () => {
		// This tests that safeSpawnSync can run a basic command successfully.
		// On Windows it uses cross-spawn which handles .cmd shims; on Unix it's a pass-through.
		const result = safeSpawnSync("node", ["--version"]);
		expect(result.status).toBe(0);
		// cross-spawn returns null for error (not undefined) when there's no error.
		expect(result.error).toBeNull();
	});

	it("handles non-existent commands gracefully", () => {
		// Spawning a non-existent command should return a non-zero status or error.
		const result = safeSpawnSync("definitely-not-a-real-command-9923", []);
		// The spawn will fail with an error (ENOENT).
		const failed = result.status !== 0 || result.error !== null;
		expect(failed).toBe(true);
	});

	it("correctly passes arguments to the spawned command", () => {
		// Test that args are correctly forwarded by checking node's eval output.
		const result = safeSpawnSync("node", ["--eval", "console.log('test-output')"], {
			stdio: "pipe",
		});
		expect(result.status).toBe(0);
		expect(result.stdout?.toString().trim()).toBe("test-output");
	});

	// Shell injection protection tests (Issue #144 regression prevention).
	// These tests verify that dangerous characters in arguments are passed literally
	// to the child, not interpreted by cmd.exe (on Windows) or the shell (on Unix).
	// cross-spawn correctly escapes args for cmd.exe when spawning .cmd/.bat files.

	it("passes arguments containing spaces literally", () => {
		const result = safeSpawnSync("node", ["--eval", "console.log(process.argv[process.argv.length - 1])", "hello world"], {
			stdio: "pipe",
		});
		expect(result.status).toBe(0);
		expect(result.stdout?.toString().trim()).toBe("hello world");
	});

	it("passes arguments containing ampersand (&) literally", () => {
		// On Windows, & is a cmd.exe command separator. Must be escaped.
		const result = safeSpawnSync("node", ["--eval", "console.log(process.argv[process.argv.length - 1])", "foo&bar"], {
			stdio: "pipe",
		});
		expect(result.status).toBe(0);
		expect(result.stdout?.toString().trim()).toBe("foo&bar");
	});

	it("passes arguments containing pipe (|) literally", () => {
		// On Windows, | is a cmd.exe pipe operator. Must be escaped.
		const result = safeSpawnSync("node", ["--eval", "console.log(process.argv[process.argv.length - 1])", "foo|bar"], {
			stdio: "pipe",
		});
		expect(result.status).toBe(0);
		expect(result.stdout?.toString().trim()).toBe("foo|bar");
	});

	it("passes arguments containing double quotes literally", () => {
		// Double quotes are tricky on Windows cmd.exe. Must be escaped correctly.
		const result = safeSpawnSync("node", ["--eval", "console.log(process.argv[process.argv.length - 1])", 'foo"bar'], {
			stdio: "pipe",
		});
		expect(result.status).toBe(0);
		expect(result.stdout?.toString().trim()).toBe('foo"bar');
	});

	it("passes arguments containing caret (^) literally", () => {
		// On Windows, ^ is the cmd.exe escape character. Must itself be escaped.
		const result = safeSpawnSync("node", ["--eval", "console.log(process.argv[process.argv.length - 1])", "foo^bar"], {
			stdio: "pipe",
		});
		expect(result.status).toBe(0);
		expect(result.stdout?.toString().trim()).toBe("foo^bar");
	});

	it("passes arguments containing percent-delimited env vars literally (not expanded)", () => {
		// On Windows, %VAR% expands environment variables in cmd.exe. Must not expand.
		const result = safeSpawnSync("node", ["--eval", "console.log(process.argv[process.argv.length - 1])", "%PATH%"], {
			stdio: "pipe",
		});
		expect(result.status).toBe(0);
		// Should receive the literal string "%PATH%", not the expanded PATH value.
		expect(result.stdout?.toString().trim()).toBe("%PATH%");
	});

	it("passes arguments containing greater-than (>) literally", () => {
		// On Windows, > is a cmd.exe redirection operator. Must be escaped.
		const result = safeSpawnSync("node", ["--eval", "console.log(process.argv[process.argv.length - 1])", "foo>bar"], {
			stdio: "pipe",
		});
		expect(result.status).toBe(0);
		expect(result.stdout?.toString().trim()).toBe("foo>bar");
	});

	it("passes arguments containing less-than (<) literally", () => {
		// On Windows, < is a cmd.exe redirection operator. Must be escaped.
		const result = safeSpawnSync("node", ["--eval", "console.log(process.argv[process.argv.length - 1])", "foo<bar"], {
			stdio: "pipe",
		});
		expect(result.status).toBe(0);
		expect(result.stdout?.toString().trim()).toBe("foo<bar");
	});

	it("passes complex arguments with multiple dangerous characters literally", () => {
		// Test a realistic worst-case argument with multiple shell metacharacters.
		const dangerousArg = 'foo&bar|baz>qux<quux"test"^caret%PATH%';
		const result = safeSpawnSync("node", ["--eval", "console.log(process.argv[process.argv.length - 1])", dangerousArg], {
			stdio: "pipe",
		});
		expect(result.status).toBe(0);
		expect(result.stdout?.toString().trim()).toBe(dangerousArg);
	});
});
