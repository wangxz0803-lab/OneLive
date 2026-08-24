# Four-Video Double-Stage Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three-Avatar control room with an original-versus-localized video stage while preserving OneLive's deterministic six-step network demo.

**Architecture:** Extend the config model with prerecorded media metadata, keep all three network channels derived in the core, and render only the selected market in the control room. Reuse the selected media in Comparison, retain live source controls in a disclosure, and isolate new visual rules in a focused stylesheet loaded after the legacy CSS.

**Tech Stack:** React 19, TypeScript strict mode, Zustand, Framer Motion, Vite, Vitest, Playwright.

## Global Constraints

- Demo Safe Mode requires no phone, internet, API key, or external service.
- Director order remains Connect → Congestion → Latency → Edge → QoD → Business.
- Space / Backspace / R / F / E / Q / 1–4 / C / M remain available.
- Market IDs are `japan`, `latam`, and `india`; all market-specific values remain config-driven.
- Prerecorded media is never labeled LIVE; localized output shows `AI GENERATED · AUTHORIZED`.
- Edge reduces latency/path length and does not create bandwidth; QoD reallocates finite resources.
- 1440 × 900 desktop has no page scroll; interactive targets are at least 44 × 44 CSS px.
- No new runtime dependency.

---

### Task 1: Market and media contract

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/config/markets.ts`
- Modify: `src/config/scripts.ts`
- Create: `src/config/demoMedia.ts`
- Modify: `tests/markets.test.ts`
- Modify: `tests/network.test.ts`

**Interfaces:**

- Produces: `MarketId = 'japan' | 'latam' | 'india'`.
- Produces: `DEMO_MEDIA.original` and `DEMO_MEDIA.localized[marketId]` with `src`, `locale`, `label`, and `provenanceLabel`.

- [ ] Write tests expecting Japan/LATAM/India, localized media for every market, and India as the third constrained channel.
- [ ] Run `npm run test -- tests/markets.test.ts tests/network.test.ts` and verify failures mention the old market IDs or missing media contract.
- [ ] Implement the types, market configuration, electric-pot script, and demo media mapping.
- [ ] Run the same focused tests and verify they pass.

### Task 2: Selection and playback coordination

**Files:**

- Modify: `src/store/useOneLiveStore.ts`
- Modify: `tests/director.test.ts`

**Interfaces:**

- Produces: `selectedMarketId`, `activeRecording: 'original' | 'localized' | null`, `setSelectedMarket`, and `setActiveRecording`.
- Reset restores Japan and no active recording; Director steps retain the current market but stop prerecorded playback when the Business view opens.

- [ ] Write failing store tests for selection, single active recording, and reset behavior.
- [ ] Run `npm run test -- tests/director.test.ts` and verify the new assertions fail.
- [ ] Implement the minimal Zustand state/actions.
- [ ] Re-run the focused test and verify it passes.

### Task 3: Double-stage control room

**Files:**

- Create: `src/features/control-room/LocalizedStage.tsx`
- Modify: `src/features/control-room/MarketCard.tsx`
- Modify: `src/features/control-room/SourcePanel.tsx`
- Modify: `src/app/App.tsx`
- Modify: `tests/e2e/helpers.ts`
- Modify: `tests/e2e/mock-demo.spec.ts`

**Interfaces:**

- `SourcePanel` renders `/demo-media/original-zh.mp4` for Mock mode and pauses when localized playback becomes active.
- `LocalizedStage` renders three tabs and one `MarketCard` based on `selectedMarketId`.
- `MarketCard` renders the selected localized `<video>`, market caption, network status, telemetry, and required provenance.

- [ ] Update E2E tests to expect a source recording, three market tabs, one active localized card, tab switching, and a single active audio source.
- [ ] Run the targeted Playwright test with Edge and verify it fails against the old grid.
- [ ] Implement Source Tools disclosure, media playback coordination, tabs, and selected market stage.
- [ ] Run the targeted Playwright test and focused unit tests until green.

### Task 4: Comparison and business close

**Files:**

- Modify: `src/features/comparison/ComparisonView.tsx`
- Modify: `src/features/business/BusinessView.tsx`
- Modify: `src/core/director.ts`
- Modify: `tests/director.test.ts`
- Modify: `tests/e2e/mock-demo.spec.ts`

**Interfaces:**

- Comparison consumes the selected market and its `DEMO_MEDIA` asset; no `AvatarStage` or React Three Fiber Canvas is mounted.
- Business copy states one recording, three languages, three localized videos, and three markets.

- [ ] Add failing assertions for the corrected Edge narrative, selected media in Comparison, localized-video business copy, and zero runtime errors.
- [ ] Run focused tests and verify the old Avatar/copy behavior fails.
- [ ] Replace the Comparison Canvas stages with video stages and update the close copy.
- [ ] Re-run focused tests and verify they pass.

### Task 5: Visual system and responsive layout

**Files:**

- Create: `src/styles/four-video-demo.css`
- Modify: `src/main.tsx`
- Modify: `tests/e2e/visual.spec.ts`

**Interfaces:**

- The new stylesheet loads after `index.css` and owns `.double-stage`, `.localized-stage`, `.recording-stage`, market tabs, video state layers, and responsive overrides.

- [ ] Update visual tests for the selected market layout, 44px market tabs, 13px desktop content, and required viewport fit.
- [ ] Run the focused visual test and verify it fails on the old layout.
- [ ] Implement the double-stage visual rules and responsive breakpoints.
- [ ] Capture 1440 × 900, 1920 × 1080, and 390 × 844 screenshots; inspect and iterate on visible mismatches.

### Task 6: Demo assets, browser portability, and repository quality

**Files:**

- Create: `public/demo-media/original-zh.mp4`
- Create: `public/demo-media/japan-ja.mp4`
- Create: `public/demo-media/latam-es.mp4`
- Create: `public/demo-media/README.md`
- Modify: `playwright.config.ts`
- Modify: `mobile/src/webview/CaptureWebView.tsx`
- Modify: `README.md`

**Interfaces:**

- Playwright selects Edge on Windows when `PLAYWRIGHT_CHANNEL` is not set and accepts an explicit channel override.
- `CaptureWebView` declares the Metro HTML asset import without violating the lint rule.

- [ ] Add the three available source videos under stable names and document the missing India filename contract.
- [ ] Change the Playwright channel to a Windows-safe Edge default with environment override.
- [ ] Replace the lint-forbidden inline `require()` with a typed, line-scoped Metro asset import exception that documents why the runtime call is required.
- [ ] Update README demo-media and 2–3 minute runbook sections.
- [ ] Run `npm run lint`, `npm run build`, `npm run test`, and `npm run test:e2e`.
- [ ] Run `npm run demo:mock`, complete all six steps manually through Playwright, inspect the browser console, and refresh required artifacts.

## Self-Review

- Spec coverage: every acceptance criterion maps to Tasks 1–6; live source controls and provenance are explicitly retained.
- Placeholder scan: no implementation step relies on TBD/TODO behavior; the missing India asset has a defined, honest fallback and filename contract.
- Type consistency: `MarketId`, `selectedMarketId`, `DEMO_MEDIA.localized`, E2E `MARKET_IDS`, and network test keys all use `japan | latam | india`.
