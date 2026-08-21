import path from "node:path";
import ts from "typescript";

import {
	buildManifest,
	hashText,
	isSafeBarrelKey,
	type BusManifest,
	type BusTypeEntry,
	type BusTypeKind,
} from "./manifest.js";

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

/** A `chowbea-name "..."` directive (the leading `@` is optional). */
const NAME_TAG_PATTERN = /@?chowbea-name\s+["\']([^"\'\r\n]+)["\']/;
/** Every comment in a file, in source order — block first, then line. */
const COMMENT_PATTERN = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g;

/**
 * Explicit output name for a file, declared as `chowbea-name "grades"` inside
 * any comment. It overrides the path-derived barrel key, so the frontend emits
 * `grades.ts` instead of `exams.grade.ts`.
 *
 * The first occurrence in the file wins — later ones are ignored rather than
 * erroring, so a file can never be ambiguously named.
 */
function explicitBarrelName(sf: ts.SourceFile): { name: string; line: number } | null {
	const text = sf.getFullText();
	for (const comment of text.matchAll(COMMENT_PATTERN)) {
		const tag = NAME_TAG_PATTERN.exec(comment[0]);
		if (!tag) continue;
		const at = (comment.index ?? 0) + (tag.index ?? 0);
		return { name: tag[1].trim(), line: sf.getLineAndCharacterOfPosition(at).line + 1 };
	}
	return null;
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

function typesOnlyError(name: string, file: string, line: number): ExtractError {
	return {
		message:
			`"${name}" is not a type alias, interface, or enum — only types ride the bus in v1 ` +
			`(classes, consts, and functions are runtime values).`,
		file,
		line,
	};
}

/**
 * `path.relative(rootDir, fileName)` produces `..` segments when a
 * `.chowbea.ts` barrel or `@chowbea-export`-marked file sits outside the
 * tsconfig `rootDir` but is still part of the program (e.g. via `include`) —
 * barrelKey/markedKey then derive an unsafe manifest key. Same rule as the
 * network trust boundary in manifest.ts's parseManifest.
 */
function outOfRootDirError(relFile: string, rootDir: string): ExtractError {
	return {
		message: `"${relFile}" is outside the tsconfig rootDir (${rootDir}) — move it under ${rootDir} or adjust rootDir.`,
		file: relFile,
		line: 1,
	};
}

/** Best-effort declared name for an error message; marked statements aren't always name-bearing. */
function markedStatementName(stmt: ts.Statement): string {
	if (ts.isClassDeclaration(stmt) || ts.isFunctionDeclaration(stmt)) {
		return stmt.name?.text ?? "<anonymous>";
	}
	if (ts.isVariableStatement(stmt)) {
		const first = stmt.declarationList.declarations[0]?.name;
		return first && ts.isIdentifier(first) ? first.text : "<anonymous>";
	}
	return "<anonymous>";
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
			errors.push(typesOnlyError(name, registeredAt.file, registeredAt.line));
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

	/** Explicit `chowbea-name` claims: output name -> the sites that claimed it. */
	const explicitClaims = new Map<string, { file: string; line: number }[]>();
	/** Every output key -> the files contributing to it (marker files legitimately share one). */
	const keyContributors = new Map<string, Set<string>>();

	const trackKey = (key: string, relFile: string) => {
		const files = keyContributors.get(key) ?? new Set<string>();
		files.add(relFile);
		keyContributors.set(key, files);
	};

	/**
	 * A file's output key: its `chowbea-name` directive when present and valid,
	 * otherwise the path-derived one. An invalid name is an error that falls back
	 * to the derived key, so the sweep still reports the file's other problems.
	 */
	const resolveKey = (sf: ts.SourceFile, relFile: string, derived: string): string => {
		const explicit = explicitBarrelName(sf);
		if (!explicit) return derived;
		const { name, line } = explicit;
		const reject = (why: string): string => {
			errors.push({ message: `chowbea-name "${name}" ${why}`, file: relFile, line });
			return derived;
		};
		if (!isSafeBarrelKey(name)) {
			return reject(
				"is not a valid output name — use a plain name like \"grades\" (no leading slash, no \"..\" segments, no backslashes).",
			);
		}
		if (name === "index") {
			return reject('is reserved — the frontend emits its own index.ts re-export barrel.');
		}
		if (name === RESERVED_PREFIX || name.startsWith(`${RESERVED_PREFIX}/`)) {
			return reject(`is reserved — the "${RESERVED_PREFIX}/" namespace groups @chowbea-export types.`);
		}
		explicitClaims.set(name, [...(explicitClaims.get(name) ?? []), { file: relFile, line }]);
		return name;
	};

	for (const sf of projectFiles) {
		const relFile = toPosix(path.relative(options.projectRoot, sf.fileName));

		// Channel 1: *.chowbea.ts barrels — every export is on the bus.
		if (sf.fileName.endsWith(BARREL_SUFFIX)) {
			const derived = barrelKey(sf.fileName, rootDir);
			if (!isSafeBarrelKey(derived)) {
				errors.push(outOfRootDirError(relFile, rootDir));
				continue;
			}
			const key = resolveKey(sf, relFile, derived);
			trackKey(key, relFile);
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

		// Channel 2: /** @chowbea-export */ markers anywhere. The tag alone puts a
		// statement on the bus — even non-type declarations, which then fail with
		// the same "types only" error a barrel export would get (spec §8).
		// markedKey depends only on the file, so it's resolved (and validated)
		// once per file, the first time a marked type declaration is seen.
		let markedFileKeyChecked = false;
		let markedFileKey: string | null = null;
		for (const stmt of sf.statements) {
			if (!hasMarkerTag(stmt)) continue;
			if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
				if (!markedFileKeyChecked) {
					markedFileKeyChecked = true;
					const derived = markedKey(sf.fileName, rootDir);
					markedFileKey = isSafeBarrelKey(derived) ? resolveKey(sf, relFile, derived) : null;
					if (markedFileKey === null) errors.push(outOfRootDirError(relFile, rootDir));
					else trackKey(markedFileKey, relFile);
				}
				if (markedFileKey === null) continue;
				collectDeclaration(stmt, stmt.name.text, markedFileKey, {
					file: relFile,
					line: lineOf(stmt),
				});
				continue;
			}
			errors.push(typesOnlyError(markedStatementName(stmt), relFile, lineOf(stmt)));
		}
	}

	// ~ Explicit output names own their file. Two files resolving to one name —
	// whether both claimed it or one collided with another file's derived key —
	// would silently merge into a single generated file, so both error.
	for (const [name, claims] of explicitClaims) {
		const claimants = [...new Set(claims.map((c) => c.file))];
		if (claimants.length > 1) {
			errors.push({
				message: `chowbea-name "${name}" is claimed by ${claimants.length} files — ${claimants.join(" and ")}. Output names must be unique.`,
				file: claims[0].file,
				line: claims[0].line,
			});
			continue;
		}
		const others = [...(keyContributors.get(name) ?? [])].filter((f) => f !== claimants[0]);
		if (others.length > 0) {
			errors.push({
				message: `chowbea-name "${name}" collides with types already destined for that file from ${others.join(", ")}. Rename one of them.`,
				file: claims[0].file,
				line: claims[0].line,
			});
		}
	}

	// ~ Reserved barrel key: "index" is reserved for the generated re-export index.
	for (const [key, items] of collected) {
		if (key === "index" && items.some((i) => i.registeredAt.file.endsWith(BARREL_SUFFIX))) {
			const first = items[0];
			errors.push({
				message:
					`Barrel key "index" is reserved for the generated re-export index — ` +
					`rename the barrel file.`,
				file: first.registeredAt.file,
				line: first.registeredAt.line,
			});
		}
	}

	// ~ Reserved prefix: a real barrel may not produce a _marked/* key. Exact
	// segment match, not a bare prefix — "_markedly/types" must not collide
	// with the reserved "_marked" / "_marked/*" namespace.
	for (const [key, items] of collected) {
		const isReserved = key === RESERVED_PREFIX || key.startsWith(`${RESERVED_PREFIX}/`);
		if (isReserved && items.some((i) => i.registeredAt.file.endsWith(BARREL_SUFFIX))) {
			const first = items[0];
			errors.push({
				message:
					`Barrel key "${key}" collides with the reserved _marked/ namespace — ` +
					`move the barrel out of a _marked/ directory (reserved for @chowbea-export grouping).`,
				file: first.registeredAt.file,
				line: first.registeredAt.line,
			});
		}
	}

	// ~ Duplicates: the same exported name registered via any two sites. The
	// same original declaration re-exported from two barrels is still a
	// duplicate — one bus name must have exactly one registration site.
	const byName = new Map<string, Collected[]>();
	for (const items of collected.values()) {
		for (const item of items) {
			const list = byName.get(item.entry.name) ?? [];
			list.push(item);
			byName.set(item.entry.name, list);
		}
	}
	for (const [name, sites] of byName) {
		if (sites.length > 1) {
			const where = sites.map((s) => `${s.registeredAt.file}:${s.registeredAt.line}`).join(" and ");
			errors.push({
				message: `"${name}" is registered twice on the bus — at ${where}. Remove one.`,
				file: sites[0].registeredAt.file,
				line: sites[0].registeredAt.line,
			});
		}
	}

	// ~ Closed world: every type reference inside a bus declaration must
	// resolve to another bus declaration, a type parameter, or the TS lib.
	// Dedup per (referencer, referenced) pair — a name repeated inside one
	// declaration (or across declarations) only errors once.
	const busDeclarations = new Set<ts.Declaration>([...collected.values()].flat().map((i) => i.node));
	const seenRefs = new Set<string>();
	for (const items of collected.values()) {
		for (const item of items) {
			/**
			 * Standard closed-world check: bus member OK, non-bus project type
			 * errors, node_modules errors. Shared by TypeReferenceNode /
			 * ExpressionWithTypeArguments (`Foo`, `extends Foo`) and
			 * ImportTypeNode's qualifier (`import("./x.js").Foo`) — both resolve
			 * the same way via the checker.
			 */
			const checkTypeRef = (nameNode: ts.Node): void => {
				const symbol = checker.getSymbolAtLocation(nameNode);
				const resolved =
					symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
				const target = resolved?.declarations?.[0];
				if (!resolved || !target || resolved.flags & ts.SymbolFlags.TypeParameter) return;
				const targetFile = target.getSourceFile();
				const isLib = program.isSourceFileDefaultLibrary(targetFile);
				const isNodeModules = targetFile.fileName.includes("/node_modules/");
				if (isLib || (!isNodeModules && busDeclarations.has(target))) return;
				// Key on the resolved target's identity, not just its name —
				// two different non-bus types that happen to share a simple
				// name (e.g. via a renamed import) are distinct violations.
				const dedupKey = `${item.entry.name}->${resolved.name}@${targetFile.fileName}:${lineOf(target)}`;
				if (seenRefs.has(dedupKey)) return;
				seenRefs.add(dedupKey);
				errors.push(
					isNodeModules
						? {
								message:
									`"${item.entry.name}" references "${resolved.name}" from node_modules — ` +
									`external types cannot ride the bus in v1.`,
								file: item.entry.source,
								line: item.entry.line,
							}
						: {
								message:
									`"${item.entry.name}" references "${resolved.name}" ` +
									`(${toPosix(path.relative(options.projectRoot, targetFile.fileName))}:${lineOf(target)}) ` +
									`which is not on the bus — add it to a .chowbea.ts barrel or mark it @chowbea-export.`,
								file: item.entry.source,
								line: item.entry.line,
							},
				);
			};

			/**
			 * `typeof X` always errors in v1 — values can never ride the bus,
			 * regardless of whether X itself resolves to a bus type.
			 */
			const checkTypeQuery = (node: ts.TypeQueryNode): void => {
				const symbol = checker.getSymbolAtLocation(node.exprName);
				const resolved =
					symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
				const target = resolved?.declarations?.[0];
				const referencedName = resolved?.name ?? node.exprName.getText();
				const location = target
					? ` (${toPosix(path.relative(options.projectRoot, target.getSourceFile().fileName))}:${lineOf(target)})`
					: "";
				const dedupKey = `${item.entry.name}->typeof:${referencedName}${location}`;
				if (seenRefs.has(dedupKey)) return;
				seenRefs.add(dedupKey);
				errors.push({
					message:
						`"${item.entry.name}" references "typeof ${referencedName}"${location} — ` +
						`values can never ride the bus in v1, only type aliases, interfaces, and enums do.`,
					file: item.entry.source,
					line: item.entry.line,
				});
			};

			const visit = (node: ts.Node): void => {
				if (ts.isTypeQueryNode(node)) {
					checkTypeQuery(node);
				} else if (ts.isImportTypeNode(node) && node.qualifier) {
					checkTypeRef(node.qualifier);
				} else if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
					checkTypeRef(ts.isTypeReferenceNode(node) ? node.typeName : node.expression);
				}
				ts.forEachChild(node, visit);
			};
			visit(item.node);
		}
	}

	const barrels: Record<string, BusTypeEntry[]> = {};
	for (const [key, items] of [...collected.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		barrels[key] = items.map((i) => i.entry).sort((a, b) => a.name.localeCompare(b.name));
	}
	return { barrels, errors };
}

export function extractBusManifest(options: {
	projectRoot: string;
	tsconfigPath?: string;
	now?: Date;
}): { manifest: BusManifest | null; errors: ExtractError[] } {
	const { barrels, errors } = extractBusTypes(options);
	if (errors.length > 0) return { manifest: null, errors };
	return { manifest: buildManifest(barrels, options.now ?? new Date()), errors };
}
