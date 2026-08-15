---
name: chowbea
description: Use when working in a project that consumes or serves chowbea (formerly chowbea-axios) — generating a typed API client from an OpenAPI spec, sharing TypeScript types across repos via the Type Bus, editing api.config.toml, resolving conflicts in generated files, or wiring the bus endpoint into a backend.
---

# chowbea

CLI that turns an OpenAPI spec into a fully-typed axios client, **and** syncs arbitrary TypeScript types between an API repo and its frontends (the "Type Bus"). Also ships a TUI, Vite codegen plugins, and git tooling for generated files.

**Command name:** use `chowbea-axios <cmd>` — it works in every version (2.x and 3.x, where it stays as an alias). From 3.0 the shorter `chowbea <cmd>` is also available. The package on npm is `chowbea-axios` (≤2.x) / `chowbea` (3.0+); imports follow the installed package name.

## The two halves

| | Source of truth | Command | Output |
|---|---|---|---|
| **API client** | OpenAPI spec (URL or file) | `fetch` / `generate` | `_generated/api.{types,operations,contracts}.ts` + editable client files |
| **Type Bus** | TypeScript types in the API repo | `extract` (backend) → `fetch` (frontend) | `_generated/bus/*.ts` |

## Commands

`init` · `fetch` · `generate` · `watch` · `status` · `validate` · `diff` · `resolve` · `doctor` · `plugins` · `extract`

Run `chowbea-axios <command> --help` for flags. Most-used:

```bash
chowbea-axios init          # interactive setup — writes api.config.toml + base files
chowbea-axios fetch         # pull spec (and bus manifest) from the endpoint, regenerate
chowbea-axios generate      # regenerate from the cached/local spec (offline)
chowbea-axios watch         # re-fetch + regenerate on change
chowbea-axios status        # config, cache state, generated-file freshness
chowbea-axios resolve       # fix merge conflicts in generated files by regenerating
chowbea-axios doctor        # diagnose setup problems
```

## Configuration — `api.config.toml`

Lives at the project root. Never rename it; the CLI and every command key off it.

```toml
[output]
folder = "src/api"                  # where generated + editable files land

[fetch]
endpoint = "https://staging.example.com/openapi.json"
headers = { "X-Env" = "$STAGING_KEY" }   # $VAR / ${VAR} interpolation

[fetch.auth]                        # optional HTTP Basic for private specs
type = "basic"
username = "$SWAGGER_USER"
password = "$SWAGGER_PASS"

[instance]                          # shapes the GENERATED axios client
auth_mode = "bearer-localstorage"   # or "custom" | "none"
token_key = "auth-token"
with_credentials = false
timeout = 30000
base_url_env = "API_BASE_URL"
env_accessor = "process.env"        # or "import.meta.env" for Vite

[bus]                               # optional; absent = Type Bus fully inert
endpoint = "https://staging.example.com/.well-known/chowbea.json"
```

`[fetch.auth]` and `[fetch.headers]` apply to bus requests too.

## Generated layout — what you may and may not edit

```
src/api/
├── _internal/          # caches — never edit, never commit-conflict-resolve by hand
│   ├── openapi.json
│   ├── .api-cache.json
│   └── chowbea.bus.json
├── _generated/         # ALWAYS OVERWRITTEN — never edit
│   ├── api.types.ts        api.operations.ts      api.contracts.ts
│   └── bus/                # one file per backend barrel + index.ts
├── api.client.ts       # editable, generated once
├── api.instance.ts     # editable, generated once
├── api.error.ts        # editable, generated once
└── api.helpers.ts      # editable, generated once
```

**Rule:** anything under `_generated/` or `_internal/` is a projection of the spec — edit the spec or the backend types instead. The four root files are yours to modify; they are only created once.

**Merge conflicts in generated files:** don't hand-resolve. Run `chowbea-axios resolve` — it regenerates conflicted files under the generated dir from the spec and stages them.

## Using the generated client

```ts
import { api } from "./src/api/api.client";

const { data, error } = await api.op.getUserById({ id: "123" });
if (error) return console.error(error.message);
data.name; // fully typed
```

Result-based, not try/catch. Operations are named by `operationId`.

**Enums arrive as runtime values, not just types.** A named string enum (or an inline enum property on a DTO/body) emits a `const` object alongside its union, so you can iterate/reference values:

```ts
import { Action, AuthMeRuleDtoAction } from "./src/api/_generated/api.contracts";
Object.values(Action);          // real array at runtime
AuthMeRuleDtoAction.SCHOOL_STAFF; // "school-staff"
```
Keys are value-derived SCREAMING_SNAKE. Don't hand-write mirrors of backend enums — regenerate instead.

## Type Bus — sharing types the OpenAPI spec can't express

Use for `Map`-typed definitions, generics, unions, domain vocabulary — anything you'd otherwise re-model as a DTO just to reach the frontend.

### Backend: mark types

Two channels:

```ts
// 1. src/exams/grade.chowbea.ts — every exported type in a *.chowbea.ts file rides the bus
export type { Grade, StudentId } from "./models";
export type GradeMap = Map<StudentId, Grade>;
```
```ts
// 2. any file — tag a single declaration
/** @chowbea-export */
export interface Plan { name: string; seats: number }
```

**Rules (all are extraction-time errors with `file:line`):**
- **Types only** — `type`, `interface`, `enum`. Classes, consts, and functions are rejected (runtime values don't belong on a type bus; share logic via a real package instead).
- **Closed world** — a bus type may reference primitives, TS built-ins (`Map`, `Record`, generics, mapped/conditional/template-literal types), and *other bus types*. Referencing a non-bus project type errors and tells you to add it; `node_modules` types are rejected.
- **No duplicate names** anywhere on the bus.

### Backend: generate and serve

```bash
chowbea-axios extract              # → chowbea.bus.json at the project root
chowbea-axios extract --check      # CI gate: validate only, non-zero exit on violations
chowbea-axios extract --watch      # dev loop: re-extract on save
chowbea-axios extract --check --diff "$STAGING_BUS_URL" --fail-on-removed   # breaking-change tripwire
```

Wire extraction into the build so the manifest ships with every deploy:
```jsonc
{ "scripts": { "prebuild": "chowbea-axios extract", "build": "nest build" } }
```

Serve it (framework-agnostic handler):
```ts
import { busHandler, DEFAULT_API_ROUTE } from "chowbea-axios/api"; // "chowbea/api" on 3.x
app.use(DEFAULT_API_ROUTE, busHandler());   // file mode: re-reads when the manifest changes
```
`busHandler()` (no arg, **2.7.0+**) stats the file per request and re-reads only on change — pairs with `extract --watch` so a fresh extract is served with **no server restart**. `busHandler(readBusManifest())` is the static/pre-loaded variant (boot-time snapshot; requires a restart to pick up changes).

### Frontend: consume

Add `[bus].endpoint`, then `chowbea-axios fetch` — types land in `_generated/bus/` and are importable:
```ts
import type { GradeMap, Plan } from "./src/api/_generated/bus";
```
A rename or removal upstream breaks call sites at compile time after the next fetch.

## Gotchas that actually bite

1. **ESM vs CommonJS on the backend surface.** `chowbea-axios/api` is ESM-only in ≤2.5. From **2.6.0** it also supports `require()`, so a static import works in a default (CommonJS) NestJS project. On ≤2.5, use `const { busHandler } = await import("chowbea-axios/api")` inside an async bootstrap instead.
2. **`readBusManifest()` reads from `process.cwd()`.** If the manifest isn't there you get ENOENT — run `extract` first, and add it to the build.
3. **Bus fetch is inert without `[bus]`.** No config block means no bus work at all; nothing silently half-runs.
4. **`extract` needs the real `tsconfig.json`** — it builds a TS program. Use `--project` if it isn't the nearest one.
5. **Manifest version gate:** a frontend meeting an unknown `chowbeaBus` version fails loud telling you to upgrade — bump the CLI rather than hand-editing the manifest.
6. **Don't commit `chowbea.bus.json`** — it's a build output, regenerated from source on every build.
7. **Global vs project install:** the CLI is local-first — a global install delegates to the project's pinned copy when one exists, so the project version wins. `status` shows which is running.

## CI

The `init` wizard scaffolds `.github/workflows/chowbea-axios-ci.yml`: re-fetches the spec on every PR and fails when generated output is stale. For the Type Bus, add to the **API repo's** CI:

```yaml
- run: npx chowbea-axios extract --check
- run: npx chowbea-axios extract --check --diff "$STAGING_BUS_URL" --fail-on-removed
```
