# OneLive ViewLab 三路同步视频制作清单

> 目标：为自由视角界面制作正面、侧面、俯拍三段动作同步的15秒视频。
> 定位：素材驱动的离散机位切换，不声称可以连续生成任意视角。
> 当前限制：普通的三次独立文生视频无法可靠保证人物、商品和动作同步。

## 1. 推荐制作路线

### 首选：一个主动作视频驱动三个机位

```text
同一段15秒主动作视频
├─ 正面机位重绘
├─ 35°侧面机位重绘
└─ 俯拍商品机位重绘
```

视频工具至少应支持以下能力之一：

- reference video / motion reference
- video-to-video
- motion transfer
- character reference
- first frame / last frame control
- camera conditioning

三路都必须使用同一段运动参考、相同起止时间和相同帧数。固定 Seed 只能帮助画面风格接近，不能单独保证动作同步。

### 次选：关键帧加同一运动参考

如果工具不能直接改变摄像机角度：

1. 使用现有正面、侧面和俯拍关键帧作为各自首帧。
2. 三个任务同时使用同一段主动作视频。
3. 将运动参考权重设高，将风格变化权重设低。
4. 限制手势幅度，避免复杂商品操作。

### 不建议：三次独立文生视频

独立生成通常会出现：

- 三路手势发生时间不同。
- 主播脸型、发型和服装发生漂移。
- 锅具直径、把手和电源线不同。
- 背景柜体和台面透视不一致。
- 15秒内人物身份逐渐变化。

如果工具没有运动参考或视频到视频能力，就不能承诺三路同步。此时应回退到静态关键帧切换，或者实际拍摄三个固定机位。

## 2. 输入素材包

建议向视频生成工具同时提供：

| 素材 | 用途 |
| --- | --- |
| `japan-ja-demo.mp4` | 15秒主动作和说话节奏参考 |
| `front.webp` | 正面人物、服装、商品和场景锚点 |
| `side.webp` | 35°侧面构图锚点 |
| `overhead.webp` | 俯拍商品构图锚点 |
| 主播面部近照 | 锁定人物身份，仅用于正面和侧面 |
| 锅具参考图 | 锁定锅体、把手和电源线结构 |

现有项目素材位置：

- `demo/assets/japan-ja-demo.mp4`
- `demo/assets/future/front.webp`
- `demo/assets/future/side.webp`
- `demo/assets/future/overhead.webp`

## 3. 统一动作设计

如果直接使用 `japan-ja-demo.mp4` 作为运动参考，以原视频动作为准，不要另写冲突的动作指令。

如果需要从零生成主动作，使用以下低风险脚本：

| 时间 | 动作 |
| --- | --- |
| 00:00–00:02 | 主播保持正面，轻微说话，双手自然停在锅具两侧 |
| 00:02–00:05 | 右手小幅指向锅具，左手保持稳定 |
| 00:05–00:08 | 双手打开，介绍锅具容量和使用场景 |
| 00:08–00:11 | 左手轻微指向锅内，右手靠近把手但不拿起锅具 |
| 00:11–00:13 | 双手回到锅具两侧，继续说话 |
| 00:13–00:15 | 回到接近首帧的稳定姿态，便于循环 |

不要设计以下动作：

- 打开或关闭锅盖。
- 移动锅具。
- 插拔电源线。
- 拿起勺子或其他小物体。
- 双手交叉或快速遮挡。
- 大幅转身或走出画面。

这些动作容易造成跨视角几何不一致和手指错误。

## 4. 全局提示词

将以下内容附加到三个机位任务中：

```text
Use the attached 15-second master performance video as the exact temporal motion
reference. Preserve the same adult East Asian female host, recognizable face,
dark updo, lavender kimono-style outfit, gray electric cooking pot, white marble
counter and warm cookware showroom. Preserve the exact speaking rhythm, hand gesture
timing, body posture and product position from the motion reference on every frame.

One continuous 15-second shot, 30 fps, locked camera, no cut, no zoom, no dolly,
no rack focus, no lighting change, no costume change and no new prop. Keep the host,
hands, fingers, pot diameter, pot rim, handle, power cord, counter perspective and
background geometry physically stable. First and last frames should be loop-compatible.
No subtitles, UI, logo, brand text, watermark or embedded audio.
```

## 5. 三个机位提示词

### 5.1 正面主播

参考图：`front.webp`
运动参考：同一段15秒主动作视频

```text
Render a native 16:9 front broadcast-camera version of the attached master performance.
Medium-wide waist-up framing. Keep the host centered with her face, both hands and the
complete gray electric pot visible. Extend the cookware showroom naturally to both sides.
This must look like a real locked landscape camera, not a portrait crop with side fill.
Preserve the master video's motion timing frame for frame. Photorealistic live-commerce
broadcast quality, natural skin and fabric, stable cookware geometry.
```

### 5.2 35°侧面互动

参考图：`side.webp`
运动参考：与正面完全相同

```text
Render the same 15-second performance from a locked broadcast camera positioned
35 degrees to the host's left. Preserve the same host identity, facial expression,
speaking rhythm, hand gesture timing, lavender outfit, gray pot, counter and lighting.
Show physically believable horizontal parallax and table depth. The pot and both hands
must remain visible. This is a true side camera viewpoint, not a transformed front crop.
Match every action beat to the master performance frame for frame.
```

### 5.3 俯拍商品

参考图：`overhead.webp`
运动参考：与正面完全相同

```text
Render the same 15-second performance from a locked overhead product camera mounted
above and slightly in front of the counter. Center the complete gray electric pot.
Show the host's two lavender-sleeved hands entering naturally from the upper edge and
following the master performance's exact gesture timing. The face does not need to be
visible. Preserve the pot diameter, rim, handle, power cord, marble counter and nearby
props on every frame. This must be a real overhead composition, not a cropped front view.
```

## 6. 负向约束

如果工具支持 Negative Prompt，三个任务统一使用：

```text
identity drift, different person, face morphing, extra fingers, fused fingers,
missing fingers, duplicated hands, unstable cookware, changing pot size, bent handle,
disconnected power cord, moving counter, warped shelves, background drift, camera shake,
camera movement, zoom, cut, transition, new prop, readable text, logo, brand mark,
subtitle, watermark, UI overlay, audio, portrait crop, blurred side fill
```

## 7. 输出规格

三路原始交付统一为：

- 文件名：`front-master.mp4`、`side-master.mp4`、`overhead-master.mp4`
- 分辨率：1920 × 1080。
- 时长：精确15.000秒。
- 帧率：恒定30fps。
- 总帧数：450帧。
- 编码：H.264 High Profile。
- 像素格式：`yuv420p`。
- 音频：无。
- 关键帧间隔：30或60帧。
- 色彩：三路白平衡和亮度一致。

不要直接把AI工具下载的可变帧率文件放进Demo。先统一帧率、尺寸和时长。

## 8. 后期标准化

每一路可使用以下方式标准化：

```powershell
ffmpeg -i input.mp4 `
  -vf "fps=30,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080" `
  -an -t 15 -c:v libx264 -profile:v high -pix_fmt yuv420p `
  -g 30 -keyint_min 30 -sc_threshold 0 -crf 18 -movflags +faststart output.mp4
```

如果原片不足15秒，不要通过减慢播放速度硬凑；重新生成或在动作稳定区制作自然循环。

## 9. 同步图集视频

三路验收通过后，建议拼成单解码视频：

```powershell
ffmpeg -i front-master.mp4 -i side-master.mp4 -i overhead-master.mp4 `
  -filter_complex "[0:v]scale=960:540[f];[1:v]scale=960:540[s];[2:v]scale=960:540[o];[f][s][o]hstack=inputs=3[v]" `
  -map "[v]" -an -r 30 -t 15 -c:v libx264 -profile:v high `
  -pix_fmt yuv420p -g 30 -crf 18 -movflags +faststart multi-angle-atlas.mp4
```

图集规格：

```text
总尺寸 2880 × 540
┌──────────────┬──────────────┬──────────────┐
│ 正面 960×540 │ 侧面 960×540 │ 俯拍 960×540 │
└──────────────┴──────────────┴──────────────┘
```

单个视频解码时间轴可以保证三个机位绝对同步，也能避免浏览器同时解码三条1080P视频。

## 10. 四点验收

在以下时间点分别截取三路画面并并排检查：

- 00:00，对应第0帧。
- 00:05，对应第150帧。
- 00:10，对应第300帧。
- 00:14.97，对应第449帧。

必须满足：

- 同一个动作节点的误差不超过2帧，约67ms。
- 正面和侧面的人脸、发型和服装一致。
- 三路锅具尺寸、把手方向和电源线逻辑一致。
- 双手不存在增指、粘连、消失或突然跳变。
- 台面和背景柜体没有明显漂移。
- 三路时长均为15秒，帧率均为恒定30fps。
- 全部视频无内嵌字幕、品牌字样、水印和音轨。

## 11. 失败回退

出现以下任一问题时，不应投入比赛Demo：

- 三路动作无法在2帧内对齐。
- 人物身份在任一机位发生明显变化。
- 商品结构不一致或手部错误肉眼可见。
- 背景在播放过程中持续变形。
- 机位实际上只是同一画面的裁切。

可接受的回退顺序：

1. 重新使用同一运动参考生成失败机位。
2. 缩小手势幅度并重新生成三路。
3. 改为实际拍摄三个固定机位。
4. 回退到三张关键帧，并明确标注“概念关键帧”。

不能用不同步的视频配合前端Seek、CSS变形或假指标冒充真实多视角同步。
