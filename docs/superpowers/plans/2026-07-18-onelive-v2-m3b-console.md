# OneLive V2 — M3b 控制台 UI + 工程收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec §4.2 重做控制台（三频道预览 + 双端真实网络 HUD + casting 控制 + 字幕/翻译事件流 + 推流状态 + Edge⇄Local 占位），并完成工程收敛（app.py 拆模块、M3a 合并后清理项）。控制台是评委看到的第一屏——UI 质量用 frontend-design skill 保障。

**Architecture:** ① app.py（~700 行）拆为 `service/wire.py`（event_to_wire+协议辅助）、`service/endpoints_stream.py`（/stream.*）、`service/endpoints_translate.py`（/audio /events /speech + tee）、`service/console_api.py`（uplink stats 存取），app.py 保留 create_app/lifespan/核心 WS——行为零变化，154 测试为回归网。② 真实双端 HUD：capture 页每 2s 经 /ingest 文本帧上报 `{type:"uplink_stats", channel, fps_sent, skipped, rtt_ms}`（rtt = capture↔engine WS ping/pong 实测）；/status 增 `uplink` 块。③ 控制台 `GET /console`：单文件现代 HTML/JS（无构建步骤，与 viewer/capture 同模式但设计品质拉满），连 /out（各频道预览）、/events（字幕流）、/status 轮询（HUD/推流/uplink）、/ingest 控制连接（casting + ack）。Edge⇄Local 为占位开关（Edge 灰显标注"待 M1b 边缘节点"——诚实）。旧 React mock 前端不动（已废弃路径）。

**Tech Stack:** 现有全套；控制台纯 HTML/CSS/JS（frontend-design skill 指导设计）。

**执行前提：** Worktree `.worktrees/v2-m3b`，分支 `feature/v2-m3b-console`，基于 master（≥合并后）。M0 venv。基线 154。M3a 合并后清理项一并落：backlog 补 N 频道 libx264 CPU 上限 + mixer 停后订阅悬挂；m3a-results 补"盘上证据来自复跑"句；mixer 停后 subscribe 守卫（raise 或立即哨兵）；`resolve_ffmpeg` 提公共。

---

### Task 1: app.py 拆模块（行为零变化）

拆分如架构节；每个新模块头部 docstring 注明来源与契约归属（A/V 契约段落留 app.py 或移 wire.py——单一居所）；`from service.app import create_app` 对外不变；154 测试全绿是唯一验收标准（先拆 stream，跑绿；再拆 translate，跑绿；小步提交）。顺带：mixer 停后 subscribe 守卫 + resolve_ffmpeg 公共化 + m3a 文档清理项。
Commits: `refactor(m3b): split service modules` + `chore(m3b): m3a post-merge cleanups`

### Task 2: uplink stats（真实双端 HUD 数据）

capture.html：WS ping/pong RTT 实测（复用 /ingest ping 控制帧——已存在 pong 回路！打时间戳算 RTT）；每 2s 发 `uplink_stats` 控制帧；/ingest 分发新增该类型 → 存 `app.state.uplink[channel] = {..., received_at}`；/status 增 `uplink` 块（staleness 标注：超 5s 未更新标 stale）。TDD：控制帧存取、staleness、/status 块、capture 端逻辑轻检（JS 无法单测——E2E 覆盖）。
Commit: `feat(m3b): real uplink stats reporting`

### Task 3: 控制台页面

**实现者必须先 invoke `frontend-design:frontend-design` skill**，按其指导做视觉设计（暗色演播室风、大屏 1440×900 首屏、语义化遥测、动效仅 transform/opacity——沿用 spec §4.2/M0 D-012 的视觉原则）。内容区：
- 顶栏：OneLive 标识、引擎状态（/status engine + uptime）、Edge⇄Local 占位开关（Edge 灰显 tooltip "边缘节点待 M1b"）
- 三频道卡片（N=configured channels，本地 1 路时其余卡片显示"未配置"态——诚实）：/out 预览 canvas、频道语言/音色标签、speech 状态（speaking seg N）、casting 下拉（source 白名单文件列表——新增 `GET /avatars` 返回白名单目录列表）+ 切换按钮 + ack 反馈、推流状态徽标（streams.chN running/restarts）
- 字幕流面板：/events 滚动（原文字幕 + 各语言翻译状态 + tts_ready 标记；unavailable 如实显示"翻译未配置"）
- 双端 HUD 面板：uplink（fps_sent/skipped/rtt——stale 置灰）+ 引擎侧（processed/dropped/skipped/errors/last_infer_ms/speech.played）+ 推流（restarts/stderr_tail 尾行）
- `GET /console` 服务；`GET /avatars`（白名单目录 jpg/png 列表，复用 casting 的目录解析）
TDD（服务端点）+ 页面结构完整（JS 连接逻辑复用 viewer 的既有模式：wss 跟随、重连、4404 处理）。
Commit: `feat(m3b): operator console page`

### Task 4: 控制台 E2E（Playwright）

扩展/新建 `engine/e2e/console_e2e.mjs`：真服务（真管线+--translate-stub）+ 假摄像头采集页 + /audio 喂 zh fixture + 控制台页：断言 ① 频道卡片预览 canvas 帧数递增；② 字幕面板出现真实转写文本；③ casting 下拉选 s1.jpg → ack 反馈 → 预览可见变化（前后截图对比嘴部区域外的整体像素差异——换脸差异大，硬断言可行）；④ HUD uplink rtt 数值出现且非 stale；⑤ 推流徽标（无 --rtmp 时显示未启用态——同样断言）。60-90s 运行，PNG+JSON 证据存档，自断言 exit code。`docs/superpowers/m3b-results.md` 记录。
Commit: `feat(m3b): console e2e with casting and hud assertions`

### Task 5: 收尾 + 合并

README（控制台入口、/avatars、uplink 说明）；m3b-results 终稿（OWNER 项滚动、backlog 滚动）；全量回归（Python + Node + console E2E 复跑）；终审 → 合并。
Commit: `docs(m3b): console results and readme`

---

## Self-Review 记录

- 覆盖：spec §4.2 的引擎侧控制台全项（预览/HUD/casting/推流状态）；Edge⇄Local 以诚实占位交付（真实切换待 M1b 边缘节点存在）；双端 HUD 的"手机侧指标"以 capture 页实测 RTT/fps 落地（当前架构无 WebRTC getStats，WS ping RTT 是真实测量非模拟——如实标注测量方式）。
- 无占位符：拆模块清单、uplink 帧格式、控制台面板清单、E2E 断言全部具体。
- 一致性：uplink_stats 走既有 /ingest 文本控制帧分发（Task 2 of M1c 预留的扩展点）；/avatars 复用 casting 白名单目录解析；频道卡片数 = create_app channels 配置。
