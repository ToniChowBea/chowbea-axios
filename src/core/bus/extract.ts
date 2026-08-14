import path from "node:path";
import ts from "typescript";

import { hashText, type BusTypeEntry, type BusTypeKind } from "./manifest.js";

export interface ExtractError {
	message: string;
	file: string;
	line: number;
}

export interface ExtractOutput {
	barrels: Record<string, BusTypeEntry[]>;
	errors: ExtractError[];
}

const MARKER_TAG = "chowbea-export";
const BARREL_SUFFIX = ".chowbea.ts";
const RESERVED_PREFIX = "_marked";

type Collected = {
	entry: BusTypeEntry;
	/** Original AST declaration — Task 3 validation walks these. */
	node: ts.Declaration;
	/** Where the type was REGISTERED (barrel file or marker site). */
	registeredAt: { file: string; line: number };
};

function toPosix(p: string): string {
	return p.split(path.sep).join("/");
}

function lineOf(node: ts.Node): number {
	const sf = node.getSourceFile();
	return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function kindOf(node: ts.Node): BusTypeKind | null {
	if (ts.isTypeAliasDeclaration(node)) return "type";
	if (ts.isInterfaceDeclaration(node)) return "interface";
	if (ts.isEnumDeclaration(node)) return "enum";
	return null;
}

function hasExportModifier(node: ts.Node): boolean {
	return (
		ts.canHaveModifiers(node) &&
		(ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
	);
}

/** Slice declaration text verbatim; prepend `export ` when the original lacks it. */
function sliceDeclaration(node: ts.Node): string {
	const text = node.getText(node.getSourceFile());
	return hasExportModifier(node) ? text : `export ${text}`;
}

function loadProgram(
	projectRoot: string,
	tsconfigPath?: string,
): {
	program: ts.Program;
	rootDir: string;
} {
	const configFile = tsconfigPath ?? ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json");
	if (!configFile) {
		throw new Error(`No tsconfig.json found from ${projectRoot} — pass --project`);
	}
	const parsed = ts.getParsedCommandLineOfConfigFile(configFile, undefined, {
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic: (d) => {
			throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
		},
	});
	if (!parsed) throw new Error(`Failed to parse ${configFile}`);
	const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
	const rootDir = parsed.options.rootDir
		? path.resolve(path.dirname(configFile), parsed.options.rootDir)
		: path.dirname(configFile);
	return { program, rootDir };
}

function barrelKey(fileName: string, rootDir: string): string {
	const rel = toPosix(path.relative(rootDir, fileName));
	return rel.slice(0, -BARREL_SUFFIX.length);
}

function markedKey(fileName: string, rootDir: string): string {
	const rel = toPosix(path.dirname(path.relative(rootDir, fileName)));
	return rel === "." ? RESERVED_PREFIX : `${RESERVED_PREFIX}/${rel}`;
}

function hasMarkerTag(node: ts.Node): boolean {
	return ts.getJSDocTags(node).some((t) => t.tagName.text === MARKER_TAG);
}

export function extractBusTypes(options: { projectRoot: string; tsconfigPath?: string }): ExtractOutput {
	const { program, rootDir } = loadProgram(options.projectRoot, options.tsconfigPath);
	const checker = program.getTypeChecker();
	const errors: ExtractError[] = [];
	const collected: Map<string, Collected[]> = new Map(); // barrel key -> entries

	const projectFiles = program
		.getSourceFiles()
		.filter((sf) => !sf.isDeclarationFile && !sf.fileName.includes("/node_modules/"));

	const add = (key: string, item: Collected) => {
		const list = collected.get(key) ?? [];
		list.push(item);
		collected.set(key, list);
	};

	const collectDeclaration = (
		decl: ts.Declaration,
		name: string,
		key: string,
		registeredAt: { file: string; line: number },
	) => {
		const kind = kindOf(decl);
		if (kind === null) {
			errors.push({
				message:
					`"${name}" is not a type alias, interface, or enum — only types ride the bus in v1 ` +
					`(classes, consts, and functions are runtime values).`,
				file: registeredAt.file,
				line: registeredAt.line,
			});
			return;
		}
		const sf = decl.getSourceFile();
		const declaration = sliceDeclaration(decl);
		add(key, {
			entry: {
				name,
				kind,
				declaration,
				source: toPosix(path.relative(options.projectRoot, sf.fileName)),
				line: lineOf(decl),
				hash: hashText(declaration),
			},
			node: decl,
			registeredAt,
		});
	};

	for (const sf of projectFiles) {
		const relFile = toPosix(path.relative(options.projectRoot, sf.fileName));

		// Channel 1: *.chowbea.ts barrels — every export is on the bus.
		if (sf.fileName.endsWith(BARREL_SUFFIX)) {
			const key = barrelKey(sf.fileName, rootDir);
			const moduleSymbol = checker.getSymbolAtLocation(sf);
			for (const exp of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
				const resolved = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
				const decl = resolved.declarations?.[0];
				const registeredAt = {
					file: relFile,
					line: exp.declarations?.[0] ? lineOf(exp.declarations[0]) : 1,
				};
				if (!decl) {
					errors.push({ message: `Cannot resolve export "${exp.name}"`, ...registeredAt });
					continue;
				}
				collectDeclaration(decl, exp.name, key, registeredAt);
			}
			continue;
		}

		// Channel 2: /** @chowbea-export */ markers anywhere.
		for (const stmt of sf.statements) {
			const isMarkable =
				ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isEnumDeclaration(stmt);
			if (isMarkable && hasMarkerTag(stmt)) {
				collectDeclaration(stmt, stmt.name.text, markedKey(sf.fileName, rootDir), {
					file: relFile,
					line: lineOf(stmt),
				});
			}
		}
	}

	const barrels: Record<string, BusTypeEntry[]> = {};
	for (const [key, items] of [...collected.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		barrels[key] = items.map((i) => i.entry).sort((a, b) => a.name.localeCompare(b.name));
	}
	return { barrels, errors };
}
