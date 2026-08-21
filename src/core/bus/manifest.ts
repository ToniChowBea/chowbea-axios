import { createHash } from "node:crypto";
import ts from "typescript";

/** Manifest format version. Bump only with a migration story (spec §3). */
export const BUS_VERSION = "1";

export type BusTypeKind = "type" | "interface" | "enum";

export interface BusTypeEntry {
	name: string;
	kind: BusTypeKind;
	declaration: string;
	/** Repo-relative source path, posix separators. */
	source: string;
	/** 1-based line of the declaration in `source`. */
	line: number;
	/** hashText(declaration) — drives incremental emission. */
	hash: string;
}

export interface BusManifest {
	chowbeaBus: string;
	generatedAt: string;
	hash: string;
	barrels: Record<string, BusTypeEntry[]>;
}

export class BusVersionError extends Error {
	constructor(found: string) {
		super(
			`Unsupported chowbea bus manifest version "${found}" (this CLI supports "${BUS_VERSION}"). ` +
				`Upgrade chowbea.`,
		);
		this.name = "BusVersionError";
	}
}

export function hashText(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stable across key order: hash a sorted, canonical projection of the barrels. */
export function hashBarrels(barrels: BusManifest["barrels"]): string {
	const canonical = Object.keys(barrels)
		.sort()
		.map((key) => [key, barrels[key].map((e) => [e.name, e.kind, e.declaration, e.source, e.line])]);
	return hashText(JSON.stringify(canonical));
}

export function buildManifest(barrels: BusManifest["barrels"], now: Date): BusManifest {
	return {
		chowbeaBus: BUS_VERSION,
		generatedAt: now.toISOString(),
		hash: hashBarrels(barrels),
		barrels,
	};
}

const VALID_KINDS = new Set<BusTypeKind>(["type", "interface", "enum"]);

/**
 * Rejects barrel keys that could escape `busDir` when joined into a path
 * (`path.join(busDir, name)` in emit.ts — a `\` or `..` segment traverses
 * out of it, notably on Windows where `\` is a separator) or that are
 * otherwise unusable as a relative path segment.
 */
export function isSafeBarrelKey(key: string): boolean {
	if (key.length === 0 || key.includes("\\")) return false;
	const segments = key.split("/");
	return segments.every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** SourceFile.parseDiagnostics is populated by createSourceFile's parse but not part of the public d.ts. */
interface ParsedSourceFile extends ts.SourceFile {
	parseDiagnostics: ts.DiagnosticWithLocation[];
}

const KIND_TO_SYNTAX_KIND: Record<BusTypeKind, ts.SyntaxKind> = {
	type: ts.SyntaxKind.TypeAliasDeclaration,
	interface: ts.SyntaxKind.InterfaceDeclaration,
	enum: ts.SyntaxKind.EnumDeclaration,
};

/** An enum member initializer that's safe to emit verbatim: absent, or a string/numeric (incl. `-1`) literal. */
function isSafeEnumInitializer(initializer: ts.Expression | undefined): boolean {
	if (initializer === undefined) return true;
	if (ts.isStringLiteral(initializer) || ts.isNumericLiteral(initializer)) return true;
	return (
		ts.isPrefixUnaryExpression(initializer) &&
		initializer.operator === ts.SyntaxKind.MinusToken &&
		ts.isNumericLiteral(initializer.operand)
	);
}

/**
 * A network manifest's `declaration` string is written verbatim into a
 * generated .ts file the consumer app imports — an executable-code
 * injection surface if a hostile/compromised bus endpoint could smuggle
 * arbitrary statements past a naive "it's a string" check. Parse it with the
 * TypeScript API (no program needed — this is a syntax-only check) and
 * enforce it is EXACTLY the one declaration the entry claims to be.
 */
function assertValidDeclaration(name: string, kind: BusTypeKind, declaration: string, label: string): void {
	const fail = (reason: string): never => {
		throw new Error(`Malformed chowbea bus manifest: ${label} ("${name}") ${reason}`);
	};
	const sourceFile = ts.createSourceFile(
		"chowbea-bus-entry.ts",
		declaration,
		ts.ScriptTarget.Latest,
		true,
	) as ParsedSourceFile;
	if (sourceFile.parseDiagnostics.length > 0) {
		fail("failed to parse as TypeScript");
	}
	if (sourceFile.statements.length !== 1) {
		fail(`declaration must be exactly one statement, found ${sourceFile.statements.length}`);
	}
	const stmt = sourceFile.statements[0];
	if (stmt.kind !== KIND_TO_SYNTAX_KIND[kind]) {
		fail(`declaration does not match its declared kind "${kind}"`);
	}
	const declNode = stmt as ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.EnumDeclaration;
	if (declNode.name.text !== name) {
		fail(`declares name "${declNode.name.text}" but the entry is named "${name}"`);
	}
	if (ts.isEnumDeclaration(declNode)) {
		for (const member of declNode.members) {
			// A computed name (`[expr] = 1`) is an arbitrary runtime expression —
			// not caught by parseDiagnostics (computed enum names are a binder/
			// grammar error, not a parse error, and no bind runs here) — that
			// would execute at import time under transpile-only pipelines
			// (Vite/esbuild, swc, babel), which don't run tsc's full checker.
			if (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) {
				fail("enum member names must be a plain identifier or string literal");
			}
			if (!isSafeEnumInitializer(member.initializer)) {
				fail("enum member initializers must be a string or numeric literal");
			}
		}
	}
}

/** A network-fetched manifest is untrusted input — validate every entry field before it's trusted. */
function assertValidEntry(entry: unknown, key: string, index: number): asserts entry is BusTypeEntry {
	const label = `barrels["${key}"][${index}]`;
	if (typeof entry !== "object" || entry === null) {
		throw new Error(`Malformed chowbea bus manifest: ${label} is not an object`);
	}
	const e = entry as Record<string, unknown>;
	for (const field of ["name", "declaration", "source", "hash"] as const) {
		if (typeof e[field] !== "string") {
			throw new Error(`Malformed chowbea bus manifest: ${label}.${field} must be a string`);
		}
	}
	if (typeof e.kind !== "string" || !VALID_KINDS.has(e.kind as BusTypeKind)) {
		throw new Error(`Malformed chowbea bus manifest: ${label}.kind must be one of "type" | "interface" | "enum"`);
	}
	if (typeof e.line !== "number") {
		throw new Error(`Malformed chowbea bus manifest: ${label}.line must be a number`);
	}
	const name = e.name as string;
	const kind = e.kind as BusTypeKind;
	const declaration = e.declaration as string;
	assertValidDeclaration(name, kind, declaration, label);
	// A stale entry hash would otherwise mask a declaration change and poison
	// incremental frontend emission (which keys off this hash).
	if (hashText(declaration) !== e.hash) {
		throw new Error(`Malformed chowbea bus manifest: ${label}.hash does not match its declaration content ("${name}")`);
	}
}

/**
 * Parses a manifest and validates it structurally — this is the trust
 * boundary every network-fetched manifest passes through (a hostile or
 * compromised bus endpoint is untrusted input). Beyond the envelope
 * (version/hash/barrels), each barrel key must be a safe relative path
 * segment (emit.ts does `path.join(busDir, name)` — an unchecked key
 * could traverse out of `busDir`) and each entry's fields must have the
 * expected types (a non-string `declaration`, for example, would
 * otherwise emit a literal `undefined` into generated code).
 */
export function parseManifest(json: string): BusManifest {
	const raw = JSON.parse(json) as Partial<BusManifest>;
	if (typeof raw !== "object" || raw === null || typeof raw.chowbeaBus !== "string") {
		throw new Error("Malformed chowbea bus manifest: missing chowbeaBus version field");
	}
	if (raw.chowbeaBus !== BUS_VERSION) {
		throw new BusVersionError(raw.chowbeaBus);
	}
	if (typeof raw.hash !== "string" || typeof raw.barrels !== "object" || raw.barrels === null) {
		throw new Error("Malformed chowbea bus manifest: missing hash or barrels");
	}
	if (typeof raw.generatedAt !== "string") {
		throw new Error("Malformed chowbea bus manifest: generatedAt must be a string");
	}
	for (const [key, entries] of Object.entries(raw.barrels)) {
		if (!isSafeBarrelKey(key)) {
			throw new Error(`Malformed chowbea bus manifest: unsafe barrel key "${key}"`);
		}
		if (!Array.isArray(entries)) {
			throw new Error(`Malformed chowbea bus manifest: barrels["${key}"] is not an array`);
		}
		entries.forEach((entry, i) => assertValidEntry(entry, key, i));
	}
	// A stale root hash would otherwise mask real barrel changes and poison
	// the If-None-Match / hash-compare cache-skip in syncBus.
	const recomputed = hashBarrels(raw.barrels);
	if (recomputed !== raw.hash) {
		throw new Error("Malformed chowbea bus manifest: hash does not match barrels content");
	}
	return raw as BusManifest;
}

export interface BusDiff {
	added: string[];
	removed: string[];
	changed: string[];
}

/** Compare by type name (names are globally unique — duplicates are extraction errors). */
export function diffManifests(base: BusManifest, next: BusManifest): BusDiff {
	const flat = (m: BusManifest) =>
		new Map(Object.values(m.barrels).flat().map((e) => [e.name, e.hash]));
	const a = flat(base);
	const b = flat(next);
	return {
		added: [...b.keys()].filter((n) => !a.has(n)).sort(),
		removed: [...a.keys()].filter((n) => !b.has(n)).sort(),
		changed: [...b.keys()].filter((n) => a.has(n) && a.get(n) !== b.get(n)).sort(),
	};
}
