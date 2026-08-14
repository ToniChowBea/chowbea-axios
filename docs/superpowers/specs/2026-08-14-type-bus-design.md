# Type Bus — Design Spec

**Date:** 2026-08-14
**Status:** Approved design, pre-implementation
**Owner:** chowbea-axios

## Problem

OpenAPI covers request/response contracts, but backends hold many types the
frontend needs that never cross an endpoint boundary cleanly: `Map`-typed
definitions, discriminated unions, generic helpers, domain vocabulary. Routing
those through OpenAPI requires re-modelling each one as a DTO with Nest
decorators — busywork that loses fidelity (OpenAPI cannot express `Map`,
generics, mapped types, template literals) and duplicates the source of truth.
Teams end up hand-copying types to the frontend, which drift.

The Type Bus syncs arbitrary TypeScript types from an API repo to a frontend
with no OpenAPI involvement: mark a type on the backend, run the existing
`fetch` on the frontend, import it typed.

## Design principles

- **Declaration text is the wire format.** A type's serializable form is its
  source text. No intermediate representation (no Zod, no JSON-schema
  round-trip) — those lose exactly the constructs OpenAPI already loses.
- **One artifact, one transport, both dev modes.** Full-stack local dev and
  fetch-from-staging use the same pipeline; only the URL differs, same as the
  OpenAPI spec flow today.
- **The bus is intentional.** Nothing rides it implicitly; every type is
  explicitly marked, and every reference must itself be on the bus
  (closed-world). Errors do the guiding.
- **CI/CD is first-class.** Every rule is enforceable as a non-zero exit in a
  pipeline; drift is impossible by construction; breaking changes are
  detectable before merge.

## 1. Backend authoring model

Two marking channels:

1. **File convention:** any file matching `*.chowbea.ts` — all exported types
   go on the bus. Intended mostly as colocated barrels
   (`src/exams/grade.chowbea.ts` re-exporting from sibling modules), so types
   stay next to the services that own them.
2. **Comment marker:** `/** @chowbea-export */` JSDoc directly above a type
   declaration anywhere in the codebase.

Rules (all violations are extraction-time errors, batch-reported with
`file:line`):

- **Duplicates:** the same type name registered twice — across barrels, across
  channels, or barrel + marker — errors, printing the name and both
  registration sites.
- **Closed world:** a bus type may reference primitives, TypeScript lib
  built-ins (`Map`, `Set`, `Date`, `Record`, `Partial`, unions, generics,
  template literals, mapped/conditional types), and other bus types. A
  reference to a non-bus project type errors:
  `GradeMap references Grade (src/exams/models.ts:12) — add it to a
  .chowbea.ts barrel or mark it @chowbea-export.` References to types imported
  from `node_modules` are errors in v1. Qualifier-less `typeof import("...")`
  module-namespace types are not yet validated (v1 limitation, tracked for
  follow-up).
- **Types only (v1):** type aliases, interfaces, and enums are allowed. Enums
  are carried as declarations (they are values too, and the frontend emission
  reproduces them verbatim). Classes, `const`s, functions, and Zod schemas on
  the bus are errors — runtime values are a different feature.

## 2. Extractor — `chowbea-axios extract`

New CLI command, run in the **API repo** (reached via the existing local-first
bin delegation). Implementation uses the **TypeScript compiler API directly**
(`typescript` is already a dependency; ts-morph adds nothing needed for
"enumerate exports, resolve references, slice declaration text").

Behavior:

1. Load the API's `tsconfig.json` (nearest to cwd; `--project` overrides) and
   build a program.
2. Sweep both channels: glob `**/*.chowbea.ts` within the program's files;
   scan JSDoc for `@chowbea-export`.
3. For each collected type: resolve every type reference via the checker and
   validate the closed-world rule; detect duplicates by exported name.
4. Slice each declaration's source text verbatim (re-exported types slice the
   original declaration, not the re-export line).
5. Emit `chowbea.bus.json` (project root by default; `--out` overrides).

Flags: `--check` (validate only, no artifact — CI gate), `--watch`
(re-extract on change — dev loop), `--diff <url|file>` and `--fail-on-removed`
(see §6), `--project`, `--out`.

Errors never fail on first: every violation in one pass, plain
non-TTY-friendly output.

## 3. Artifact — `chowbea.bus.json`

Chowbea's own spec format, versioned independently of OpenAPI:

```json
{
  "chowbeaBus": "1",
  "generatedAt": "2026-08-14T00:00:00Z",
  "hash": "<content hash of everything below>",
  "barrels": {
    "exams/grade": [
      {
        "name": "GradeMap",
        "kind": "type",
        "declaration": "export type GradeMap = Map<StudentId, Grade>;",
        "source": "src/exams/grade.chowbea.ts",
        "line": 3,
        "hash": "<declaration hash>"
      }
    ],
    "_marked/exams": [ ... ]
  }
}
```

- **Barrel keys** derive from the `.chowbea.ts` file's path relative to the
  tsconfig `rootDir` (project root when unset), minus the suffix
  (`src/exams/grade.chowbea.ts` → `exams/grade`). Marker-channel types group
  under `_marked/<source dir>` — the `_marked/` prefix is reserved and cannot
  collide with barrel keys, since barrel keys never start with `_marked/`
  (a literal `src/_marked/` directory containing barrels is rejected at
  extraction with a clear error).
- **`generatedAt` lives only here** — the artifact is a build output, never
  committed, so no volatile-field conflict class (lesson from the
  "Total operations" header).
- **Per-type hashes** allow incremental frontend emission; the **top-level
  hash** makes unchanged-manifest a single comparison (and serves as the HTTP
  ETag).
- **`chowbeaBus` version** is the compatibility hinge: a frontend CLI meeting
  an unknown version fails loud ("upgrade chowbea-axios"), never mis-parses.

## 4. Serving — `chowbea-axios/api`

New package export (`./api` in the export map). Deliberately tiny,
framework-agnostic, no Nest module/DI in v1:

- `readBusManifest(path?)` — loads the artifact (default: `chowbea.bus.json`
  resolved from `process.cwd()`).
- `busHandler(manifest)` — `(req, res)` handler serving the manifest as JSON
  with the manifest hash as `ETag` (supports `If-None-Match` → 304). Mounts in
  Express/Nest with one line:
  `app.use("/.well-known/chowbea.json", busHandler(readBusManifest()))`.

Default path convention: **`/.well-known/chowbea.json`** (configurable by
mounting elsewhere). The artifact is produced at build time (`extract` in the
API's build script), so it ships with every deploy — dev, staging, prod serve
it identically.

## 5. Frontend — config, fetch, emission

**Config** (`api.config.toml`), optional — absent block means the feature is
fully inert:

```toml
[bus]
endpoint = "https://staging.example.com/.well-known/chowbea.json"
```

`[fetch.auth]` applies to bus fetches too.

**Fetch:** `fetch` pulls the manifest alongside the spec, caches it under
`_internal/` (mirroring the OpenAPI cache), and skips regeneration when the
top-level hash is unchanged. Diff reporting (added / changed / removed types
by name and hash) is shipped as part of this sync — logged on every
`fetch`/`watch` cycle that changes the bus — and via `extract --diff` on the
backend side (§2/§6); a standalone `diff` command with bus awareness is
deferred.

**Emission:** mirrors backend barrels — one generated file per barrel key with
`/` flattened to `.` (`exams/grade` → `_generated/bus/exams.grade.ts`), marker
groups keeping their reserved prefix (`_marked/exams` →
`_generated/bus/_marked.exams.ts`, so they can never collide with a barrel
file), plus `_generated/bus/index.ts` re-exporting everything. Declarations are written verbatim under the standard
generated-file header (no counters, no timestamps). Consumers import from the
barrel or per-domain files; downstream conventions build on the per-domain
unit. This deliberately avoids the single-file shape that produced an
87k-line `api.contracts.ts` in a large consumer project.

## 6. CI/CD — first-class

**Backend (API repo):**

- `extract --check` in PR CI: full validation, non-zero exit on any rule
  violation, every violation printed with `file:line`.
- **No-drift by construction:** the artifact is generated during build, never
  committed — deployed manifest always matches deployed source.
- **Compatibility gate:** `extract --diff <baseline>` (URL of the live
  staging manifest, or a file) reports added/changed/removed;
  `--fail-on-removed` turns removals into hard CI failures — the tripwire for
  "this PR breaks every frontend importing `GradeMap`." Renames surface as
  remove + add, which is what they are to consumers.

**Frontend:**

- The scaffolded `chowbea-axios-ci.yml` template gains a bus step alongside
  the existing spec staleness check: fetch manifest from staging, regenerate,
  fail if committed `_generated/bus/**` is stale. The bus endpoint is not
  derived from the existing staging endpoint var — CI teams configure
  `[bus].endpoint` explicitly, same as any other environment-specific value.

**Merge conflicts:** bus output lives under `_generated/`, so the existing
`resolve` command auto-regenerates conflicted bus files with no changes
needed (prefix-based partitioning already covers subdirectories).

## 7. Dev loops

- **Full-stack local:** backend runs `extract --watch`; frontend runs `watch`
  pointed at localhost. Saving a `.chowbea.ts` file propagates a typed change
  to the frontend in seconds.
- **Staging mode:** identical to the OpenAPI workflow — re-run `fetch` (or
  `watch`) against the deployed endpoint; no backend access needed.

## 8. Error handling summary

| Failure | Where | Behavior |
| --- | --- | --- |
| Duplicate type name | extract | Error: name + both file:line sites |
| Non-bus type referenced | extract | Error: referencer, referenced type's location, fix instruction |
| node_modules type referenced | extract | Error (v1) |
| Class/const/function on bus | extract | Error: types only in v1 |
| Unknown `chowbeaBus` version | frontend fetch | Fatal: "upgrade chowbea-axios" |
| Bus endpoint unreachable | frontend fetch | Same UX as spec-fetch failure (respects cached manifest for `generate`) |
| Removed type vs baseline | extract --diff | Report; hard fail with `--fail-on-removed` |

All extraction errors batch-report; none fail-on-first.

## 9. Testing

- **Extractor:** fixture projects under `tests/fixtures/bus/` exercising:
  barrel sweep, marker sweep, both-channel duplicates, closed-world
  violations (project type, node_modules type), types-only rule, slicing
  fidelity for `Map`/generics/mapped/conditional/template-literal types,
  re-export slicing (original declaration captured).
- **Artifact:** manifest snapshot; hash stability (same input → same hash;
  declaration change → hash change).
- **Handler:** content-type, ETag/304 behavior.
- **Frontend:** emission snapshots (mirrored layout, barrel index), inert
  behavior with no `[bus]` config, unknown-version failure, diff reporting.
- Same vitest setup as the rest of the repo; no new frameworks.

## 10. Out of scope (v1)

- Zod or any runtime-validation layer; Redis or any intermediary transport.
- Runtime values on the bus (consts, classes, functions).
- Transitive auto-closure and node_modules type flattening.
- Monorepo / published-package distribution mode.
- Nest-specific module/decorator sugar for the handler.

## Decision log

| Decision | Choice | Rejected alternatives |
| --- | --- | --- |
| Marking | `*.chowbea.ts` sweep + `@chowbea-export`, duplicate = error | single central barrel; directory convention |
| Dependency policy | Closed world, errors guide additions | transitive auto-closure (surprise imports); hybrid |
| Wire format | Verbatim declaration text in JSON manifest | Zod/JSON-schema round-trip (lossy) |
| Transport | Dedicated `chowbea.bus.json` + `/.well-known/chowbea.json` | embedding in OpenAPI doc (couples to Swagger, fattens payload); Redis (infra burden); committed artifact (publish friction) |
| Frontend layout | Mirrored per-barrel files + index | single file (87k-line contracts precedent); full directory tree |
| Extractor tech | TypeScript compiler API (existing dep) | ts-morph (new dep); regex scan (can't resolve references) |
