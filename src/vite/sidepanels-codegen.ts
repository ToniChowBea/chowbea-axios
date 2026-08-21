/**
 * Vite plugin: sidepanels-codegen
 *
 * Thin wrapper around `createCodegenPlugin` (issue #42). The shared
 * factory in `./shared.ts` handles file discovery, scaffolding empty
 * files, and emitting the typed barrel — this file only declares what
 * makes a "side panel" different from a "surface": file pattern,
 * scaffold content, and barrel export name.
 *
 * Usage in vite.config.ts:
 *   import { sidepanelsCodegen } from 'chowbea/vite'
 *   export default defineConfig({ plugins: [sidepanelsCodegen()] })
 */

import type { Plugin } from "vite";

import {
	createCodegenPlugin,
	listMatchingFiles,
	toPascalCase,
	toTitleCase,
} from "./shared.js";

export interface SidepanelsCodegenOptions {
	/** Directory containing side panel components (relative to project root). */
	directory?: string;
}

const PANEL_FILE_PATTERN = /\.panel\.tsx$/;
export const DEFINE_PANEL_REGEX =
	/export\s+const\s+(\w+)\s*=\s*definePanel\s*\(/;

/** Build scaffold content for an empty *.panel.tsx file */
export function buildPanelScaffold(panelName: string, relPath: string): string {
	const pascal = toPascalCase(panelName);
	const title = toTitleCase(panelName);
	const depth = relPath.split("/").length - 1;
	const prefix = depth > 0 ? "../".repeat(depth) : "./";

	return `import { z } from 'zod'
import { definePanel, usePanelParams, SidePanelBody, SidePanelNavBar } from '${prefix}_registry'

function ${pascal}Panel() {
  const { myParam } = usePanelParams(${pascal})
  return (
    <>
      <SidePanelNavBar>
        <span className="font-medium text-sm">${title}</span>
      </SidePanelNavBar>
      <SidePanelBody>
        <div>{/* content */}</div>
      </SidePanelBody>
    </>
  )
}

export const ${pascal} = definePanel('${panelName}', {
  component: ${pascal}Panel,
  contextParams: z.object({ myParam: z.string() }),
})
`;
}

/** Recursively get all *.panel.tsx files in the side-panels directory.
 *  Re-exported for actions/plugins.ts which scans panels independently. */
export function getPanelFiles(sidePanelsDir: string): string[] {
	return listMatchingFiles(sidePanelsDir, PANEL_FILE_PATTERN);
}

export function sidepanelsCodegen(
	options?: SidepanelsCodegenOptions,
): Plugin {
	return createCodegenPlugin(
		{
			pluginName: "sidepanels-codegen",
			defaultDirectory: "src/components/side-panels",
			filePattern: PANEL_FILE_PATTERN,
			defineRegex: DEFINE_PANEL_REGEX,
			genFilename: "panel-definitions.gen.ts",
			barrelExportName: "Panel",
			logTag: "\x1b[36m[sidepanels-codegen]\x1b[0m",
			buildScaffold: buildPanelScaffold,
		},
		options,
	);
}
