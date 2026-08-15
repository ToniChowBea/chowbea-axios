# Chowbea Rebrand — Design Spec

**Date:** 2026-08-15
**Status:** Approved design, pre-implementation
**Owner:** chowbea-axios → chowbea

## Problem

The package outgrew its name. `chowbea-axios` began as an OpenAPI→typed-axios
client generator; it now also ships the Type Bus (syncing arbitrary TypeScript
types between repos with no OpenAPI or axios involvement), a TUI dashboard,
Vite plugins, and git conflict tooling. "axios" both undersells and misleads —
the Type Bus's backend surface (`chowbea-axios/api`) has nothing to do with
HTTP clients. Users already type `chowbea` from muscle memory.

Target identity: **`chowbea`** on npm (`npm install chowbea`), `chowbea` as
the primary CLI command. No "Simple Chowbea" display branding — the bare name
is the brand.

## Decisions (approved)

1. **Bare `chowbea`**, not an npm org scope. (Name verified available.
   Defensively create the `chowbea` npm org name too if npm permits.)
2. **Version continues at `3.0.0`** — signals lineage from 2.x; the identity
   change is honestly major (`feat!:` commit).
3. **GitHub repo renames to `ToniChowBea/chowbea`** in the same effort, with
   workflow repo-guards and npm Trusted Publisher entries updated in the
   rename change itself — never after a broken release (lesson from the
   owner-rename incident: guards silently skip and publishes 404 when config
   lags the rename).
4. **Docs domain `axios.chowbea.com` stays** for now; a move (e.g.
   `cli.chowbea.com`) is optional later and blocks nothing. README links keep
   working either way.

## Strategy: publish new, shim old

npm has no rename. The migration is: publish this codebase as `chowbea`, then
convert `chowbea-axios` into a thin compatibility shim, then deprecate the old
name with a pointer. Existing consumers never hard-break.

### Package 1 — `chowbea@3.0.0` (this repo, renamed)

- `package.json` `name: "chowbea"`, `version` continues via release-please
  (next release after the `feat!:` rename commit is 3.0.0).
- **Bins:** `"chowbea": "bin/chowbea-axios.js"` (primary) **and**
  `"chowbea-axios": "bin/chowbea-axios.js"` (kept indefinitely — scripts,
  CI files, and muscle memory keep working). The bin script file itself may
  keep its filename; only the exposed names matter.
- Exports unchanged: `.`, `./vite`, `./api` — same entry points, same types,
  same behavior. Consumers changing only the package name in imports
  (`chowbea-axios/api` → `chowbea/api`) need no other edits.
- Repository/bugs URLs → `ToniChowBea/chowbea` (with the repo rename).

### Package 2 — `chowbea-axios@3.0.0` (the shim)

A separate, minimal package (maintained in this repo under `shim/` for
versioning convenience, published independently):

- `dependencies: { "chowbea": "^3.0.0" }`.
- Re-export stubs for all three entry points:
  `index.js` → `export * from "chowbea"`, `vite.js` → `chowbea/vite`,
  `api.js` → `chowbea/api` (ESM), plus a CJS `api.cjs` stub
  (`module.exports = require("chowbea/api")`) mirroring the dual-format
  export map shape of the real package.
- Bin `chowbea-axios` → a two-line forwarder that imports chowbea's router
  (equivalent behavior to the real bin).
- `peerDependencies`/engines mirrored so installs resolve identically.
- After publish: `npm deprecate chowbea-axios "Renamed to chowbea — npm
  install chowbea"` (all versions; old versions remain installable).

### Local-first delegation — dual-name support (real code, not find-replace)

`src/core/local-resolution.ts` hardcodes `chowbea-axios` in two places:
`resolveLocalInstall` walks `node_modules/chowbea-axios` and reads
`pkg.bin["chowbea-axios"]`. Post-rename reality is mixed installs in both
directions (old global + new local, new global + old project pin). Required
behavior:

- `resolveLocalInstall` checks `node_modules/chowbea` **first**, then
  `node_modules/chowbea-axios`; accepts a bin named `chowbea` or
  `chowbea-axios` (in that order) from whichever package resolves.
- A resolved `chowbea-axios` local install that is the **shim** delegates
  correctly by construction (its bin forwards to chowbea), so no
  shim-detection is needed.
- `findRunningPackageRoot`/`decideDelegation` self-identification must treat
  the two package names as the same tool (an old global delegating to a new
  local must not bounce, and the `CHOWBEA_LOCAL_DELEGATED` sentinel already
  prevents loops regardless of name).

## Release plumbing

- **release-please:** reads the package name from `package.json` — no config
  change needed beyond the repo working post-rename. Existing `v2.x` tags
  remain valid history; the rename lands as `feat!:` so the next release PR
  is `chore(main): release 3.0.0`.
- **npm Trusted Publishing:** entries are per-package. Constraint: a Trusted
  Publisher can only be configured on an **existing** npm package, so the
  bootstrap order is fixed:
  1. First `chowbea@3.0.0` publish is **manual** (`npm publish` from a
     logged-in machine, from the release-tagged commit).
  2. Then add the Trusted Publisher entry for `chowbea`
     (org `ToniChowBea`, repo `chowbea`, workflow `release-please.yml`),
     plus the optional `release.yml` fallback entry.
  3. `chowbea-axios` (shim) publishes are infrequent; manual publish is
     acceptable, or a publisher entry may be added the same way.
  4. Automation resumes from 3.0.1.
- **Workflow guards:** both `release-please.yml` and `release.yml` guard on
  `github.repository == 'ToniChowBea/chowbea-axios'`; the rename change
  updates them to `ToniChowBea/chowbea` in the same commit that assumes the
  repo rename. The repo rename itself is a manual GitHub step performed at a
  defined point in the sequencing (below); GitHub redirects cover old
  remotes, links, and `gh` calls.

## Find-replace tier (mechanical)

- README: title, install commands (`npm install chowbea`, `npx chowbea init`),
  badges (npm badge → `chowbea`, repo badges → new slug), example commands.
  Keep an explicit "Renamed from chowbea-axios" migration note near the top
  for one major cycle.
- CI template (`templates/chowbea-axios-ci.yml`): commands → `npx chowbea`;
  the template filename may stay (cosmetic; renaming it breaks nothing for
  existing users since it is scaffolded, not referenced).
- `init` scaffolding, runner help text, TUI strings, error messages
  referencing the old name.
- Docs-site content updates are out of repo scope but tracked in rollout.

## Deliberately unchanged (already brand-neutral)

`api.config.toml` (name and contents), the generated output layout
(`_generated/`, `_internal/`), `*.chowbea.ts` barrels, `chowbea.bus.json`,
`/.well-known/chowbea.json`, `CHOWBEA_*` env vars, `DEFAULT_API_ROUTE`.
Existing projects regenerate with zero churn.

## Sequencing

| Phase | Actor | Action |
| --- | --- | --- |
| 1 | code | Rename PR: package name+bins, dual-name delegation, shim package, docs/templates, workflow guards (pre-staged for new slug), `feat!:` commit |
| 2 | owner | Merge; **rename the GitHub repo** to `ToniChowBea/chowbea` immediately after merge (guards already expect it) |
| 3 | owner+code | Merge the `release 3.0.0` PR (its publish step will 404 — expected, publisher entry doesn't exist yet); first `chowbea` publish manually from the tag; then add Trusted Publisher entries |
| 4 | code/owner | Publish `chowbea-axios@3.0.0` shim; `npm deprecate` old name with pointer |
| 5 | consumers | `npm i chowbea` at leisure; imports optionally updated; old specifier works via shim indefinitely |

Phase-3 note: alternatively the owner can pre-create the `chowbea` package
with a `0.0.0` placeholder before Phase 2 and add the publisher entry early,
making the 3.0.0 release publish cleanly with no manual publish. Preferred if
the owner is comfortable doing the placeholder publish first — the plan
treats it as the happy path and the manual-from-tag flow as fallback.

## Testing

- Existing suite green under the new name (tests reference behavior, not the
  package name, except local-resolution tests — extended for dual-name).
- Local-resolution: new cases — local `chowbea` found by old-name global;
  local `chowbea-axios` (shim shape) found by new-name global; `chowbea` bin
  key preferred over `chowbea-axios` when both exist.
- Shim: pack-and-install smoke — `npm i` the packed shim in a temp dir with
  the packed `chowbea` tarball; `require("chowbea-axios/api")`,
  `import("chowbea-axios")`, and `npx chowbea-axios --version` all work and
  report the underlying chowbea version.
- Pack-check / CI matrix unchanged.

## Out of scope

- Docs domain move; docs-site content rewrite (tracked separately).
- Renaming config file, generated layout, bus conventions (already neutral).
- npm org creation beyond defensive name registration.
- Removing the `chowbea-axios` bin alias or shim (indefinite support).

## Decision log

| Decision | Choice | Rejected alternatives |
| --- | --- | --- |
| npm identity | bare `chowbea` | `@chowbea/cli` org scope (worse install DX; splitting not imminent) |
| Versioning | continue at 3.0.0 | reset to 1.0.0 (breaks migrator semver intuition) |
| Old name | shim + deprecate, kept indefinitely | hard deprecate without shim (breaks CJS/ESM consumers on old specifier) |
| Repo | rename with guards updated in-change | keep old slug (perpetual name mismatch); rename later (repeat of the 404 incident) |
| Bins | both `chowbea` and `chowbea-axios` | new bin only (breaks every existing script and CI file) |
| First publish | placeholder-then-automated preferred; manual-from-tag fallback | trusted-publisher-first (impossible: entry requires existing package) |
