# Obsidian community plugin

## Project overview

- Target: Obsidian Community Plugin (TypeScript -> bundled JavaScript).
- Entrypoint: `src/main.ts` compiled to `main.js` and loaded by Obsidian.
- Required release artifacts: `main.js`, `manifest.json`, and optional `styles.css`.

## Canonical architecture documentation

- `README.md` is the source of truth for repository architecture and layout.
- For structure, dependency direction, and execution flow, refer to `README.md` -> `Architecture`.
- Do not duplicate architecture maps or execution flow in this file.
- If architecture changes in code, update `README.md` in the same change set.
- If `AGENTS.md` and `README.md` diverge, align `AGENTS.md` to `README.md` and keep `README.md` authoritative.

## Environment and tooling

- Node.js: current LTS (Node 18+ recommended).
- Package manager: `npm`.
- Bundler: `esbuild` (`esbuild.config.mjs`).
- Types: `obsidian` type definitions.

### Install

```bash
npm install
```

### Dev (watch)

```bash
npm run dev
```

### Production build

```bash
npm run build
```

### Lint

```bash
npm run lint
```

### Tests

```bash
npm run test
npm run test:unit
npm run test:integration
```

## File and module conventions

- Keep `src/main.ts` focused on plugin lifecycle and composition/wiring.
- Split large files into focused modules with clear responsibilities.
- Keep dependencies small and browser-compatible when possible.
- Do not commit generated artifacts (`node_modules/`, `main.js`, other build output).
- Use stable command IDs and persisted settings keys unless migration is included.

## Testing policy

- Add high-value tests, not volume for its own sake.
- `tests/unit/`: pure logic and parsing/normalization/cache primitives.
- `tests/integration/`: cross-module behavior and service orchestration.
- Prefer deterministic assertions over broad snapshot testing.
- When behavior changes, add/update tests at the smallest layer that gives confidence.
- Before handoff, run validation commands in this order unless the user explicitly says otherwise:
  1) `npm run test`
  2) `npm run lint`
  3) `npm run build`
- Do not hand off as complete if any required validation command fails, unless the user explicitly accepts the failure.
- If any required validation command is skipped, state exactly which command was skipped and why in the final handoff.
- If behavior changes and no test was added/updated, explicitly justify why in the final handoff.

## Documentation synchronization

- Any structural change (boundaries/responsibilities/runtime flow) must include `README.md` updates.
- Any change to test strategy, test tiers, or validation commands must update `README.md` in the same change set.
- Handoffs must call out doc updates or explicitly note if docs were intentionally deferred.

## Manifest rules (`manifest.json`)

- Must include (non-exhaustive):
  - `id` (plugin ID; for local dev it should match the folder name)
  - `name`
  - `version` (Semantic Versioning `x.y.z`)
  - `minAppVersion`
  - `description`
  - `isDesktopOnly` (boolean)
  - Optional: `author`, `authorUrl`, `fundingUrl` (string or map)
- Never change `id` after release. Treat it as stable API.
- Keep `minAppVersion` accurate when using newer APIs.
- Canonical requirements: https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml

## Commands and settings

- Add user-facing commands via `this.addCommand(...)` with stable IDs.
- Provide sensible defaults and validation in settings.
- Persist settings via `this.loadData()` / `this.saveData()`.
- Use `this.register*` helpers for listeners and intervals so unload is safe.

## Versioning and releases

- Bump `version` in `manifest.json` (SemVer) and update `versions.json`.
- Release tag must exactly match `manifest.json` version (no leading `v`).
- Attach `manifest.json`, `main.js`, and `styles.css` (if present) as release assets.

## Security, privacy, and compliance

Follow Obsidian Developer Policies and Plugin Guidelines:

- Default to local/offline behavior.
- No hidden telemetry. Any external analytics/service use requires explicit opt-in and clear docs.
- Never execute remote code or auto-update plugin code outside normal release flow.
- Minimize scope; do not access files outside the vault.
- Clearly disclose external services, data sent, and user impact.

## UX and copy guidance

- Prefer sentence case for in-app labels and headings.
- Use clear, action-oriented copy.
- Use Obsidian navigation style like **Settings -> Community plugins**.
- Keep user-facing text concise and consistent.

## Performance

- Keep startup light; defer heavy work until needed.
- Avoid long-running tasks during `onload`.
- Batch disk access and avoid unnecessary vault scans.
- Debounce/throttle expensive filesystem-triggered work.

## Agent expectations

**Do**
- Follow architecture boundaries defined in `README.md`.
- Keep `main.ts` as wiring/composition, not feature-heavy logic.
- Run required validation commands before handoff and report results.
- Keep README architecture/testing docs in sync with code changes.

**Don't**
- Re-introduce mixed-responsibility large files.
- Add network calls without explicit user-facing need and documentation.
- Ship cloud-dependent behavior without clear disclosure and opt-in.
- Leave architecture/testing docs stale after refactors.

## Validation checklist (before handoff)

```bash
npm run test
npm run lint
npm run build
```

## Handoff reporting

- Include a short validation summary in every final handoff with pass/fail for:
  - `npm run test`
  - `npm run lint`
  - `npm run build`
- If any command was skipped or failed, include the reason and current status.

## Troubleshooting

- Plugin doesn't load: ensure `main.js` and `manifest.json` are in `<Vault>/.obsidian/plugins/<plugin-id>/`.
- Build issues: run `npm run build` and fix TypeScript/esbuild errors.
- Commands not appearing: verify command registration runs in `onload` and IDs are unique.
- Settings not persisting: ensure `loadData`/`saveData` are awaited and UI updates on change.

## References

- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- API documentation: https://docs.obsidian.md
- Developer policies: https://docs.obsidian.md/Developer+policies
- Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Style guide: https://help.obsidian.md/style-guide
