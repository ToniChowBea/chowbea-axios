import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A throwaway TS project on disk for extractor tests. `files` are relative
 * to the project root; a minimal tsconfig with rootDir=src is written unless
 * the caller provides their own "tsconfig.json".
 */
export function makeBusFixture(files: Record<string, string>): {
	dir: string;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "chowbea-bus-fixture-"));
	if (!files["tsconfig.json"]) {
		files = {
			...files,
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					rootDir: "src",
					noEmit: true,
					skipLibCheck: true,
					module: "nodenext",
					moduleResolution: "nodenext",
				},
				include: ["src/**/*.ts"],
			}),
		};
	}
	for (const [rel, content] of Object.entries(files)) {
		const full = join(dir, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf8");
	}
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
