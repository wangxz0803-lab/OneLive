# OneLive Leadership Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 生成一份 16:9、中文、6 页主讲加 3 页附录的 OneLive 领导展示版 PPTX，并通过逐页渲染、溢出检测和视觉检查。

**Architecture:** 使用 `@oai/artifact-tool` 在临时工作目录中以 1280 × 720 画布创建可编辑演示文稿。项目内四张视频封面和现有 Demo 截图作为嵌入式图片资产，简单系统架构使用 PowerPoint 原生形状和连接线；最终只把 PPTX 放入 `artifacts/`，渲染图、布局 JSON、素材清单和生成脚本保留在临时目录。

**Tech Stack:** JavaScript ES modules、`@oai/artifact-tool`、PowerPoint PPTX、Presentation container tools、项目内 PNG/JPG 资产。

## Global Constraints

- 输出文件固定为 `artifacts/OneLive-领导展示版.pptx`。
- 主讲 6 页、附录 3 页，共 9 页；16:9，1280 × 720。
- 封面标题至少 50pt，页面标题至少 35pt，正文至少 16pt。
- 中文使用微软雅黑，英文数字使用 Arial；背景接近 `#05070B`。
- 实时青使用 `#54DCE7`，Edge 紫使用 `#927BFF`，市场琥珀使用 `#E7B66A`，退化警告使用 `#F08A5D`。
- 当前四段视频必须表述为目标效果样例；网络、Edge、QoD 和体验指标必须表述为模拟。
- 不展示虚构收入、转化率、节省比例、生产 SLA 或真实运营商测量数据。
- 每页讲者备注包含 `[Sources]` 区块。
- 不使用无关图库和新生成的概念人物图。
- 任何文字、图片或形状不得超出画布；所有非预期重叠必须修复。

---

## File Structure

- Create: `.tmp/onelive-leadership-deck/build-deck.mjs` — 生成 9 页演示文稿、备注、PNG 预览、布局 JSON 和 PPTX。
- Create: `.tmp/onelive-leadership-deck/source-notes.txt` — 外部技术来源与项目素材来源清单。
- Create: `.tmp/onelive-leadership-deck/rendered/` — 最终逐页渲染图，仅用于 QA。
- Create: `.tmp/onelive-leadership-deck/montage.png` — 9 页总览，仅用于 QA。
- Create: `artifacts/OneLive-领导展示版.pptx` — 最终交付文件。
- Read: `public/demo-media/original-zh.jpg` — 原始中文视频关键帧。
- Read: `public/demo-media/japan-ja.jpg` — 日本版本关键帧。
- Read: `public/demo-media/latam-es.jpg` — 拉美版本关键帧。
- Read: `public/demo-media/india-en.jpg` — 印度版本关键帧。
- Read: `artifacts/product-audit-current-demo-2026-08-10/01-localization-start.png` — 本地化控制台截图。
- Read: `artifacts/product-audit-current-demo-2026-08-10/05-high-latency.png` — 高时延与音画错位截图。
- Read: `artifacts/product-audit-current-demo-2026-08-10/07-qod.png` — Edge + QoD 改善截图。
- Read: `artifacts/product-audit-current-demo-2026-08-10/09-business.png` — 商业收尾截图。

---

### Task 1: 初始化生成工作区与来源清单

**Files:**
- Create: `.tmp/onelive-leadership-deck/source-notes.txt`
- Create: `.tmp/onelive-leadership-deck/build-deck.mjs`

**Interfaces:**
- Consumes: Presentation skill 安装目录、项目内截图与视频封面。
- Produces: 可加载 `@oai/artifact-tool` 的工作区和可追溯来源文本。

- [ ] **Step 1: 创建临时目录并初始化 artifact-tool 工作区**

Run:

```powershell
$skillDir = 'D:\Codex\.codex\plugins\cache\openai-primary-runtime\presentations\26.805.11740\skills\presentations'
$tmpDir = 'C:\Users\28963\Documents\ChatGPT\onelive\.worktrees\four-video-demo\.tmp\onelive-leadership-deck'
$node = 'C:\Users\28963\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
& $node "$skillDir\container_tools\setup_artifact_tool_workspace.mjs" --workspace $tmpDir
```

Expected: `$tmpDir` 下出现可解析 `@oai/artifact-tool` 的 Node 工作区，命令退出码为 0。

- [ ] **Step 2: 写入来源清单**

Write `.tmp/onelive-leadership-deck/source-notes.txt` with exactly these entries:

```text
PROJECT ASSETS
OneLive local demo screenshots and video cover images, captured/generated for this project on 2026-08-10.

TECHNICAL SOURCES
RTP/RTCP synchronization: https://www.rfc-editor.org/info/rfc3550/
ETSI Multi-access Edge Computing: https://www.etsi.org/technical-groups/mec/
GSMA Open Gateway API descriptions: https://www.gsma.com/solutions-and-impact/gsma-open-gateway/gsma-open-gateway-api-descriptions/
CAMARA Quality on Demand: https://github.com/camaraproject/QualityOnDemand
Google real-time speech-to-speech translation: https://research.google/blog/real-time-speech-to-speech-translation/
Meta Seamless Communication: https://ai.meta.com/research/seamless-communication/
```

- [ ] **Step 3: 创建生成脚本基础结构**

Write `.tmp/onelive-leadership-deck/build-deck.mjs` with these imports and constants:

```js
import fs from "node:fs/promises";
import path from "node:path";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const ROOT = "C:/Users/28963/Documents/ChatGPT/onelive/.worktrees/four-video-demo";
const TMP = path.join(ROOT, ".tmp/onelive-leadership-deck");
const FINAL = path.join(ROOT, "artifacts/OneLive-领导展示版.pptx");
const W = 1280;
const H = 720;
const C = {
  bg: "#05070B",
  surface: "#0C121A",
  surface2: "#111925",
  text: "#F2F5F7",
  muted: "#98A5B3",
  cyan: "#54DCE7",
  violet: "#927BFF",
  amber: "#E7B66A",
  warning: "#F08A5D",
  line: "#22303D",
};
const ASSET = {
  original: path.join(ROOT, "public/demo-media/original-zh.jpg"),
  japan: path.join(ROOT, "public/demo-media/japan-ja.jpg"),
  latam: path.join(ROOT, "public/demo-media/latam-es.jpg"),
  india: path.join(ROOT, "public/demo-media/india-en.jpg"),
  control: path.join(ROOT, "artifacts/product-audit-current-demo-2026-08-10/01-localization-start.png"),
  latency: path.join(ROOT, "artifacts/product-audit-current-demo-2026-08-10/05-high-latency.png"),
  qod: path.join(ROOT, "artifacts/product-audit-current-demo-2026-08-10/07-qod.png"),
  business: path.join(ROOT, "artifacts/product-audit-current-demo-2026-08-10/09-business.png"),
};

async function bytes(file) {
  const b = await fs.readFile(file);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

async function writeBlob(file, blob) {
  await fs.writeFile(file, new Uint8Array(await blob.arrayBuffer()));
}
```

Expected: the script parses as an ES module after Task 2 completes its body.

---

### Task 2: 生成 6 页主讲和 3 页附录

**Files:**
- Modify: `.tmp/onelive-leadership-deck/build-deck.mjs`
- Create: `artifacts/OneLive-领导展示版.pptx`

**Interfaces:**
- Consumes: `ASSET`, `C`, `bytes()`, `writeBlob()` from Task 1.
- Produces: `Presentation` with exactly 9 slides, notes on every slide, and the final PPTX.

- [ ] **Step 1: 添加可复用文本、图片、页脚和备注函数**

Append these helpers:

```js
function addText(slide, name, text, position, style = {}) {
  const shape = slide.shapes.add({
    geometry: "textbox",
    name,
    position,
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  shape.text = text;
  shape.text.style = {
    fontFamily: style.fontFamily ?? "Microsoft YaHei",
    fontSize: style.fontSize ?? 18,
    bold: style.bold ?? false,
    color: style.color ?? C.text,
    alignment: style.alignment ?? "left",
    verticalAlignment: style.verticalAlignment ?? "middle",
  };
  return shape;
}

function addRule(slide, left, top, width, color = C.line, height = 2) {
  return slide.shapes.add({
    geometry: "rect",
    position: { left, top, width, height },
    fill: color,
    line: { style: "solid", fill: color, width: 0 },
  });
}

async function addImage(slide, file, alt, position, options = {}) {
  return slide.images.add({
    blob: await bytes(file),
    contentType: file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
    alt,
    fit: options.fit ?? "cover",
    position,
    geometry: options.geometry ?? "roundRect",
    borderRadius: options.borderRadius ?? 14,
    ...(options.crop ? { crop: options.crop } : {}),
  });
}

function addFooter(slide, page, section = "ONE SOURCE · MANY MARKETS · LIVE") {
  addRule(slide, 72, 678, 1136, C.line, 1);
  addText(slide, `footer-${page}`, section, { left: 72, top: 684, width: 470, height: 20 }, { fontSize: 11, color: C.muted });
  addText(slide, `page-${page}`, String(page).padStart(2, "0"), { left: 1140, top: 684, width: 68, height: 20 }, { fontSize: 11, color: C.muted, alignment: "right" });
}

function addNotes(slide, talkTrack, sources) {
  slide.speakerNotes.textFrame.setText(`${talkTrack}\n\n[Sources]\n${sources.join("\n")}`);
  slide.speakerNotes.setVisible(true);
}
```

- [ ] **Step 2: 创建演示文稿和 9 页内容**

Use `Presentation.create({ slideSize: { width: W, height: H } })`. Each slide background is `C.bg`. Implement the following exact narrative and layout map:

| Page | Takeaway title | Main geometry |
| --- | --- | --- |
| 1 | `一次直播，面向多个市场` | 左侧 520px 标题区；右侧四张 9:16 封面错位排列，原片青色描边、市场片分别用紫/琥珀/青色细线。 |
| 2 | `跨境直播，不该重复生产三次` | 左侧 560px 大结论；右侧三条纵向阻力：重复拍摄、语言与表达差异、实时交付不稳定。 |
| 3 | `一路中文直播，形成三个本地化版本` | 顶部结论；下方四张封面横向排列，原片宽 220px，三个市场各宽 180px；底部只写 `中文原片 → 日语 / 西班牙语 / 英语`。 |
| 4 | `生成内容之后，真正的挑战是实时交付` | 左侧两条因果：拥塞导致画质退化；云端本地化语音链路滞后导致音画错位。右侧放高时延截图并裁切到舞台、A/V 警告和 1000ms 指标。 |
| 5 | `Edge 缩短链路，QoD 保护关键流` | 左右各 500px 图片：高时延状态与 QoD 状态；中间用连接箭头；底部两句：`Edge：处理与回传更近`、`QoD：有限资源优先保障`。 |
| 6 | `从效果样例，走向实时多市场直播` | 三段横向演进线：当前目标效果样例、下一阶段实时语音与口型、长期实时人物与场景；右下角收尾语 `One source. Many markets. Live.`。 |
| 7 | `真实系统只上传一次，再在 AI 节点分叉` | 原生连接线先创建；随后创建五个节点：主播源、原始上行、区域/边缘 AI、三个市场输出、分发平台。底部拆分上行、AI 计算、下行分发三类资源。 |
| 8 | `当前 Demo 证明体验方向，不冒充生产系统` | 三条由左向右的能力层：已展示、下一阶段、长期目标；底部一条边界说明：`LIVE / EMULATED 按每项数据来源判断`。 |
| 9 | `技术路径已有依据，工程重点在整合与稳定` | 四条来源主题：同步标准、边缘计算、网络保障、流式语音翻译；右下角放完整来源 URL 的短列表，正文不加入未经来源支持的数字。 |

Visible copy must be exactly:

```js
const COPY = {
  p1: ["OneLive", "一次直播，面向多个市场", "基于 5G 与边缘 AI 的跨境直播本地化方案"],
  p2: ["重复拍摄", "不同语言与文化表达", "实时交付体验不稳定"],
  p3: ["中文原片", "日本 · 日语", "拉美 · 西班牙语", "印度 · 英语"],
  p4: ["拥塞压缩有限资源", "云端本地化语音链路滞后", "画质下降 / 缓冲", "清晰但音画错位", "演示数据 · EMULATED"],
  p5: ["Cloud + Best Effort", "Edge AI + QoD", "Edge：缩短处理与回传路径", "QoD：在有限资源下优先保护关键流", "演示数据 · EMULATED"],
  p6: ["当前", "目标效果样例", "下一阶段", "实时翻译 · 目标语言语音 · 口型同步", "长期", "实时人物 · 场景 · 多市场生成"],
  p7: ["主播原始直播", "上传一次", "区域 / 边缘 AI", "日本 · 拉美 · 印度", "CDN / WebRTC / 直播平台"],
  p8: ["已展示", "四段视频与可控网络差异", "下一阶段", "流式 ASR、翻译、TTS 与同步控制", "长期目标", "写实视觉生成与三市场低时延并行"],
  p9: ["RTP / RTCP：跨媒体时间戳同步", "ETSI MEC：低时延边缘计算环境", "GSMA / CAMARA QoD：指定应用流质量保障", "Google / Meta：流式语音到语音翻译"],
};
```

Speaker notes must use these talk tracks:

```js
const NOTES = [
  "OneLive 希望解决一个简单问题：同一场直播，如何不重复拍摄，就能面向多个市场表达。",
  "今天跨境直播往往需要重复组织主播、语言和拍摄。OneLive 关注的不是再做一个翻译器，而是减少重复内容生产。",
  "左侧是一段中文原始录屏，右侧是日本、拉美和印度三个目标效果样例。现场可以从这里切入 OneLive Demo，逐个点击市场查看。",
  "实时化之后，内容生成只是第一步。拥塞会影响画质，而视频路径与云端翻译语音路径延迟不一致时，会出现肉眼可见的音画错位。",
  "Edge 把时延敏感的处理放得更近，缩短推理和回传路径；QoD 在拥塞时保护指定关键业务流。两者改善不同问题，也都不会创造无限带宽。",
  "当前 Demo 用预生成视频验证目标体验；下一阶段先落地实时语音链路和同步，再逐步推进写实人物与场景的实时生成。",
  "真实架构中，主播视频只上传一次。市场版本在区域或边缘 AI 节点分叉，随后分别分发，因此上行、AI 计算和下行分发需要分开建模。",
  "这套 Demo 展示的是目标体验和可控网络故事，不代表已经接入生产级 MEC、QoD 或实时视觉生成。",
  "实时语音、边缘计算、应用流网络保障和音视频同步都有标准或研究基础。主要工程挑战在于把它们稳定整合为多市场低时延系统。",
];
```

- [ ] **Step 3: 为每页添加来源、页脚和导出逻辑**

Use these sources per page:

```js
const SOURCES = [
  ["OneLive project assets: public/demo-media/*.jpg"],
  ["OneLive product specification: docs/PRODUCT_SPEC.md"],
  ["OneLive project assets: public/demo-media/*.jpg", "OneLive Demo screenshot: 01-localization-start.png"],
  ["RFC 3550: https://www.rfc-editor.org/info/rfc3550/", "OneLive Demo screenshot: 05-high-latency.png"],
  ["ETSI MEC: https://www.etsi.org/technical-groups/mec/", "GSMA Open Gateway: https://www.gsma.com/solutions-and-impact/gsma-open-gateway/gsma-open-gateway-api-descriptions/", "OneLive Demo screenshot: 07-qod.png"],
  ["Google Research: https://research.google/blog/real-time-speech-to-speech-translation/", "Meta AI Research: https://ai.meta.com/research/seamless-communication/"],
  ["OneLive architecture: docs/ARCHITECTURE.md", "ETSI MEC: https://www.etsi.org/technical-groups/mec/"],
  ["OneLive decisions: docs/DECISIONS.md", "OneLive product specification: docs/PRODUCT_SPEC.md"],
  ["RFC 3550: https://www.rfc-editor.org/info/rfc3550/", "ETSI MEC: https://www.etsi.org/technical-groups/mec/", "CAMARA QoD: https://github.com/camaraproject/QualityOnDemand", "Google Research and Meta AI Research links listed on slide"],
];
```

Append export logic:

```js
await fs.mkdir(path.join(TMP, "preview"), { recursive: true });
for (const [index, slide] of presentation.slides.items.entries()) {
  addFooter(slide, index + 1, index < 6 ? "ONE SOURCE · MANY MARKETS · LIVE" : "TECHNICAL APPENDIX");
  addNotes(slide, NOTES[index], SOURCES[index]);
  const stem = `slide-${String(index + 1).padStart(2, "0")}`;
  await writeBlob(path.join(TMP, "preview", `${stem}.png`), await presentation.export({ slide, format: "png", scale: 1 }));
  await fs.writeFile(path.join(TMP, "preview", `${stem}.layout.json`), await (await slide.export({ format: "layout" })).text());
}
await writeBlob(path.join(TMP, "deck-montage.webp"), await presentation.export({ format: "webp", montage: true, scale: 1 }));
const pptx = await PresentationFile.exportPptx(presentation);
await pptx.save(FINAL);
```

Expected: `artifacts/OneLive-领导展示版.pptx` exists, contains 9 slides, and every slide has speaker notes.

---

### Task 3: 渲染、检查并修正视觉问题

**Files:**
- Modify: `.tmp/onelive-leadership-deck/build-deck.mjs`
- Regenerate: `artifacts/OneLive-领导展示版.pptx`
- Create: `.tmp/onelive-leadership-deck/rendered/*.png`
- Create: `.tmp/onelive-leadership-deck/montage.png`

**Interfaces:**
- Consumes: Task 2 final PPTX.
- Produces: 无溢出、无非预期重叠、逐页视觉检查通过的最终 PPTX。

- [ ] **Step 1: 运行生成脚本**

Run:

```powershell
$node = 'C:\Users\28963\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node '.\.tmp\onelive-leadership-deck\build-deck.mjs'
```

Expected: exit code 0 and final PPTX exists.

- [ ] **Step 2: 运行溢出检查**

Run:

```powershell
$python = 'C:\Users\28963\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$skillDir = 'D:\Codex\.codex\plugins\cache\openai-primary-runtime\presentations\26.805.11740\skills\presentations'
& $python "$skillDir\container_tools\slides_test.py" '.\artifacts\OneLive-领导展示版.pptx'
```

Expected: no elements reported outside the original slide canvas.

- [ ] **Step 3: 使用 PowerPoint/LibreOffice 渲染全部页面并生成总览**

Run:

```powershell
$python = 'C:\Users\28963\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$skillDir = 'D:\Codex\.codex\plugins\cache\openai-primary-runtime\presentations\26.805.11740\skills\presentations'
& $python "$skillDir\container_tools\render_slides.py" '.\artifacts\OneLive-领导展示版.pptx'
& $python "$skillDir\container_tools\create_montage.py" --input_dir '.\artifacts\OneLive-领导展示版' --output_file '.\.tmp\onelive-leadership-deck\montage.png'
```

Expected: 9 张 `slide-*.png` 和一张 `montage.png`。

- [ ] **Step 4: 逐页视觉检查**

Inspect all 9 rendered PNG files individually, then inspect the montage. Reject and revise any slide with:

```text
title wraps to two lines when intended as one line
body text below 16pt
cropped faces or product
blurry screenshot crop
unreadable console text used as evidence
non-purposeful image or text overlap
inconsistent footer or page number
same composition repeated on adjacent slides
current capability described as production real-time
```

- [ ] **Step 5: 修正并重复生成与渲染**

Modify only the affected slide function in `build-deck.mjs`, rerun Steps 1–4, and stop only when all 9 pages pass.

---

### Task 4: 最终验证与交付

**Files:**
- Verify: `artifacts/OneLive-领导展示版.pptx`

**Interfaces:**
- Consumes: visually accepted deck from Task 3.
- Produces: final user-facing deliverable.

- [ ] **Step 1: 验证文件与页数**

Run:

```powershell
Get-Item '.\artifacts\OneLive-领导展示版.pptx' | Select-Object FullName,Length,LastWriteTime
Get-ChildItem '.\artifacts\OneLive-领导展示版\slide-*.png' | Measure-Object
```

Expected: PPTX length greater than 0 and rendered slide count equals 9.

- [ ] **Step 2: 核对可见文案和备注来源**

Use `PresentationFile.importPptx` and `presentation.inspect({ kind: "slide,textbox,notes", maxChars: 20000 })`. Confirm:

```text
9 slides
6 main pages followed by 3 appendix pages
each slide includes a [Sources] block in notes
pages 4 and 5 visibly say EMULATED
page 6 distinguishes current, next stage, and long-term target
```

- [ ] **Step 3: 交付最终 PPTX**

Return only the final deck as the user-facing presentation artifact. Mention that it contains 6 main slides, 3 appendix slides, speaker notes, and official technical sources. Do not attach the temporary script, render folder, montage, or source-notes file unless requested.

