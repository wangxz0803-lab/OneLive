# Future Experience AI 素材提示词

## 使用方法

所有镜位都使用 `demo/assets/japan-ja.jpg` 作为人物、服装、锅具、灯光和动作参考。若工具支持参考视频，再同时上传 `demo/assets/japan-ja-demo.mp4` 作为动作时间轴。

生成顺序建议：

1. 先生成正面横屏锚点并人工确认人物一致性。
2. 将正面锚点和原始竖屏图同时作为侧面镜位参考。
3. 俯拍镜位只强调服装袖口、手势、锅具和台面连续性，不需要生成脸。
4. 三张关键帧确认后，再分别进行 image-to-video。

## 全局连续性约束

将下面这段追加到每个提示词末尾：

```text
Preserve the same adult East Asian female host, recognizable face, dark updo,
lavender kimono-style outfit, gray electric cooking pot, warm cookware showroom,
soft studio lighting, and exact action moment. Fixed camera, no cut, no zoom,
no subtitles, no UI, no watermark, no extra people. Keep hands, fingers, pot handles,
power cord, counter perspective, and background geometry physically stable.
```

## 正面主播镜位

```text
Create a native 16:9 landscape front broadcast-camera view of the reference moment.
The host is centered in a medium-wide waist-up frame. Her face, both open hands,
lavender outfit, and the complete gray electric pot are clearly visible.
Extend the cookware showroom naturally to both sides. This must look like a real
landscape camera, not a portrait image with blurred side fill. Photorealistic
live-commerce broadcast quality, natural skin and fabric texture, no readable signage.
```

## 35° 侧面互动镜位

```text
Create a synchronized second camera view captured at the same moment, 35 degrees
to the host's left. Preserve the same host identity, expression, open-hand gesture,
lavender outfit, gray electric pot, counter, and warm studio light. Show strong but
physically believable horizontal parallax and table depth. Use a practical medium-wide
16:9 broadcast framing. Do not create a front crop or fisheye view.
```

## 俯拍商品镜位

```text
Create a synchronized overhead product-camera view mounted above and slightly in
front of the counter. Center the same gray electric pot and show it fully from above.
The host's two lavender-sleeved hands remain open naturally on both sides of the pot.
Only a small portion of her torso appears at the top edge. Preserve the white marble
counter, nearby props, pot proportions, handle and power-cord logic. Photorealistic
16:9 live-commerce product camera, no face required.
```

## 空间重建关键视觉

```text
Visualize the same host and gray electric pot as a high-quality spatial capture being
reconstructed from a real live-commerce studio. Keep the central host, product and
nearby counter photorealistic. Toward the outer environment, progressively reveal
sparse cyan depth points, camera rays, volumetric samples and translucent geometry.
Use a wide 16:9 composition with the subject centered and scene information on both
sides for free-viewpoint interaction. Technical and elegant, not cyberpunk. One cyan
technical accent, no purple glow, no hologram person, no floating dashboard.
```

## 15 秒视频提示词追加段

三路关键帧确认后，在对应 image-to-video 任务中追加：

```text
Generate one continuous 15-second shot at 30 fps. The camera remains locked.
The host speaks naturally with restrained mouth movement and small stable hand gestures.
The pot and counter do not move. No scene cut, camera movement, zoom, rack focus,
new prop, costume change, lighting change or embedded audio. First and last frames
must be loop-compatible. Preserve identity and geometry on every frame.
```

为了同步三路动作，优先使用同一 motion reference、相同首尾帧、相同帧数和相同 seed。若工具不支持动作参考，先把手势压到最小，再在后期用相同节拍点对齐。

## 后期验收

每一路必须检查：

- 人脸、发型、服装腰带和领口是否一致。
- 双手是否出现增指、粘连或跳变。
- 锅具直径、把手、电源线和锅沿是否稳定。
- 背景柜体、台面线条和灯带是否漂移。
- 三路在 0 秒、5 秒、10 秒和 15 秒的动作阶段是否一致。

统一输出为 1920 × 1080、30fps、15 秒、H.264、无音轨。最终可使用以下命令横向拼成单解码图集：

```powershell
ffmpeg -i front.mp4 -i side.mp4 -i overhead.mp4 `
  -filter_complex "[0:v]scale=960:540[f];[1:v]scale=960:540[s];[2:v]scale=960:540[o];[f][s][o]hstack=inputs=3[v]" `
  -map "[v]" -an -r 30 -t 15 -c:v libx264 -pix_fmt yuv420p -movflags +faststart multi-angle-atlas.mp4
```

图集每一格为 960 × 540，总尺寸 2880 × 540。前端只解码这一条视频，再用 Canvas 裁出三个同步镜位。
