import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
	decideDelegation,
	executionSource,
	findRunningPackageRoot,
	resolveLocalInstall,
} from "../src/core/local-resolution.js";

const GLOBAL_ROOT = "/usr/local/lib/node_modules/chowbea-axios";
const LOCAL_ROOT = "/work/proj/node_modules/chowbea-axios";
const LOCAL_BIN = "/work/proj/node_modules/chowbea-axios/bin/chowbea-axios.js";
const localInstall = { root: LOCAL_ROOT, binPath: LOCAL_BIN };

describe("decideDelegation", () => {
	it("delegates to the local bin when a local install differs from the running one", () => {
		expect(
			decideDelegation({
				runningRoot: GLOBAL_ROOT,
				localInstall,
				argv: ["node", "cli", "status"],
				env: {},
			}),
		).toEqual({ action: "delegate", binPath: LOCAL_BIN });
	});

	it("runs as-is when there is no local install", () => {
		expect(
			decideDelegation({
				runningRoot: GLOBAL_ROOT,
				localInstall: null,
				argv: ["node", "cli"],
				env: {},
			}),
		).toEqual({ action: "run" });
	});

	it("runs as-is when the running install already IS the local one", () => {
		expect(
			decideDelegation({
				runningRoot: LOCAL_ROOT,
				localInstall,
				argv: ["node", "cli"],
				env: {},
			}),
		).toEqual({ action: "run" });
	});

	it("does not delegate when the loop-guard sentinel is set", () => {
		expect(
			decideDelegation({
				runningRoot: GLOBAL_ROOT,
				localInstall,
				argv: ["node", "cli"],
				env: { CHOWBEA_LOCAL_DELEGATED: "1" },
			}),
		).toEqual({ action: "run" });
	});

	it("does not delegate when CHOWBEA_NO_DELEGATE=1", () => {
		expect(
			decideDelegation({
				runningRoot: GLOBAL_ROOT,
				localInstall,
				argv: ["node", "cli"],
				env: { CHOWBEA_NO_DELEGATE: "1" },
			}),
		).toEqual({ action: "run" });
	});

	it("does not delegate when --global is passed", () => {
		expect(
			decideDelegation({
				runningRoot: GLOBAL_ROOT,
				localInstall,
				argv: ["node", "cli", "--global", "status"],
				env: {},
			}),
		).toEqual({ action: "run" });
	});
});

describe("executionSource", () => {
	it("is 'project' when the running root is the local install", () => {
		expect(executionSource({ runningRoot: LOCAL_ROOT, localRoot: LOCAL_ROOT })).toBe(
			"project",
		);
	});

	it("is 'global' when a local exists but differs from the running root", () => {
		expect(
			executionSource({ runningRoot: GLOBAL_ROOT, localRoot: LOCAL_ROOT }),
		).toBe("global");
	});

	it("is 'global' when there is no local install", () => {
		expect(executionSource({ runningRoot: GLOBAL_ROOT, localRoot: null })).toBe(
			"global",
		);
	});
});

describe("findRunningPackageRoot", () => {
	it("walks up from a nested file to the nearest package.json", () => {
		const root = mkdtempSync(join(tmpdir(), "chowbea-prr-"));
		try {
			writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
			const deep = join(root, "dist", "tui", "screens");
			mkdirSync(deep, { recursive: true });
			const file = join(deep, "home.js");
			writeFileSync(file, "");
			expect(findRunningPackageRoot(pathToFileURL(file).href)).toBe(
				realpathSync(root),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("resolveLocalInstall", () => {
	it("finds the project-local install and resolves its bin entry", () => {
		const cwd = mkdtempSync(join(tmpdir(), "chowbea-rli-"));
		try {
			const pkgRoot = join(cwd, "node_modules", "chowbea-axios");
			mkdirSync(join(pkgRoot, "bin"), { recursive: true });
			writeFileSync(
				join(pkgRoot, "package.json"),
				JSON.stringify({
					name: "chowbea-axios",
					version: "9.9.9",
					bin: { "chowbea-axios": "bin/chowbea-axios.js" },
				}),
			);
			writeFileSync(join(pkgRoot, "bin", "chowbea-axios.js"), "");

			const result = resolveLocalInstall(cwd);
			expect(result).not.toBeNull();
			expect(result?.root).toBe(realpathSync(pkgRoot));
			expect(result?.binPath).toBe(
				join(realpathSync(pkgRoot), "bin", "chowbea-axios.js"),
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("returns null when there is no project-local install", () => {
		const cwd = mkdtempSync(join(tmpdir(), "chowbea-rli-none-"));
		try {
			expect(resolveLocalInstall(cwd)).toBeNull();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("walks up parent directories to find a hoisted install", () => {
		const root = mkdtempSync(join(tmpdir(), "chowbea-rli-nested-"));
		try {
			const pkgRoot = join(root, "node_modules", "chowbea-axios");
			mkdirSync(join(pkgRoot, "bin"), { recursive: true });
			writeFileSync(
				join(pkgRoot, "package.json"),
				JSON.stringify({
					name: "chowbea-axios",
					version: "9.9.9",
					bin: { "chowbea-axios": "bin/chowbea-axios.js" },
				}),
			);
			writeFileSync(join(pkgRoot, "bin", "chowbea-axios.js"), "");
			const nested = join(root, "packages", "app", "src");
			mkdirSync(nested, { recursive: true });

			expect(resolveLocalInstall(nested)?.root).toBe(realpathSync(pkgRoot));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves a string-form bin field", () => {
		const cwd = mkdtempSync(join(tmpdir(), "chowbea-rli-str-"));
		try {
			const pkgRoot = join(cwd, "node_modules", "chowbea-axios");
			mkdirSync(join(pkgRoot, "bin"), { recursive: true });
			writeFileSync(
				join(pkgRoot, "package.json"),
				JSON.stringify({
					name: "chowbea-axios",
					version: "9.9.9",
					bin: "bin/chowbea-axios.js",
				}),
			);
			writeFileSync(join(pkgRoot, "bin", "chowbea-axios.js"), "");

			expect(resolveLocalInstall(cwd)?.binPath).toBe(
				join(realpathSync(pkgRoot), "bin", "chowbea-axios.js"),
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("resolveLocalInstall: dual-name (rebrand)", () => {
	it("finds a project-local `chowbea` install", () => {
		const cwd = mkdtempSync(join(tmpdir(), "chowbea-rli-new-"));
		try {
			const pkgRoot = join(cwd, "node_modules", "chowbea");
			mkdirSync(join(pkgRoot, "bin"), { recursive: true });
			writeFileSync(
				join(pkgRoot, "package.json"),
				JSON.stringify({
					name: "chowbea",
					version: "9.9.9",
					bin: { chowbea: "bin/cli.js" },
				}),
			);
			writeFileSync(join(pkgRoot, "bin", "cli.js"), "");

			const result = resolveLocalInstall(cwd);
			expect(result).not.toBeNull();
			expect(result?.root.endsWith(join("node_modules", "chowbea"))).toBe(true);
			expect(result?.binPath.endsWith(join("bin", "cli.js"))).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("still finds a legacy `chowbea-axios` install", () => {
		const cwd = mkdtempSync(join(tmpdir(), "chowbea-rli-legacy-"));
		try {
			const pkgRoot = join(cwd, "node_modules", "chowbea-axios");
			mkdirSync(join(pkgRoot, "bin"), { recursive: true });
			writeFileSync(
				join(pkgRoot, "package.json"),
				JSON.stringify({
					name: "chowbea-axios",
					version: "9.9.9",
					bin: { "chowbea-axios": "bin/cli.js" },
				}),
			);
			writeFileSync(join(pkgRoot, "bin", "cli.js"), "");

			const result = resolveLocalInstall(cwd);
			expect(result).not.toBeNull();
			expect(result?.root).toBe(realpathSync(pkgRoot));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("prefers `chowbea` when both are present (shim installs both)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "chowbea-rli-both-"));
		try {
			const newRoot = join(cwd, "node_modules", "chowbea");
			mkdirSync(join(newRoot, "bin"), { recursive: true });
			writeFileSync(
				join(newRoot, "package.json"),
				JSON.stringify({
					name: "chowbea",
					version: "9.9.9",
					bin: { chowbea: "bin/cli.js" },
				}),
			);
			writeFileSync(join(newRoot, "bin", "cli.js"), "");

			const legacyRoot = join(cwd, "node_modules", "chowbea-axios");
			mkdirSync(join(legacyRoot, "bin"), { recursive: true });
			writeFileSync(
				join(legacyRoot, "package.json"),
				JSON.stringify({
					name: "chowbea-axios",
					version: "9.9.9",
					bin: { "chowbea-axios": "bin/cli.js" },
				}),
			);
			writeFileSync(join(legacyRoot, "bin", "cli.js"), "");

			const result = resolveLocalInstall(cwd);
			expect(result?.root).toBe(realpathSync(newRoot));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("accepts a `chowbea` bin key inside a legacy-named package and vice versa", () => {
		const cwd = mkdtempSync(join(tmpdir(), "chowbea-rli-crossbin-"));
		try {
			const pkgRoot = join(cwd, "node_modules", "chowbea-axios");
			mkdirSync(join(pkgRoot, "bin"), { recursive: true });
			writeFileSync(
				join(pkgRoot, "package.json"),
				JSON.stringify({
					name: "chowbea-axios",
					version: "9.9.9",
					bin: { chowbea: "bin/cli.js" },
				}),
			);
			writeFileSync(join(pkgRoot, "bin", "cli.js"), "");

			const result = resolveLocalInstall(cwd);
			expect(result).not.toBeNull();
			expect(result?.root).toBe(realpathSync(pkgRoot));
			expect(result?.binPath).toBe(join(realpathSync(pkgRoot), "bin", "cli.js"));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("falls through to the sibling name when the first package has no bin", () => {
		const cwd = mkdtempSync(join(tmpdir(), "chowbea-rli-fallthrough-"));
		try {
			const newRoot = join(cwd, "node_modules", "chowbea");
			mkdirSync(newRoot, { recursive: true });
			writeFileSync(
				join(newRoot, "package.json"),
				JSON.stringify({ name: "chowbea", version: "9.9.9" }),
			);

			const legacyRoot = join(cwd, "node_modules", "chowbea-axios");
			mkdirSync(join(legacyRoot, "bin"), { recursive: true });
			writeFileSync(
				join(legacyRoot, "package.json"),
				JSON.stringify({
					name: "chowbea-axios",
					version: "9.9.9",
					bin: { "chowbea-axios": "bin/cli.js" },
				}),
			);
			writeFileSync(join(legacyRoot, "bin", "cli.js"), "");

			const result = resolveLocalInstall(cwd);
			expect(result).not.toBeNull();
			expect(result?.root).toBe(realpathSync(legacyRoot));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps walking up when neither name is present in a directory", () => {
		const root = mkdtempSync(join(tmpdir(), "chowbea-rli-walk-"));
		try {
			const pkgRoot = join(root, "node_modules", "chowbea");
			mkdirSync(join(pkgRoot, "bin"), { recursive: true });
			writeFileSync(
				join(pkgRoot, "package.json"),
				JSON.stringify({
					name: "chowbea",
					version: "9.9.9",
					bin: { chowbea: "bin/cli.js" },
				}),
			);
			writeFileSync(join(pkgRoot, "bin", "cli.js"), "");

			const nested = join(root, "packages", "app", "src");
			mkdirSync(nested, { recursive: true });
			mkdirSync(join(root, "packages", "app", "node_modules"), {
				recursive: true,
			});

			const result = resolveLocalInstall(nested);
			expect(result?.root).toBe(realpathSync(pkgRoot));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns null when no install exists anywhere up the tree", () => {
		const cwd = mkdtempSync(join(tmpdir(), "chowbea-rli-none-new-"));
		try {
			expect(resolveLocalInstall(cwd)).toBeNull();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
