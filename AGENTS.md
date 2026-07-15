# OneLive Contributor Guide

## Mission

OneLive 是一个比赛现场演示 MVP。任何改动首先保证：

1. 可启动。
2. Mock Demo 可完整走六步。
3. 网络差异、Edge 和 QoD 肉眼可见。
4. 1440 × 900 首屏完整。
5. 失败时能快速回退。
6. LIVE / EMULATED 不混淆。

不要为了增加功能破坏以上主链路。

## Project Structure

| Path | Purpose |
| --- | --- |
| src/config | 市场与演示台词配置 |
| src/core | 领域类型、网络模型、导演状态机 |
| src/providers | 真实/模拟能力接口和 fallback |
| src/realtime | Socket.IO / WebRTC 协议与客户端连接 |
| src/store | Zustand 应用状态 |
| src/components | 控制台、Avatar、网络路径和通用 UI |
| src/pages | Control Room、Broadcaster、Comparison、Business |
| server | Express、HTTPS、Socket.IO、会话与可选 AI 代理 |
| tests | 单元、集成和端到端测试 |
| docs | 产品、架构、决策和演示手册 |
| scripts | Windows、macOS/Linux 启动入口 |
| artifacts | 视觉 QA 截图与演示产物 |

部分目录只有在对应能力实现后出现。新增目录时保持职责单一。

## Commands

Install:

    npm install

Development:

    npm run dev

Production-style HTTPS demo:

    npm run demo

Offline-safe mock:

    npm run demo:mock

Quality:

    npm run build
    npm run lint
    npm run test
    npm run test:e2e

Formatting:

    npm run format

Cross-platform helpers:

    powershell -ExecutionPolicy Bypass -File .\scripts\start-demo.ps1 mock
    bash scripts/start-demo.sh mock

## Non-Negotiable Product Invariants

- Demo Safe Mode must not require phone, internet, API Key or external service.
- Director sequence remains Connect → Congestion → Latency → Edge → QoD → Business.
- Space / Backspace / R / F / E / Q / 1–4 / C / M remain available unless documentation and tests are updated together.
- Congested, Weak and High Latency produce visibly different outcomes.
- Edge reduces processing/path latency; it does not create bandwidth.
- QoD reallocates finite resources; it does not set every channel to perfect quality.
- Three market views remain config-driven.
- AI GENERATED / AUTHORIZED AVATAR and provenance labels remain visible.
- Camera and microphone are not recorded or persisted by default.

## LIVE / EMULATED Rules

Use LIVE only when the value came from an actual runtime source:

- getUserMedia track/device state
- current Socket.IO/WebRTC state
- successful RTCPeerConnection.getStats sample
- successful real Provider response
- browser TTS actually played on the current device

Use EMULATED for:

- NETWORK_PROFILES and manual overrides
- derived RTT/jitter/loss and channel quality
- Edge/Cloud processing profiles
- SimulatedNetworkCapabilityProvider
- DemoTranslationProvider
- SeededPoseProvider
- seeded viewers, virtual platform status and Experience score

Do not promote an entire screen to LIVE because one element is live. Mixed provenance is expected.

## Coding Conventions

- TypeScript strict mode stays enabled.
- Keep domain functions pure and testable.
- UI consumes derived models; do not reimplement network allocation inside components.
- Provider interfaces return provenance and fallbackReason where applicable.
- Store actions perform atomic mode changes.
- Keep MarketProfile as the source of market-specific values.
- Do not expose API Key, certificate private material or server stack traces to the client.
- Catch promise rejections at integration boundaries and show recoverable user states.
- Avoid new runtime dependencies unless they materially improve the P0/P1 experience.

## Realtime Rules

- Socket.IO carries signaling and small state messages, never video frames.
- WebRTC carries media.
- Validate session ID, role, message type and payload size on the server.
- Preserve epoch handling so stale offers/answers do not replace a newer negotiation.
- Stop MediaStream tracks on unmount, source switch and session end.
- Reconnect with bounded backoff; the UI must always provide Mock Source.
- sender constraints are best effort. A browser rejecting setParameters must not crash the Demo.
- Only label getStats-derived metrics LIVE after a successful sample.

## Provider Rules

Every real Provider must have:

- an explicit availability check
- a short timeout
- a tested fallback
- provenance in its result
- a user-safe error message

Real AI requests run through the server. Never place AI_API_KEY in Vite-exposed variables or client code.

## Visual System

Core tokens:

- Background near #05070B
- Graphite surfaces around #0C121A / #111925
- Primary realtime cyan around #54DCE7
- Edge violet around #927BFF
- Market amber around #E7B66A
- Red/orange only for degradation and warnings

Rules:

- Do not use generic white dashboard layouts.
- Do not use emoji as structural icons.
- Do not create pill-heavy status rows.
- Keep avatar/stage imagery dominant over metrics.
- Normal text contrast is at least 4.5:1.
- State changes include text/icon/shape, not color alone.
- Desktop body text should normally be 13px or larger; mobile controls/body 16px or larger.
- Interactive targets are at least 44 × 44 CSS px.
- Focus rings remain visible.

### Desktop Layout

At 1440 × 900:

- No vertical page scroll.
- Header, main stage and data path fit in the first frame.
- Source column and three market cards never overlap.
- Network drawer overlays intentionally and has a clear close action.

### Broadcaster Layout

At 390 × 844:

- Dedicated broadcaster UI, not a compressed desktop dashboard.
- Camera preview remains the primary area.
- Safe-area insets are respected.
- Start/stop is the only primary action.
- No horizontal overflow.

### Motion

- Micro-interactions: roughly 150–300ms.
- Mode transitions: no more than about 400ms.
- Recovery scan: one pass, not an infinite decoration.
- Animate transform/opacity where possible.
- Continuous animation is limited to meaningful data pulse and avatar idle motion.
- prefers-reduced-motion must preserve readable static states.

## Testing Requirements

At minimum, unit tests cover:

- NETWORK_PROFILES
- Edge / Cloud latency difference
- QoD resource allocation
- channel degradation policy
- Demo Director boundaries and steps
- Provider fallback/provenance
- MarketProfile shape
- SessionRegistry/signaling validation where implemented

Playwright should cover:

1. Mock Demo opens.
2. Three markets render.
3. Congested creates a degraded channel.
4. High Latency creates A/V warning.
5. Edge improves delay.
6. QoD changes allocation and recovers the core channel.
7. Comparison opens.
8. Business view opens.
9. Shortcuts work.
10. 1440 × 900 and 390 × 844 have no horizontal overflow.
11. Primary controls have accessible names.

Never state that tests pass without running the exact command in the current worktree.

## Visual QA

Required reference sizes:

- 1440 × 900
- 1920 × 1080
- 390 × 844

Expected artifacts:

- artifacts/control-room.png
- artifacts/network-degraded.png
- artifacts/edge-qod-recovered.png
- artifacts/mobile-broadcaster.png

Inspect:

- clipping and overlap
- contrast and focus
- WebGL load and dropped frames
- state change within one second
- console errors
- reduced-motion
- mobile safe areas

## Safe Change Checklist

Before editing:

- Read docs/DECISIONS.md.
- Identify whether the change affects the six-step demo.
- Inspect existing uncommitted work; do not overwrite unrelated user changes.

Before handoff:

- Run build, lint, unit tests and relevant e2e tests.
- Start demo:mock and manually complete the affected steps.
- Check browser console.
- Update docs when commands, provenance or fallbacks change.
- Record known limitations rather than hiding them.

## Out of Scope

Do not add without an explicit scope change:

- database
- accounts or multi-tenant authorization
- payment
- real streaming-platform publishing
- production QoD/MEC claims
- face replacement or voice cloning
- background recording
- fabricated revenue/ROI metrics

## Recovery Priority

When time or reliability is constrained:

1. Restore Mock Demo.
2. Restore three market channels.
3. Restore network/Edge/QoD differences.
4. Restore Director and shortcuts.
5. Restore mobile/live source.
6. Only then improve advanced Avatar or AI features.
