# OneLive Four-Video Double-Stage Demo Design

## Goal

Turn the existing network/avatar control room into a reliable 2–3 minute competition demo built around four prerecorded clips: one original Chinese source and Japan, LATAM, and India localized versions.

## Product Story

The first act proves content localization: one original recording becomes three market-specific videos. The second act proves delivery quality: the selected localized market visibly degrades under congestion/latency and improves with Edge/QoD. Comparison and Business close the story.

## Information Architecture

- Keep the existing top system rail, six-step Director, Network Drawer, Comparison, Business, Broadcaster, shortcuts, and network model.
- Replace the three equal Avatar cards with a two-column stage.
- Left: original Chinese recording, always identified as `ORIGINAL RECORDING`.
- Right: one active localized recording with Japan, LATAM, and India tabs.
- Only the active market video renders in the right stage. Clicking a market selects it and starts that clip.
- Only one prerecorded clip may produce audio at a time. Starting one pauses the other.
- Phone, local camera, Mock fallback, TTS preview, and script controls remain available inside a secondary Source Tools disclosure.

## Media Contract

Files live under `public/demo-media/`:

| Asset            | Path                          | Required behavior         |
| ---------------- | ----------------------------- | ------------------------- |
| Original Chinese | `/demo-media/original-zh.mp4` | Primary left-stage asset  |
| Japan            | `/demo-media/japan-ja.mp4`    | Japanese localized output |
| LATAM            | `/demo-media/latam-es.mp4`    | Spanish localized output  |
| India            | `/demo-media/india-en.mp4`    | English localized output  |

Missing localized media falls back to the original recording with an explicit `LOCALIZED ASSET PENDING · ORIGINAL FALLBACK` message. It must never be marked LIVE.

## Provenance

- Prerecorded original: `ORIGINAL RECORDING · LOCAL ASSET`.
- Prerecorded localized output: `AI GENERATED · AUTHORIZED`.
- Missing localized asset fallback: `ORIGINAL FALLBACK · EMULATED`.
- Real phone/camera remains `LIVE` only after current runtime checks succeed.
- Network, Edge, QoD, derived telemetry, viewers, and platform state remain `EMULATED`.

## Market Configuration

Market IDs become `japan`, `latam`, and `india`. Japan remains priority one for the narrated demo, LATAM priority two, and India priority three. All labels, scripts, video paths, locale, visual theme, platform copy, and target/minimum bandwidth remain config-driven.

## Network Behavior

- The network engine still computes all three channels.
- The selected market card shows its own computed channel state.
- Congestion shows low resolution/buffering with an obvious status layer.
- High latency preserves visual quality but shows A/V drift warning.
- Edge shortens processing/path latency; its narrative says “improves responsiveness” rather than claiming bandwidth recovery.
- QoD recovers the three channels according to the existing finite-budget policy.

## Comparison

Comparison uses the selected localized video on both sides instead of mounting React Three Fiber canvases. The left is visually degraded Cloud + Best Effort; the right is Edge + QoD. This removes the current Canvas connection race and makes the comparison relevant to the actual demo media.

## Visual Direction

- Preserve the near-black graphite shell and cyan/violet/amber accents.
- Make the two 9:16 videos the dominant objects.
- Use a restrained broadcast editorial hierarchy: 13px minimum desktop body/telemetry, 16px mobile body/controls, strong stage titles, fewer permanent borders.
- Market tabs are large 44px targets and use text, shape, and color for state.
- At 1440 × 900, header, double stage, network path, and Director fit without page scroll.

## Demo Timing

1. 0:00–0:20 — play the original Chinese clip.
2. 0:20–1:10 — click Japan, LATAM, India and play each localized clip.
3. 1:10–2:15 — select Japan and run Connect → Congestion → Latency → Edge → QoD.
4. 2:15–2:40 — open Comparison, then Business.

## Failure and Recovery

- Video load errors are user-safe and keep the stage usable.
- Missing India media does not crash the app or fabricate a localized asset.
- Mock Demo remains fully operable offline.
- Existing live source fallbacks and QR flow remain intact.
- Reduced motion preserves readable static state.

## Acceptance Criteria

- Japan/LATAM/India tabs work by click and keyboard.
- Only the selected localized stage is visible and only one prerecorded clip emits audio.
- Network states remain visibly different and all six Director steps remain available.
- Comparison produces no runtime errors.
- Business copy describes one source and three localized video experiences.
- Required provenance remains visible.
- 1440 × 900, 1920 × 1080, and 390 × 844 have no horizontal overflow; desktop has no vertical page scroll.
- Build, lint, unit tests, and Edge-based Playwright tests pass.
