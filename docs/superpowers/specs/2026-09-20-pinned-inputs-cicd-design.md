# Pinned API Inputs & Team CI/CD — Design

**Date:** 2026-09-20
**Status:** Approved design, pending implementation plan
**Depends on:** deterministic bus manifest (generatedAt removal, this branch)

## 1. Summary

Add an opt-in **pinned inputs** mode for client (frontend) repos. The two
inputs that types are generated from — the OpenAPI spec and the Type Bus
manifest — are committed to the client repo as `openapi.json` and
`chowbea.bus.json`. All generated TypeScript (`_generated/**`) becomes
gitignored. A new `sync` command is the only writer of the pinned files; a
CI workflow runs it when the backend announces a change
(`repository_dispatch`), opening a reviewable PR. Devs keep full freedom to
point their local workspace at any live backend (localhost, tunnels) via a
gitignored `api.config.local.toml` overlay — and nothing they generate
locally can reach a commit.

The pinned files are a lockfile for the API contract: `sync` is the bot
running the update, the dispatch is the backend ringing the doorbell.

## 2. Problem

Today `_generated/**` is committed and the CI template tells developers to
"run fetch locally and commit" when it drifts. On full-stack teams this
means:

- Committed types originate from whichever backend a dev happened to be
  running (localhost, a stale staging) — enforced only by review diligence.
- Merge-order races: a frontend PR merges first with types pulled from old
  staging; the backend PR merges and deploys later; frontend `main` is now
  silently stale with no signal and no reviewable update.
- Devs must be careful not to commit locally generated noise; care is not a
  guarantee.

### Goals

1. A dev running frontend + backend locally can generate against any URL
   (localhost, per-dev tunnel) with zero flags after one-time setup.
2. Structurally impossible — not merely checked — for locally generated
   output to be committed.
3. Builds (dev and CI) are reproducible and offline: any commit regenerates
   the exact types it was reviewed against.
4. Backend deploy → client repo gets a PR containing the type change, with
   the bus diff visible, typechecked against the whole app before merge.
5. Existing (non-pinned) setups keep working unchanged; pinned mode is
   opt-in.

### Non-goals

- Changing the API-repo (producer) side: `extract`, `busHandler()`, and the
  `extract --check` CI gates stay as they are.
- A TUI screen for `sync` (headless surface only, per the project's
  headless-first guarantee).
- Serving historical spec/manifest versions from the backend. Pinning lives
  in the client's git history.
- Changing the default mode for existing or new projects in this release.

## 3. Client repo layout (pinned mode)

| Path | In git? | Written by |
|---|---|---|
| `openapi.json` (pinned spec) | yes | `sync` only |
| `chowbea.bus.json` (pinned manifest) | yes | `sync` only |
| `api.config.toml` | yes | humans |
| `api.config.local.toml` | no (gitignored) | each dev, optional |
| client files (`instance`, `error`, `helpers`, `client` under `[output].folder`) | yes | scaffolded once, hand-edited (unchanged) |
| `<output>/_generated/**` (types, operations, bus barrels) | **no (gitignored — new)** | `generate` / `fetch` |
| `<output>/_internal/**` (caches) | no (gitignored, already) | `fetch` |

### Config

`spec_file` already exists. `BusConfig` gains one key:

```toml
api_endpoint = "https://staging.example.com/openapi.json"  # stable endpoint (sync, dev fetch default)
spec_file    = "openapi.json"                              # pinned spec, committed

[output]
folder = "src/api"

[bus]
endpoint = "https://staging.example.com/.well-known/chowbea.json"
file     = "chowbea.bus.json"   # NEW: pinned manifest path, committed
```

```ts
export interface BusConfig {
  endpoint: string;
  /** Repo-relative path of the pinned manifest. Enables pinned mode for the bus. */
  file?: string;
}
```

**Pinned mode** is not a flag; it is the presence of the relevant keys:
`spec_file` pins the spec, `[bus].file` pins the manifest. Validation: if
`[bus].file` is set, `[bus].endpoint` must also be set (sync needs a
source).

## 4. Command semantics

Three commands, three jobs. The resolution rule that makes them coexist:
**`generate` prefers pinned files; `fetch` prefers live endpoints.**

### `generate` — offline build step

- Spec: unchanged — `resolveSpecSource` already prefers `spec_file`.
- Bus (new): when `[bus].file` is set, read that file, run it through
  `parseManifest` (the untrusted-input boundary: version gate, barrel-key
  safety, declaration validation, hash integrity), and emit
  `_generated/bus/` from it. The `_internal` bus cache is not consulted.
  Missing file → error: `pinned bus manifest not found at <path> — run
  chowbea-axios sync`. When `[bus].file` is absent, current cache-based
  behavior is unchanged.
- Never touches the network. A hand-edited pinned manifest fails its hash
  check here, which is the desired outcome.

### `fetch [--endpoint URL]` — dev loop against a live backend

- Resolution (changed): `--endpoint` flag > `--spec-file` flag > merged
  config `api_endpoint` > config `spec_file`. (Flag order matches current
  code; only the config-level order changes.) Today a configured
  `spec_file` beats `api_endpoint` for bare `fetch`; in pinned mode both
  are set and `fetch` must mean "pull from the live endpoint". This is a
  documented behavior change, visible only to configs that set both keys
  (the scaffolded config comments one of them out, so this is rare).
- Writes only gitignored paths: `_internal/` caches and `_generated/`.
  **Never writes pinned files.**
- Bus: unchanged (`syncBusFromConfig` → cache + emit, resilient/warn-only).
  With a local overlay, the bus endpoint points at the dev's backend too.
- Consequence, by design: after a localhost `fetch`, a later bare
  `generate` snaps `_generated/` back to the pinned inputs. Pinned always
  wins for `generate`; the escape hatch is running `fetch` again. No mtime
  heuristics.

### `sync` — the only writer of pinned files (new)

Flow:

1. Load **committed config only** (see §5 — the local overlay is
   deliberately ignored; log when one is present and skipped).
2. Require `api_endpoint` + `spec_file`; if `[bus]` is configured, require
   `endpoint` + `file`. Actionable errors otherwise.
3. Fetch spec via the existing fetcher (retries, headers, auth,
   `normalizeSpecBuffer` canonical JSON). Fetch manifest via the existing
   bus fetch machinery with `If-None-Match` from the current pinned
   manifest's hash. Auth resolution is strictly non-interactive
   (`resolveBasicAuthNonInteractive`) — `sync` must never block on a TTY.
4. Validate both fully (spec parse, `parseManifest`) **before writing
   anything**. Then write only the artifacts whose content hash changed.
   Manifest bytes use the same format `extract` writes
   (tab-indented + trailing newline) so producer file and client pin are
   byte-identical for identical content.
5. Regenerate types from the (possibly updated) pinned inputs, so a local
   run leaves a consistent tree.
6. Report per artifact: `changed` / `unchanged`, plus the bus name-level
   diff (`+ added`, `~ changed`, `- removed`) via `diffManifests` against
   the previous pinned manifest.

Failure posture: **loud**. Any fetch or validation failure exits non-zero
with nothing written — the opposite of `fetch`'s resilient bus posture,
because a bot must never open a PR from a half-updated or unvalidated
state. There is no cache fallback: the current pinned files already are
the last known good.

Exit code is 0 whether or not anything changed; the CI workflow detects
changes with `git diff` (and the PR action no-ops on a clean tree). A
`--check` staleness flag is deliberately deferred until something needs it.

CLI surface: `chowbea-axios sync [--config <path>]`, registered in the
headless runner with help text alongside the existing commands.

## 5. Local overrides — `api.config.local.toml`

Per-dev endpoints (ports, tunnels) differ for everyone, so they cannot
live in the committed config.

- Sits next to `api.config.toml`; gitignored.
- Merge: field-level, local wins; nested tables merge per key (a local
  `[bus] endpoint = ...` overrides that key only); scalars and arrays
  replace. Precedence: CLI flags > local > committed.
- Applies to `fetch`, `generate`, `watch`, and the read-only commands.
  **`sync` loads the committed config only** — otherwise a dev with tunnel
  overrides running `sync` by hand would pin their tunnel's spec into the
  committed files, which is the exact leak this design exists to prevent.
- Visibility: when an overlay is active, log one line naming the
  overridden keys (e.g. `local overrides: api_endpoint, bus.endpoint`).
- Typical content: `api_endpoint`, `[bus].endpoint`, sometimes
  `[fetch.headers]`/`[fetch.auth]` for tunnel auth. Structural keys
  (`[output].folder`, `spec_file`, `[bus].file`) are not blocked from
  overriding, but docs steer users to endpoint/auth overrides.

## 6. CI/CD

### Client: sync workflow (`templates/chowbea-sync.yml`, new)

- Triggers: `repository_dispatch` (`types: [chowbea-sync]`),
  `workflow_dispatch` (manual button), daily `schedule` (safety net for a
  missed dispatch).
- Steps: checkout default branch → setup Node (cache) → `npm ci` →
  `npx chowbea-axios sync --quiet` → `peter-evans/create-pull-request`
  on a fixed branch (`chowbea/sync`), title `chore(api): sync API types`,
  body includes the sync log (bus diff). No change → no PR.
- Hardening mirrors the existing template: least-privilege `permissions`
  (`contents: write`, `pull-requests: write`), concurrency group,
  `timeout-minutes`, secrets/vars for endpoint auth env vars.

### Client: PR check (pinned-mode variant of `templates/chowbea-axios-ci.yml`)

On every PR: `npm ci` → `npx chowbea-axios generate --quiet` → the
project's own typecheck/build. Fully offline — no endpoint, no secrets, no
staleness fetch. Staleness of `main` is the sync workflow's job, not the
PR gate's. (The existing endpoint-based staleness template remains for
non-pinned setups.)

### Backend: dispatch snippet (docs + template comment)

Appended to the backend's **deploy** workflow, firing only after deploy
succeeds — on push the stable endpoint still serves the old contract:

```yaml
- name: Notify client repos of new API contract
  env:
    GH_TOKEN: ${{ secrets.CHOWBEA_SYNC_TOKEN }}   # fine-grained PAT or GitHub App token
  run: |
    for repo in ${{ vars.CHOWBEA_CLIENT_REPOS }}; do
      gh api "repos/${repo}/dispatches" -f event_type=chowbea-sync
    done
```

Token needs `contents: write` on the client repos (the scope
`repository_dispatch` requires). Multiple clients = space-separated list in
a repo variable.

### The merge-order race, resolved

Frontend PR merges first → `main` stays pinned to old types, green.
Backend merges, deploys → dispatch → sync PR with the diff → its CI
typechecks the whole frontend against the new contract → review, merge.
A frontend PR that uses not-yet-deployed backend types cannot go green
until the sync PR lands — the system refusing to merge code against APIs
that don't exist yet is correct behavior, and the team workflow is:
backend merges/deploys first, sync PR lands, frontend rebases.

## 7. `init`, `doctor`, migration

- `init` gains a pinned-mode option (interactive question + `--pinned`
  flag for non-interactive use). When chosen it: writes `spec_file` and
  `[bus].file` into the scaffolded config, extends the gitignore step to
  add `_generated/` and `api.config.local.toml` (same idempotent
  `ensureGitignoreEntry` mechanism as `_internal/`), scaffolds
  `chowbea-sync.yml` + the pinned PR-check variant, and runs a first
  `sync` so the pinned files exist in the initial commit. If that first
  `sync` fails (endpoint unreachable), `init` warns and continues — the
  scaffold is complete and the user runs `sync` once the endpoint is up.
- `doctor` learns the pinned-mode expectation: `_generated/**` tracked in
  git is reported (and `--fix`-able) the same way tracked cache files are
  today.
- Migration for an existing repo (documented in README): add `spec_file` +
  `[bus].file` to config → run `sync` → `git rm -r --cached <output>/_generated`
  → add gitignore entries → install the sync workflow → replace the PR
  check with the pinned variant → done in one commit.

## 8. Edge cases & error handling

- **Endpoint down during sync:** retries, then loud failure; workflow run
  goes red; pinned files untouched; cron retries next day. Correct — pins
  are the last known good.
- **Hand-edited pinned manifest:** `parseManifest` hash integrity fails in
  `generate` and in every PR build. Hand-edited pinned spec has no
  integrity hash; review covers it (docs suggest CODEOWNERS on the two
  pinned files as optional hardening).
- **YAML spec endpoints:** `normalizeSpecBuffer` already canonicalizes to
  JSON, so the pinned spec is always JSON and byte-stable for identical
  content.
- **Nondeterministic backend serialization:** if a backend emits spec keys
  in unstable order across deploys, sync produces spurious diffs. Out of
  scope; documented as a backend-side fix.
- **Dispatch without contract change** (backend deployed non-API changes):
  sync runs, hashes match, nothing written, no PR. Cheap by design — this
  is why manifest determinism was a prerequisite.
- **`[bus].file` set, `[bus].endpoint` missing:** config validation error
  at load time, not a runtime surprise.

## 9. Testing

Follows the repo's existing patterns (vitest, real temp dirs, local HTTP
fixtures like `tests/bus-fetch.test.ts`):

- Config: overlay merge (field-level, nested tables, precedence), overlay
  ignored by sync, validation of the new `[bus].file` rules.
- Generate: bus-from-pinned-file emission; missing-file error; tampered
  manifest rejected; `_internal` cache not consulted when `file` set.
- Fetch: endpoint-beats-`spec_file` resolution change; pinned files never
  written by fetch (assert on a full fetch run against a fixture server).
- Sync: end-to-end against fixture endpoints — first sync writes both
  files; unchanged upstream writes nothing (byte-identical, exit 0);
  changed upstream writes + reports diff; validation failure writes
  nothing and exits non-zero; If-None-Match sent from pinned hash;
  local overlay present but ignored.
- Templates: YAML well-formedness snapshot (matching how existing template
  is covered, if at all — otherwise smoke-parse).

## 10. Deliverables & phasing

1. **Core** — config (`[bus].file`, overlay loading + merge, validation),
   `sync` action + headless command, `generate` bus-from-file, `fetch`
   resolution change. Tests throughout.
2. **Scaffolding** — `chowbea-sync.yml` template, pinned PR-check variant,
   `init --pinned`, gitignore additions, `doctor` check.
3. **Docs** — README "Team CI/CD (pinned inputs)" section: the model, the
   lockfile analogy, dev-loop examples (tunnel overlay), backend dispatch
   snippet, migration guide, CODEOWNERS suggestion.

Each phase lands independently; phase 1 is useful on its own (a team can
hand-roll the workflow before templates exist).

## 11. Decisions log

- **Model C over A/B:** gitignoring generated output is the only structural
  guarantee that local generations can't be committed; committed pins are
  what make backend changes reviewable PRs. (A: no pins → silent breakage,
  no PR flow. B: guarantee by CI tripwire only.)
- **`generate` prefers pins, `fetch` prefers endpoints** — deterministic,
  no freshness heuristics.
- **`sync` ignores the local overlay** — committed truth in, committed
  truth out.
- **`api.config.toml` stays committed** — it carries team structure; the
  overlay carries the per-dev part.
- **Pinned mode is opt-in via config keys, not a mode flag** — presence of
  `spec_file` / `[bus].file` is the switch; existing setups untouched.
- **Sync fails loud, fetch stays resilient** — a bot PR must never be built
  from a half-updated state; a dev loop should degrade gracefully.
- **Deferred:** `sync --check` staleness gate, machine-readable sync
  summary file for PR bodies, TUI screen for sync, blocking structural
  keys in the overlay.
