# Agent guide — pokerogue (fork)

Primary agent guide for this repo; see the workspace root `AGENTS.md` for the
authoring standard. There are no nested `AGENTS.md` files.

## What this is

A fork of [pagefaultgames/pokerogue](https://github.com/pagefaultgames/pokerogue)
(TypeScript + Phaser 3 roguelite) adding emulator-style **savestates** and a
**reward oracle**, self-hosted at https://pokerogue.antomarioni.com against the
**official** production API (relayed through nginx, see `deploy/`).

> **Fork note:** upstream is `pagefaultgames/pokerogue`; the working branch is
> **`savestate-main`**, based on upstream **`main`** (the branch the official
> prod server pairs with — NOT `beta`, whose newer save schema could corrupt
> real-account cloud saves). Keep the upstream diff minimal and rebase-friendly:
> prefer new files; keep edits to upstream files down to small hooks.

### Fork-only code (all new files)

- `src/system/savestate-manager.ts` + `src/phases/savestate-restore-phase.ts` —
  mid-wave savestates (auto per turn + reward roll, rewind/forward keys).
- `src/system/reward-oracle.ts` + `src/system/wanted-items.ts` — deterministic
  reward-roll simulation; cheapest reroll/lock path per wanted item.
- `src/ui/containers/savestate-overlay.ts`, `src/ui/containers/reward-oracle-overlay.ts`.
- `deploy/` (production Dockerfile + nginx relay), `.github/workflows/homelab-cicd.yml`.

### Upstream files carrying fork hooks (conflict candidates on rebase)

`select-modifier-phase.ts`, `turn-init-phase.ts`, `encounter-phase.ts`,
`summon-phase.ts`, `init-encounter-phase.ts`, `phase-manager.ts`,
`game-data.ts`, `settings.ts`, `settings-keyboard.ts`, `buttons.ts`,
`cfg-keyboard-qwerty.ts`, `ui-inputs.ts`, `ui.ts`, `menu-ui-handler.ts`,
`modifier-select-ui-handler.ts`, `title-ui-handler.ts`, `vite.env.d.ts`,
`vite.config.ts` (dev proxy).

## How to run things

```bash
pnpm install                 # node >= 24, pnpm via corepack
pnpm update-submodules       # assets/ + locales/ (required once)
pnpm start:prod              # dev server vs the real API (see vite proxy + .env.production.local)
pnpm start:dev               # offline dev (bypass login)
pnpm typecheck               # tsc
pnpm biome:all               # lint + format
npx vitest run test/tests/system   # fork feature suites (+ any touched area)
```

## Quality gate

`pnpm typecheck` + `pnpm biome:all` clean, and vitest green on
`test/tests/system` (savestate, savestate-speed, reward-oracle, reload) plus
the suites of any upstream area touched. Deploy rides CI (below); the title
screen shows `v<version> [<commit>]` to verify what's live.

## Upstream sync (the rebase playbook)

Trigger: the official site ships a new `main` release (our base version — shown
on the title screen — falls behind pokerogue.net's). Don't track `beta`.

```bash
git fetch upstream main
git rebase upstream/main savestate-main
# conflicts: expect only the hook files listed above; fork logic lives in new files
pnpm install && pnpm update-submodules       # lockfile/submodule pins may move
pnpm typecheck && pnpm biome:all && npx vitest run test/tests/system
git push --force-with-lease origin savestate-main   # CI builds + deploys
```

After a rebase, re-check the two riskiest integration points: the savestate
restore pipeline (`SavestateRestorePhase` vs `EncounterPhase`/`SummonPhase`
changes) and the oracle's cost model (`getRerollCost` constants) — the
prediction-vs-reality test fails loudly if generation internals changed.

## Conventions

- **Fork logic lives in new files; upstream edits are minimal guarded hooks**
  (the rebase-friendliness rule above — it is the repo's one non-negotiable).
- Follow upstream's own style: Biome-enforced formatting, `#`-prefixed path
  aliases (`#system/...`, `#ui/...`), phases registered in `phase-manager.ts`'s
  `PHASES` map, kebab-case filenames (ls-lint).
- Fork UI strings ship as runtime i18n fallback bundles
  (`registerSavestateI18nFallbacks`) — never edit the `locales/` submodule.
- Never land changes to the session save schema (see Ripple awareness).

## Where things live

Standard upstream layout (`src/phases`, `src/modifier`, `src/ui`, `src/system`,
`test/tests`); fork additions listed above. Game assets/locales are git
submodules (`assets/`, `locales/`).

## Making a change (walkthrough)

Canonical fork task: extend a fork feature (e.g. a new savestate action).
1. Put the logic in the fork's own modules (`src/system/savestate-manager.ts` etc.).
2. If an upstream hook is unavoidable, keep it to a guarded one-liner calling
   into fork code (see `TurnInitPhase.start` → `savestateManager.capture()`).
3. Add/extend a `test/tests/system/*` suite; run the quality gate.
4. Push to `savestate-main` — CI deploys automatically.

## Ripple awareness

- **`infra/homelab-manifests/apps/pokerogue/`** deploys this repo: CI
  (`.github/workflows/homelab-cicd.yml`) builds `ghcr.io/nantomarioni/pokerogue`
  from `deploy/Dockerfile` and bumps `values.yaml`'s `image.tag` there (GitOps
  contract; needs the `INFRA_REPO_TOKEN` repo secret). Container port/paths
  changes ripple to that chart.
- **Official API** (`api.pokerogue.net`): reached via the nginx `/rogueapi`
  relay which spoofs the `pokerogue.net` origin (`deploy/nginx.conf`; dev
  equivalent in `vite.config.ts`). Session save schema must stay compatible
  with upstream `main` — never land save-shape changes.

## When stuck

- Savestate semantics/invariants → doc comments in `src/system/savestate-manager.ts`.
- Oracle fidelity questions → `src/system/reward-oracle.ts` + the
  prediction-vs-reality test in `test/tests/system/reward-oracle.test.ts`.
- Deploy/serving → `deploy/nginx.conf`, the workflow, and the manifests chart.
- Upstream drift after rebase → run the fork suites first; they encode the
  load-bearing assumptions.
