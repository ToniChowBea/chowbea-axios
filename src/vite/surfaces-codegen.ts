/**
 * Vite plugin: surfaces-codegen
 *
 * Thin wrapper around `createCodegenPlugin` (issue #42). The shared
 * factory in `./shared.ts` handles file discovery, scaffolding empty
 * files, and emitting the typed barrel — this file only declares what
 * makes a "surface" different from a "side panel": file pattern,
 * scaffold content, and barrel export name.
 *
 * Usage in vite.config.ts:
 *   import { surfacesCodegen } from 'chowbea/vite'
 *   export default defineConfig({ plugins: [surfacesCodegen()] })
 */

import type { Plugin } from "vite";

import {
	createCodegenPlugin,
	listMatchingFiles,
	toPascalCase,
	toTitleCase,
} from "./shared.js";

export interface SurfacesCodegenOptions {
	/** Directory containing surface components (relative to project root). */
	directory?: string;
}

const SURFACE_FILE_PATTERN = /\.surface\.tsx$/;
export const DEFINE_SURFACE_REGEX =
	/export\s+const\s+(\w+)\s*=\s*defineSurface\s*\(/;

/** Build scaffold content for an empty *.surface.tsx file */
export function buildSurfaceScaffold(surfaceName: string, relPath: string): string {
	const pascal = toPascalCase(surfaceName);
	const title = toTitleCase(surfaceName);
	const depth = relPath.split("/").length - 1;
	const prefix = depth > 0 ? "../".repeat(depth) : "./";

	return `import {
  defineSurface,
  SurfaceContainer,
  SurfaceContent,
  SurfaceHeader,
  SurfaceTitle,
} from '${prefix}_registry'

export const ${pascal} = defineSurface('${surfaceName}', {})

export function ${pascal}Surface() {
  return (
    <SurfaceContainer surface={${pascal}}>
      <SurfaceContent>
        <SurfaceHeader>
          <SurfaceTitle>${title}</SurfaceTitle>
        </SurfaceHeader>
        {/* content */}
      </SurfaceContent>
    </SurfaceContainer>
  )
}
`;
}

/** Recursively get all *.surface.tsx files in the surfaces directory.
 *  Re-exported for actions/plugins.ts which scans surfaces independently. */
export function getSurfaceFiles(surfacesDir: string): string[] {
	return listMatchingFiles(surfacesDir, SURFACE_FILE_PATTERN);
}

export function surfacesCodegen(options?: SurfacesCodegenOptions): Plugin {
	return createCodegenPlugin(
		{
			pluginName: "surfaces-codegen",
			defaultDirectory: "src/components/surfaces",
			filePattern: SURFACE_FILE_PATTERN,
			defineRegex: DEFINE_SURFACE_REGEX,
			genFilename: "surface-definitions.gen.ts",
			barrelExportName: "Surface",
			logTag: "\x1b[36m[surfaces-codegen]\x1b[0m",
			buildScaffold: buildSurfaceScaffold,
		},
		options,
	);
}
