# Adoption-Readiness Audit — 2026-05-04

**Package:** `chowbea-axios@2.0.0-alpha.21`
**Scope:** Breadth-first triage across three lanes — security & supply chain, code quality & API surface, docs/legal/operational — for enterprise-adoption readiness.
**Method:** Three parallel read-only `Explore` agents on a snapshot of `main`; findings deduped and ranked here.
**Status of this branch (`chore/release-and-adoption-quickwins`):** Step A applied — see [Status / what was fixed in step A](#status--what-was-fixed-in-step-a) at the bottom.

## TL;DR

The code itself is in good shape. Recent commits (`74e4f8d`, `a2094ef`, `414f61b`, `64ddf76`) closed most of the realistic security holes (SSRF, TOML escape, JSDoc escape, identifier sanitization, recursion DoS, prototype pollution, CI template hardening). Public API surface is minimal and intentional.

What trips up enterprise review is missing *adopter-facing operational signals*, not code defects:

- No CI workflow → no proof tagged releases are tested
- No CHANGELOG → release history invisible
- No SECURITY.md → AppSec can't approve a package with no disclosure policy
- LICENSE not in `files` whitelist → relies on implicit npm behavior
- A handful of `any` leaks (`createOperations`, TUI template props)

None are true blockers. All-in: roughly half a day to a day to clear the High items.

## Top 3 risks

1. **No CI workflow in the package repo.** You ship a CI *template* for users, but the package itself has zero GitHub Actions on PR or main. The "how do you guarantee tagged releases are tested?" question has no answer. — High, L effort.
2. **`createOperations(apiClient: any)`** at `src/core/generator.ts:554`. The most-called public-ish API takes `any`. Reviewers infer the rest is loose. — High, S effort.
3. **No SECURITY.md.** Many AppSec teams gate adoption on a documented private-disclosure path and supported-versions statement. — High, S effort.

## Findings — by severity

### High

#### H1. No CI workflow in the package repo — [issue #61](https://github.com/ToniChowBea/chowbea-axios/issues/61)
- **Lane:** Ops
- **Where:** missing `.github/workflows/`
- **What:** Package has no Actions running on PR / main / tag. No test gate, no Node-version matrix (`engines: >=20` declared but never proven against 20/22/24), no automated publish. The only `.yml` is the user-facing CI *template*.
- **Why it matters:** Adoption gate question "how do you prevent broken releases?" has no answer. Future contributors get zero feedback on PRs.
- **Effort:** L (>4h). Minimum useful set: test+typecheck matrix on Node 20/22/24, plus a tag-triggered release workflow that runs `npm ci && npm test && npm publish --provenance`.

#### H2. `createOperations` takes `apiClient: any`
- **Lane:** Quality
- **Where:** `src/core/generator.ts:554`
- **What:** Public-facing entry function has no type contract on its main parameter. Callers can pass anything; TypeScript won't complain at the call site.
- **Why it matters:** Reviewers reading source see `any` on the most-called API and infer the rest is loose. Easy to fix, high signal once fixed.
- **Effort:** S (<1h). Replace with a structural `ApiClient` interface declared locally in the emitted template — no circular type import required.

#### H3. No SECURITY.md
- **Lane:** Legal/Ops
- **Where:** missing file at repo root
- **What:** No documented vulnerability disclosure path, no supported-versions statement.
- **Why it matters:** Many enterprise AppSec checklists block adoption without this.
- **Effort:** S (<1h). GitHub-suggested template + a sentence on supported versions.

#### H4. No CHANGELOG.md — [issue #62](https://github.com/ToniChowBea/chowbea-axios/issues/62)
- **Lane:** Docs
- **Where:** missing file at repo root
- **What:** Package is at `2.0.0-alpha.21` with no published history of what changed between alphas. `git log` is not the same artifact as a curated CHANGELOG.
- **Why it matters:** Adopters can't evaluate stability trends or upgrade risk.
- **Effort:** M (1-4h). Retroactive entries from `git log`, then keep going forward (Keep-a-Changelog or release-please).

#### H5. `LICENSE` not in `package.json` `files` whitelist
- **Lane:** Legal
- **Where:** `package.json:21-25`
- **What:** `files: ["bin","dist","templates"]` — LICENSE exists at repo root and npm includes it implicitly, but explicit > implicit. A future tooling change could strip it.
- **Why it matters:** Legal review wants the license file in every published tarball. Trivial to make explicit.
- **Effort:** S (<1h). Add `"LICENSE"` to the array.

#### H6. TUI template props typed as `any` — [issue #63](https://github.com/ToniChowBea/chowbea-axios/issues/63)
- **Lane:** Quality (codegen)
- **Where:** `src/core/vite-plugin-templates.ts:724, 734`
- **What:** `CurrentPanel` and `SidepanelState` ship `props: any`. These templates are emitted into user projects — the `any` propagates into adopter code.
- **Why it matters:** You set the typing pattern for code your users write. `any` in templates is "we don't trust the types we generated."
- **Effort:** M (1-4h). Generic `TProps extends Record<string, unknown>` threaded through the template.

### Medium

#### M1. Fetch lacks timeout + response size cap — [issue #64](https://github.com/ToniChowBea/chowbea-axios/issues/64)
- **Lane:** Security
- **Where:** `src/core/fetcher.ts:315, 327`
- **What:** `fetch()` has no `AbortSignal.timeout(...)`; `response.arrayBuffer()` buffers the whole body with no size limit.
- **Why it matters:** Slow-loris or oversized response from a malicious/misconfigured spec URL can hang or OOM the CLI. AppSec flags both as DoS vectors.
- **Effort:** M (1-4h). Wire `AbortSignal.timeout(30_000)` and read with a streaming cap (e.g., 50 MB default, configurable).

#### M2. `output.folder` accepts arbitrary absolute paths — [issue #65](https://github.com/ToniChowBea/chowbea-axios/issues/65)
- **Lane:** Security
- **Where:** `src/core/config.ts:618-620` (`resolveOutputFolder`)
- **What:** A config-supplied `output.folder = "/"` (or `C:\Windows`) writes generated files there with no containment. Intentional today, but unbounded.
- **Why it matters:** Lower realistic risk (config is user-controlled), but enterprises with shared CI runners want opt-in containment.
- **Effort:** M (1-4h). Add `forbidAbsolutePath` option (default off for compat, on for strict mode) and document in README.

#### M3. `tsconfig.json` strictness gaps — [issue #66](https://github.com/ToniChowBea/chowbea-axios/issues/66)
- **Lane:** Quality
- **Where:** `tsconfig.json:3-13`
- **What:** `strict: true` is on, but `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and explicit `noImplicitAny` are absent. `skipLibCheck: true` masks dep-type errors.
- **Why it matters:** Adopters running with full strict will inherit any latent index-access bugs your build masks.
- **Effort:** S to flip the flags, plus a likely cleanup pass for what they surface. Net M.

#### M4. Zero test coverage for the TUI layer — [issue #67](https://github.com/ToniChowBea/chowbea-axios/issues/67)
- **Lane:** Quality
- **Where:** `tests/` (11 files, 167 cases) covers generator + runtime; nothing for `src/tui/`
- **What:** `init-wizard.tsx` (~1131 LOC) and `endpoint-inspector.tsx` (~926 LOC) have no tests.
- **Why it matters:** Adopters using the TUI become your QA. Not a blocker — most adopters will use the headless CLI — but should be declared as "experimental TUI" in the README if no tests will be added.
- **Effort:** L (>4h) for meaningful coverage. **Alternative S effort:** label TUI experimental in README.

#### M5. Vite plugin templates are unparsed strings — [issue #68](https://github.com/ToniChowBea/chowbea-axios/issues/68)
- **Lane:** Quality
- **Where:** `src/core/vite-plugin-templates.ts` (1211 LOC of string-literal templates)
- **What:** A syntax error in a template ships and only blows up in the user's build.
- **Why it matters:** First user experience of a template bug is a broken build in their project.
- **Effort:** M (1-4h). Vitest tests that parse each emitted file with the TypeScript compiler API to catch syntax errors.

#### M6. ESM-only constraint not prominently documented — [issue #69](https://github.com/ToniChowBea/chowbea-axios/issues/69)
- **Lane:** Docs
- **Where:** README (no "Module Format / Compatibility" section)
- **What:** `package.json` has `"type": "module"`. CJS consumers will hit `ERR_REQUIRE_ESM`.
- **Why it matters:** Enterprises with legacy CJS code will try, fail, file an issue. Cheap to document up front.
- **Effort:** S (<1h). 2-3 README sentences.

#### M7. Versioning / support policy undefined — [issue #70](https://github.com/ToniChowBea/chowbea-axios/issues/70)
- **Lane:** Docs
- **Where:** README (no versioning section)
- **What:** Package is at `2.0.0-alpha.21`. No documented graduation criteria, semver policy, or support window for the eventual 2.x line.
- **Why it matters:** Enterprises ask "how long is 2.x supported?" and "when does this leave alpha?" Alpha looks indefinite otherwise.
- **Effort:** M (1-4h). Short VERSIONING.md or README section.

#### M8. No CONTRIBUTING.md or CODE_OF_CONDUCT.md — [issue #71](https://github.com/ToniChowBea/chowbea-axios/issues/71)
- **Lane:** Docs/Ops
- **Where:** missing files
- **What:** Standard adopter due-diligence files. Absence reads as "personal project."
- **Why it matters:** Compounds with no-CI and no-CHANGELOG to signal "early stage."
- **Effort:** M (1-4h). Boilerplate, plus a real "how to run tests" section in CONTRIBUTING.

### Low

#### L1. `vitest@^4.1.5` is on a recent major — [issue #72](https://github.com/ToniChowBea/chowbea-axios/issues/72)
- **Lane:** Quality
- **Where:** `package.json:48`
- **What:** Vitest 4.x is stable but young.
- **Why it matters:** Cosmetic for most adopters; a strict shop may flag it.
- **Effort:** S (<1h). Verify tests pass on `^3.21.0` and broaden the constraint.

#### L2. No issue templates
- **Lane:** Ops
- **Where:** missing `.github/ISSUE_TEMPLATE/`
- **Effort:** S (<1h). Too small to be worth a tracking issue; handle in a future quick-wins sweep.

#### L3. `prepublishOnly` failure on fresh checkouts (the original branch bug)
- **Lane:** Ops/Supply chain
- **Where:** `package.json:30`
- **What:** Running `npm publish` without first running `npm install` fails with `tsc: command not found`.
- **Effort:** S (<1h). Fixed in step A — see below.

#### L4. Generated code path-param URL-encoding is implicit
- **Lane:** Security (documentation)
- **Where:** `src/core/generator.ts:162, 167, 176, 181`
- **What:** Path-template literal is `JSON.stringify`-escaped at codegen time. Runtime values in `pathParams` rely on the axios layer to URL-encode. Safe in practice; not explicit in emitted JSDoc.
- **Why it matters:** AppSec auditors want explicit confirmation. Adding it to emitted JSDoc removes a likely question.
- **Effort:** S (<1h). Fixed in step A — see below.

### Info (not actionable)

#### I1. `src/core/generator.ts` is ~2743 LOC
Single cohesive file covering operations, contracts, types, schema resolution, escaping, sanitization. Internally well-documented. Splitting is taste-driven, not adoption-blocking.

#### I2. Public API surface is small and intentional
Positive finding. `src/index.ts` exports the CLI dispatcher; `src/vite/index.ts` exports `surfacesCodegen` and `sidepanelsCodegen` only. No accidental internal exports. Real strength — worth highlighting to adopters.

#### I3. Module boundaries are clean
`src/core` (logic), `src/tui` (UI), `src/adapters` (interfaces), `src/headless` (CLI), `src/vite` (plugin templates). No circular imports detected.

## Clean areas (verified — what's already solid)

These are questions adopters will ask that already have a good answer:

- **SSRF:** `validateEndpointUrl()` rejects non-`http/https` schemes.
- **JSDoc injection:** `escapeJsdoc()` is used consistently at all user-controlled emission points.
- **Identifier safety:** `sanitizeIdentifier` strips non-`[A-Za-z0-9_$]`, prefixes leading digits; `formatPropertyKey` quotes invalid bare-identifier keys.
- **Recursive-schema DoS:** `visited` set guards `$ref` cycles.
- **Prototype pollution:** no spec-key → object-property assignment; safe iteration patterns.
- **TOML escape:** `tomlEscape` round-trips via `JSON.stringify`.
- **Env interpolation:** regex fix in PR #56 disambiguates `$VAR` vs `${VAR}`.
- **File I/O:** atomic temp-then-rename; backup/restore via `copyFile` + `rename`.
- **Dep ranges:** all `^` or `~`; no `*` or `latest`. `npm audit` cleaned in PR #58.
- **CI template hardening (the one shipped to users):** default-deny permissions, concurrency cancel, timeout, scoped diff paths, secret/vars pattern.
- **Public API surface:** small, intentional, well-JSDoc'd.
- **Error handling:** `Result<T>` is used consistently; custom `ChowbeaAxiosError` hierarchy.
- **Repo metadata in `package.json`:** `homepage`, `bugs`, `repository`, `author`, `license`, `keywords`, `engines` all populated.
- **README:** exists, covers quickstart, features, commands, auth, CI, Vite plugins.

## Couldn't verify (needs network / installed deps / runtime)

- `npm audit` output against current lockfile (no node_modules at audit time)
- `npm pack` tarball inspection
- Transitive license audit (`license-checker` or `cyclonedx-npm`)
- Actual behavior under Node 22 / 24 (no CI)
- Vitest coverage %
- npm provenance of published `2.0.0-alpha.21`

## Status / what was fixed in step A

Step A on branch `chore/release-and-adoption-quickwins` (this branch) addressed:

- **L3** — `release:experimental` npm script (publish now reproducible)
- **H5** — `LICENSE` explicit in `files` whitelist
- **H3** — `SECURITY.md` written + linked from README
- **H2** — `createOperations` typed via local `ApiClient` interface (`any` removed)
- **L4** — emitted JSDoc note on path-param URL encoding

After publishing `2.0.0-alpha.22`, the remaining findings are tracked as individual GitHub issues. Issue links are inlined per-finding above in a follow-up commit.

## Methodology notes

Audit ran three parallel `Explore` agents, each time-boxed and scoped:

1. **Security & supply chain** — generator output safety, CLI runtime surfaces, supply-chain posture, generated CI template, engines/runtime constraints.
2. **Code quality & API surface** — public exports, type strictness, error handling, test coverage signals, file size hotspots, module boundaries.
3. **Docs, licensing, operational** — README, CHANGELOG, LICENSE, SECURITY.md, CONTRIBUTING/CoC, package metadata, runtime compat, CI/release maturity, issue templates, versioning/support policy, SBOM-ability.

Findings were deduped (LICENSE-in-files appeared in both Security and Legal lanes; fetch timeout and size cap are really one concern), severity-ranked by adoption impact, and effort-tagged S/M/L for triage.
