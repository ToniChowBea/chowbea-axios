<p align="center">
  <img src="https://axios.chowbea.com/images/chowbea-axios.png" alt="chowbea" width="100%" />
</p>

<h1 align="center">Chowbea</h1>

<p align="center">
  Turn your OpenAPI spec into a fully-typed client, with a cross-repo Type Bus and an interactive TUI. One command.
</p>

<p align="center">
  <a href="https://axios.chowbea.com">
    <img src="https://img.shields.io/badge/📚_Read_the_Docs-axios.chowbea.com-10b981?style=for-the-badge" alt="Documentation" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/ToniChowBea/chowbea/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/ToniChowBea/chowbea/ci.yml?branch=main&style=flat-square&color=10b981" alt="CI" /></a>
  <a href="https://github.com/ToniChowBea/chowbea/stargazers"><img src="https://img.shields.io/github/stars/ToniChowBea/chowbea?style=flat-square&color=10b981" alt="GitHub stars" /></a>
  <a href="https://www.npmjs.com/package/chowbea"><img src="https://img.shields.io/npm/v/chowbea?style=flat-square&color=10b981" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/chowbea"><img src="https://img.shields.io/npm/dm/chowbea?style=flat-square&color=10b981" alt="npm downloads" /></a>
  <a href="https://github.com/ToniChowBea/chowbea/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-10b981?style=flat-square" alt="license" /></a>
</p>

---

> **Renamed from `chowbea-axios`.** Install `chowbea` (`npm install chowbea`). The old package name still works via a compatibility shim, and the `chowbea-axios` command is still provided, so existing setups keep running.
>
> - If you have the old CLI installed globally, run `npm rm -g chowbea-axios` before `npm i -g chowbea` — npm>=7 refuses to overwrite another package's global bin (`EEXIST`) since the two are different package names.
> - Generated-file header comments changed with the rename. The first `fetch`/`generate`/CI run after upgrading may report your generated client as out of date — regenerate once (`npx chowbea generate`) and commit the result.

## Quick Start

```bash
# Initialize and configure (interactive)
npx chowbea init

# Fetch spec and generate client
npx chowbea fetch
```

Or with your preferred package manager:

```bash
pnpm dlx chowbea init
yarn dlx chowbea init
bunx chowbea init
```

Then import and use:

```typescript
import { api } from "./src/api/api.client";

const { data, error } = await api.op.getUserById({ id: "123" });

if (error) return console.error(error.message);

console.log(data.name); // ✨ Fully typed
```

## Why chowbea?

- **Zero manual types** — Generated directly from your OpenAPI spec
- **Full autocomplete** — Every endpoint, parameter, and response
- **Result-based errors** — `{ data, error }` instead of try/catch
- **Watch mode** — Auto-regenerate when your spec changes
- **YAML or JSON** — Both spec formats accepted at every entry point
- **Interactive TUI** — Run `chowbea` (no args) for the dashboard
- **CI-friendly** — `--non-interactive` mode plus a hardened workflow template

## What Gets Generated

The default output folder is `src/api/`. Override it via `output.folder` in `api.config.toml`.

```
src/api/
├── _internal/
│   ├── openapi.json         # Cached spec (always JSON)
│   └── .api-cache.json      # Cache metadata (hash, timestamp)
├── _generated/              # Always overwritten — do not edit
│   ├── api.types.ts         # OpenAPI-typed paths/components/operations
│   ├── api.operations.ts    # Typed apiClient.op.<id>(...) methods
│   ├── api.contracts.ts     # Concrete interfaces (cmd+click navigation)
│   └── bus/                 # Type Bus types synced from [bus].endpoint (optional)
│       ├── <barrel>.ts      # One file per barrel, e.g. exams.grade.ts
│       └── index.ts         # Re-exports every barrel
├── api.client.ts            # Typed HTTP client (editable, generated once)
├── api.instance.ts          # Axios instance + auth interceptor (editable, generated once)
├── api.error.ts             # Result-based error handling (editable, generated once)
└── api.helpers.ts           # Path-based type helpers (editable, generated once)
```

## Commands

| Command | Description |
| ------- | ----------- |
| `init` | Interactive setup — creates config and base files |
| `fetch` | Fetch spec from endpoint (or local file) and generate types |
| `generate` | Generate from cached/local spec |
| `watch` | Watch for spec changes and auto-regenerate (with backoff on failures) |
| `status` | Show current config, cache, and generated-file status |
| `validate` | Validate your OpenAPI spec — 7 categories, severity-classified |
| `diff` | Compare cached vs new spec; flags schema/parameter/response changes |
| `plugins` | Manage Vite codegen plugins (Surfaces, Side Panels) |
| `extract` | Extract Type Bus types into chowbea.bus.json (run in the API repo) |

Run `chowbea <command> --help` for command-specific flags.

## Interactive Dashboard

> **Status: experimental.** The TUI is functional but has no automated test coverage today. For CI pipelines, scripted workflows, and any production-adjacent use, prefer the headless commands (`fetch`, `generate`, `watch`, etc.). The dashboard is great for interactive exploration but the headless surface is what we guarantee.

Running `chowbea` with **no command** launches an OpenTUI dashboard with screens for fetch, generate, diff, validate, watch, plugins, env management, and an endpoint inspector. Tabs survive screen navigation, and processes (e.g. `npm run dev`) can be run alongside in the process tab.

The dashboard requires [Bun](https://bun.sh). When invoked under Node, the CLI re-launches itself under Bun automatically. If Bun isn't installed, the CLI falls back to headless mode and prints a hint.

## Authentication

Configure how the **generated client** attaches auth tokens via the `[instance]` block in `api.config.toml`:

```toml
[instance]
auth_mode = "bearer-localstorage"   # SPA pattern — reads from localStorage
# auth_mode = "custom"              # TODO interceptor — implement your own
# auth_mode = "none"                # No interceptor
token_key = "auth-token"            # localStorage key (bearer-localstorage only)
with_credentials = false            # Send cookies cross-origin (default: false)
timeout = 30000
base_url_env = "API_BASE_URL"       # Env var holding the base URL
env_accessor = "process.env"        # or "import.meta.env" for Vite
```

For **fetching the spec itself** with HTTP Basic Auth (e.g. private staging endpoints), add a `[fetch.auth]` block:

```toml
[fetch.auth]
type = "basic"
username = "$SWAGGER_USER"          # $VAR or ${VAR} env interpolation
password = "$SWAGGER_PASS"
```

When the env vars aren't set, the CLI prompts interactively. In CI, set them in the environment.

## CI Integration

The `init` wizard offers to scaffold `.github/workflows/chowbea-axios-ci.yml` — a hardened workflow that re-fetches your spec on every PR and fails when the generated client is out of date. The template includes:

- `permissions: contents: read` (default-deny)
- `concurrency` cancel-in-progress
- Node 22 + npm cache (works for every package manager — see comments for bun/pnpm/yarn variants)
- `vars` or `secrets` fallback for `STAGING_API_ENDPOINT`

For non-interactive bootstrapping (e.g. project starters):

```bash
chowbea init --non-interactive \
  --endpoint https://staging.example.com/openapi.json \
  --output-folder src/api \
  --package-manager npm
```

## Vite Plugins (optional)

`chowbea/vite` exposes two codegen plugins for Vite projects:

- `surfacesCodegen()` — auto-discovers `*.surface.tsx` files and generates a typed barrel
- `sidepanelsCodegen()` — same for `*.panel.tsx` files

Scaffold them via `chowbea init --with-vite-plugins` or `chowbea plugins --setup`. See [docs](https://axios.chowbea.com) for the full registry pattern.

## Type Bus (optional)

Serves types from an API repo to frontend consumers as a versioned JSON manifest — no manual copy-pasting.

**Mark exports (API repo):** put types in a `*.chowbea.ts` barrel, or tag any exported `type`/`interface`/`enum` with `/** @chowbea-export */`.

```bash
npx chowbea extract   # writes chowbea.bus.json
```

```typescript
import { busHandler, DEFAULT_API_ROUTE } from "chowbea/api";
// re-reads chowbea.bus.json when it changes — pairs with `extract --watch` in dev, one stat per request in prod
app.use(DEFAULT_API_ROUTE, busHandler());
```

`busHandler()` takes an optional path (defaults to `chowbea.bus.json` in `process.cwd()`), stats it on every request, and only re-reads and re-parses when the mtime or size changed — so a fresh `extract` shows up without a server restart. For a static, pre-loaded manifest (no filesystem access per request), pass a manifest directly: `busHandler(readBusManifest())`.

`chowbea/api` ships both ESM and CommonJS builds, so this works unmodified from ESM and CommonJS (default NestJS) backends alike.

**Consume (frontend repo)** — add to `api.config.toml`:

```toml
[bus]
endpoint = "https://your-api.com/.well-known/chowbea.json"
```

`fetch`/`watch` sync the bus alongside the spec: cache to `_internal/chowbea.bus.json`, emit `_generated/bus/`. `[fetch.auth]` and `[fetch.headers]` both apply to bus requests too.

**CI:** API repo runs `extract --check` (invalid exports fail the build) and `extract --check --diff <baseline> --fail-on-removed` (blocks breaking removals). Frontend repo needs no extra step — the staleness check above already covers `_generated/bus/**`.

## Compatibility

| | |
|---|---|
| **Node** | `>=20` (declared in `engines`; tested in CI on 20 / 22 / 24 across Linux, macOS, Windows) |
| **Module format** | **ESM only.** `package.json` declares `"type": "module"`. Importing from a CommonJS file with `require("chowbea")` will fail with `ERR_REQUIRE_ESM`. CJS consumers should either use a dynamic `import()` or migrate the importing file to ESM. The `chowbea` CLI binary is unaffected — it works regardless of your project's module format. |
| **Vite** | Optional peer dep, `>=5.0.0`. Only required if you use the `chowbea/vite` codegen plugins. |
| **Bun** | Required to launch the interactive TUI (the headless CLI works under Node alone). |

---

<p align="center">
  <a href="https://axios.chowbea.com">
    <strong>→ View full documentation</strong>
  </a>
</p>

## ⭐ Support

If chowbea helps you ship faster, consider giving it a star! It helps others discover the project and motivates continued development.

<p align="center">
  <a href="https://github.com/ToniChowBea/chowbea">
    <img src="https://img.shields.io/badge/⭐_Star_on_GitHub-ToniChowBea%2Fchowbea-10b981?style=for-the-badge&logo=github" alt="Star on GitHub" />
  </a>
</p>

## Changelog

Release history and per-version changes live in [CHANGELOG.md](CHANGELOG.md).

## Security

Found a security issue? Please follow our [responsible disclosure policy](SECURITY.md) — do **not** file a public GitHub issue.

## License

MIT
