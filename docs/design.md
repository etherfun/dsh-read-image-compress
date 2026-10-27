# read_image Hook 与图片压缩：设计 + 安装记录

> 设计预览 · 2026-10-27 · 基于当前安装的 DSH `0.2.1-rc.3`（`D:\SOFT\tools\dsh`）与 `web` profile
>
> **状态：v0.2 已安装为 `@local/dsh-read-image-compress`（bundle，`link:` 到工作区）。** 新增 Sharp 直编码与设置页：`quality`、`resolutionScale`、`format`（auto/jpeg/webp/png）、`maxEdge`、`maxBytes`、`webpEffort`、`cacheEntries` 等。默认 q85/effort4 把 3.97 MB PNG 读成 1568×996 的 WebP（255,086 bytes）；JPEG/WebP/分辨率/质量设置已 live 验证。
>
> 结论先行：**能 hook**。`read_image` 走的是普通工具管线，插件可以在 `tools/post-execute` 里替换它的 canonical value，registry 会重新校验 schema 并重新 render。
>
> 但先说一个反直觉的实测结果：**DSH 已经在“入库”和“发请求”两层做 WebP/JPEG 压缩了。对 4 MB 的截图，模型实际收到的通常只有 300–400 KB，不是 4 MB。** 真正还没被压缩的是“低于 1 MiB 的 PNG 直通”和“Web UI / 磁盘上的 4 MB 原图”。所以“再 hook 一次 JPG”在很多图片上是重复劳动；要省时间，得先对准这三类收益。

---

## 1. `read_image` 的完整链路

当前安装里 `read_image` 的实现位于 `@deepseek-ai/dsh-tool-fs/lib/index.js`（`applyReadImageTool`，约 984–1068 行）：

1. 校验扩展名 / 文件签名，确认是 PNG/JPEG/WebP/GIF。
2. 用当前 route 的 provider/model 检查是否声明 `image` 输入。
3. `ctx.fs.readBytes` 读出源文件字节（上限 `maxImageBytes`）。
4. `ctx.attachments.saveImage({ data, mediaType, name })`：
   - 完整 decode；
   - 按 `attachment-local` 的 normalization policy 决定 **原样直通** 还是 **重编码**；
   - 返回内容寻址的 `attachmentId` + 实际存储的 `mediaType` / `width` / `height` / `bytes`。
5. 工具返回结构化 value：

```json
{
  "path": "<文件路径>",
  "image": {
    "attachmentId": "sha256:…",
    "mediaType": "image/png | image/jpeg | image/webp | image/gif",
    "bytes": 123,
    "width": 1800,
    "height": 1143,
    "name": "screenshot.png",
    "originalDimensions": { "width": 3000, "height": 1905 }
  }
}
```

6. 工具定义的 `output.render` 把 value 变成模型看到的两块内容：
   - 一段 `<path>/<type>/<content>` 文本信封；
   - 一个 `ImageBlock`，只带 `attachment` 引用，不带 base64。

所以 hook 的切入点不是“改字节”，而是**在 value 提交前换掉其中的 `image` 引用**。

---

## 2. Hook 点：确实存在，而且是官方扩展点

`@deepseek-ai/dsh-tools` 的 README 和实现把一次工具调用固定为：

```
tools/pre-execute  (allow/deny/ask)
  → guards
  → tools/execute  (around dispatch)
  → tools/post-execute  (inspect / replace)
  → definition.finalizeContent
  → tools/result  (observe only)
```

关键代码在 `dsh-tools/lib/index.js`：

- `postExecute()` 约 3599–3627 行：
  - `tools/post-execute` 返回 `{ kind: 'accept', value }` 时，registry 调用 `createSuccessResult(exec, tool, value)`；
  - 返回 `{ kind: 'accept', content }` 时只替换内容；
  - `value` 和 `content` 不能同时替换；
  - `block` 会变成 `isError`。
- `createSuccessResult()` 约 3636–3666 行：
  - `snapshotToolValue` → `validateJsonSchemaValue(tool.output.schema, …)`；
  - `tool.output.render(exec.arguments, value)` 重新生成 content；
  - 因此替换后的 value 必须严格符合 `read_image` 的 output schema，渲染会自动跟着新 value 走。

`dsh-tools` README 第 89、109、141 行也明确写了 `tools/post-execute` 可以 “inspect or replace the result”，并且 `dsh-repeat-tool-reminder` 已经用同样的写法（`ctx.on('tools/post-execute', async (exec, result, next) => …)`）在线上运行，说明这个扩展点不是纸面设计。

**结论：不需要 fork `dsh-tool-fs`，一个 host-only Cordis 插件就能 hook。**

---

## 3. 但 DSH 已经有两级压缩：先看清“省”在哪里

### 3.1 第一级：附件入库规范化（`dsh-attachment-local`）

`normalizeImage()`（约 255–271 行）与 `canPassThroughNormalization()`（约 212–214 行）：

- 源图若已经满足以下全部条件，就 **字节原样直通**：
  - 非 GIF、非动画；
  - 不带 EXIF/XMP/ICC/评论等元数据；
  - 8-bit、sRGB；
  - `bytes <= normalizedImageMaxBytes`（默认 **4 MiB**）；
  - `width*height <= normalizedImageMaxPixels`（默认 **4,194,304**，约 4.2 MP）；
  - 长边 `<= normalizedImageMaxDimension`（默认 8192）。
- 否则重编码；编码器按 `hasAlpha` 选格式：
  - 有 alpha → **WebP**（`effort: 0`）；
  - 无 alpha → **JPEG**；
  - 质量阶梯 **85 → 75 → 60**，取第一个满足 `maxBytes` 的；全都不满足时取最小的那个。

默认 policy 见 `dsh-attachment-local/lib/index.js` 约 895–915、973–1014 行。

**关键点：一张 3.9 MB、1800×1143 的 PNG 截图，因为 `3.9 MB < 4 MiB` 且 `2.06 MP < 4.2 MP`，会被原样存成 PNG。** 磁盘和 Web UI 拿到的就是这 3.9 MB。

### 3.2 第二级：按 route 生成请求图（`dsh-llm-pi-ai`）

`prepareRequestImages()`（约 1252–1259 行）对每个 `ImageAttachmentRef` 调：

```js
attachments.readImageRequest(ref, requestImageTarget(ref, budget), signal)
```

`dsh-attachment-local` 的 `readRequestImageFile()` / `createRequestImage()`（约 802–810、865–891 行）：

- 若 `target.width >= ref.width && target.height >= ref.height && ref.bytes <= target.maxBytes`，**原样直通**；
- 否则重编码，同样按 alpha 选 WebP/JPEG，质量阶梯 85/75/60；
- 结果写入 `attachments/v1/request-images/…` 缓存，variant id 由 attachment + target + encoder 共同决定；
- 最终 `userContent()`（约 1220–1246 行）把 `version.data` 转成 base64，`mimeType` 用 `version.mediaType` 发给模型。
  - 注意：base64 会让线上字节再膨胀约 4/3；下表的 “发给模型” 是编码后原图字节，实际 HTTP body 约乘以 1.33。

`dsh-llm-pi-ai` 默认 target：

- `requestImagePixelBudget`: **2048 × 2048 = 4,194,304**
- `requestImageMaxBytes`: **1 MiB**
- `maxRequestImageBytes`（整个请求体的 base64 上限）：20 MiB

所以：

| 源图（存储层） | 当前实际发给模型 | 说明 |
|---|---|---|
| 3.9 MB PNG，1800×1143，有 alpha | **WebP ≈ 356–364 KB** | 尺寸没超 4.2 MP，但字节 > 1 MiB，触发重编码 |
| 3.9 MB PNG，1800×1143，无 alpha | **JPEG ≈ 405–414 KB** | 同上，走 JPEG q85 |
| 714 KB PNG，1230×480 | **PNG 714 KB（直通）** | 尺寸和字节都没超 target，不重编码 |
| 400 KB PNG，小图 | **PNG 400 KB（直通）** | 同上 |

**这就是最容易误解的地方：**

- 对“大图”，模型收到的已经不是 4 MB，而是 300–400 KB；再 hook 一次 JPG，请求体几乎不变。
- 对“小于 1 MiB 的 PNG”，模型收到的仍是 PNG；这类图才是 hook 能明显减少发送字节的地方。
- **JPEG 不减少 token**。token 由像素尺寸决定；要省 token/解码时间，必须降 `width×height`，不是换编码格式。
- **Web UI / 磁盘**始终拿存储层对象；对 3.9 MB PNG，UI 仍要传 3.9 MB、浏览器仍要解 PNG。这才是“本地发送/解码”的大头。

---

## 4. 用你机器上的真实附件实测

数据来自 `C:\Users\q1325\.dsh\attachments\v1\objects`（本机现有 253 个附件）：

- 211 个 PNG，合计 **497 MB**；
- 34 个 WebP，15 MB；
- 8 个 JPEG，5 MB；
- 大量 PNG 是 **1800×1143 / 1920×1143，3.8–4.1 MB** 的截图，正好卡在 4 MiB 直通线以下。

用 DSH 同款 `sharp 0.35.5 / libvips 8.18.7`、同款质量阶梯（q85，WebP `effort:0`）复测：

| 样本 | 存储 | 当前发给模型 | hook 到 1568 长边 q85 | 说明 |
|---|---|---|---|---|
| 1800×1143，3.97 MB，**有 alpha** | 3.97 MB PNG | **WebP 364 KB** | **WebP 280 KB** @1568×996 | 模型只小 1.3×；存储/UI 14×；像素 2.06→1.56 MP |
| 1800×1143，2.89 MB，无 alpha | 2.89 MB PNG | **JPEG 414 KB** | **JPEG 319 KB** @1568×996 | 模型 1.3×；存储/UI 9× |
| 1230×480，714 KB，无 alpha | 714 KB PNG | **PNG 714 KB（直通）** | **JPEG 102 KB** @1230×480 | 模型 7×；这是 hook 的主要收益 |
| 同上，1280 长边 | — | — | JPEG 80 KB @1024×400 | 像素 0.59→0.41 MP |

补充：

- 对有 alpha 的 3.97 MB 样本，如果强行 flatten 成白底 JPEG q85：
  - 1800 长边：423 KB（比 WebP 356 KB 还大）；
  - 1568 长边：332 KB（比 WebP 280 KB 大）；
  - 1280 长边：236 KB（比 WebP 203 KB 大）。
  - **结论：WebP 在同样质量下更小；强行 JPEG 通常换来更大的字节，只有在你确实需要 JPEG 解码速度或 provider 不认 WebP 时才有意义。**

编码耗时（同一台机器，含 decode + resize + encode）：

- 1800×1143 PNG → 同尺寸 q85：约 **140–170 ms**；
- 1800×1143 PNG → 1568 q85：约 **80–190 ms**；
- 1230×480 PNG → 同尺寸 q85：约 **30–44 ms**。

---

## 5. 方案 A：不写 hook，只改配置（首选，如果目标是“整体变小”）

`dsh-attachment-local` 的 normalization policy 是公开配置。把默认的 4 MiB / 4.2 MP 收紧，**入库时**就会把 4 MB PNG 变成几百 KB 的 WebP/JPEG，模型请求随后直接直通，UI/磁盘也一起变小。

在 `C:\Users\q1325\.dsh\profiles\web\cordis.patch.yml` 里加：

```yaml
- id: attachment-local
  name: "@deepseek-ai/dsh-attachment-local"
  config:
    normalizedImageMaxPixels: 1572864      # ≈1.5 MP，约 1568×980（16:9）
    normalizedImageMaxBytes: 524288         # 512 KiB，超过就重编码
    normalizedImageMaxDimension: 2048       # 长边硬上限
```

效果（对新建附件）：

- 3.97 MB / 1800×1143 PNG → 约 **1.5 MP + 250–350 KB WebP/JPEG**；
- 714 KB / 1230×480 PNG → 590 K px 不缩，但 714 KB > 512 KiB，触发重编码 → 约 **80–110 KB WebP/JPEG**；
- 模型请求：因为存储层已经 ≤ target（4 MP / 1 MiB），`readImageRequest` 直接直通，不再重编码；
- Web UI / 磁盘：同样从 MB 级降到几百 KB。

如果还想让“请求层”有独立上限（比如换模型/换 provider 时），再在现有 `llm-pi-ai` 的 `magpie` provider 下加：

```yaml
        requestImagePixelBudget: 1572864
        requestImageMaxBytes: 524288
```

注意：`cordis.patch.yml` 的匹配 override 会**整体替换**该行的 `config`；`llm-pi-ai` 已经有很长的 provider 配置，添加这两个键时要改在原有 block 内，不要另起一行覆盖。

**优点：** 零代码；入库时只 decode/encode 一次；对 `read_image`、用户上传、UI 全部生效；不会 double-compress；配置层持久、可回滚。
**缺点：** 全局生效（不能只针对 `read_image`）；只影响**新**附件，已经存下的 4 MB PNG 不会自动变小；alpha 仍走 WebP（不是严格 JPEG）；1.5 MP 对文字截图可能略糊，需要按你的截图类型调。

---

## 6. 方案 B：`read_image` 专用 hook 插件（如果只想改工具读取）

### 6.1 插件形态

Host-only bundle，无构建、无 `sharp` 依赖：

```text
read-image-compress/
  package.json
  cordis.patch.yml
  index.js
  locale/en.json
  locale/zh.json
  icon.svg
```

`index.js` 只做一件事：监听 `tools/post-execute`，只处理 `read_image`，把 image ref 换成更小的 ref。

### 6.2 核心逻辑（已按此实现并安装）

```js
export const name = 'read-image-compress'
export const inject = ['attachments']
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  maxEdge: Schema.number().min(64).default(1568),
  maxBytes: Schema.number().min(1024).default(524288),
  minBytes: Schema.number().min(0).default(131072),
  minResizeScale: Schema.number().min(0).default(0.9),
  downscaleWebp: Schema.boolean().default(true),
  skipGif: Schema.boolean().default(true),
})

export function apply(ctx, config) {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (!config.enabled || exec.name !== 'read_image' || result.isError) return next()
    const value = result.value
    const image = value?.image
    if (!image) return next()

    // GIF 保留动画；WebP 只在需要降尺寸时处理；小 JPEG 不动。
    if (config.skipGif && image.mediaType === 'image/gif') return next()
    const longEdge = Math.max(image.width, image.height)
    const scaleToMaxEdge = config.maxEdge / longEdge
    const needsResize = scaleToMaxEdge < 1 && scaleToMaxEdge <= config.minResizeScale
    // WebP 已经是压缩格式：只在需要降像素时处理，不做同尺寸重编码。
    if (image.mediaType === 'image/webp' && (!config.downscaleWebp || !needsResize)) return next()
    if (image.mediaType === 'image/jpeg' && !needsResize && image.bytes <= config.maxBytes) return next()
    if (image.bytes < config.minBytes && !needsResize) return next()

    // 用 DSH 自己的 request-image 编码器：有 alpha → WebP，无 alpha → JPEG，
    // 质量阶梯 85/75/60，和最终发送给模型的是同一套编码。
    const scale = needsResize ? scaleToMaxEdge : 1
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    const target = {
      width,
      height,
      // 关键：maxBytes 必须小于源字节，否则 readImageRequest 会原样直通，起不到“换格式”的作用。
      maxBytes: Math.min(config.maxBytes, Math.max(1, image.bytes - 1)),
    }
    const version = await ctx.attachments.readImageRequest(image, target, exec.signal)

    // 没有变小或没降尺寸就不替换。
    if (version.bytes >= image.bytes && version.width >= image.width && version.height >= image.height) {
      return next()
    }

    const saved = await ctx.attachments.saveImage({
      data: version.data,
      mediaType: version.mediaType,
      ...(image.name === undefined ? {} : { name: image.name }),
    })

    // 如果这次又缩了，原始文件尺寸要保留，模型才能把坐标映射回原图。
    const original = image.originalDimensions ?? { width: image.width, height: image.height }
    const replacement = {
      attachmentId: saved.attachmentId,
      mediaType: saved.mediaType,
      bytes: saved.bytes,
      width: saved.width,
      height: saved.height,
      ...(saved.name === undefined ? {} : { name: saved.name }),
      ...(saved.width === original.width && saved.height === original.height
        ? {}
        : { originalDimensions: { width: original.width, height: original.height } }),
    }

    // 先让下游 post-execute 决策跑完；如果它 block 或替换了 content，就尊重它。
    const downstream = await next()
    if (downstream.kind === 'block') return downstream
    if (Object.hasOwn(downstream, 'content') || Object.hasOwn(downstream, 'value')) return downstream
    return { ...downstream, value: { path: value.path, image: replacement } }
  })
}
```

实际 `index.js` 没有引入 `schemastery`（避免 `link:` 包的依赖解析问题），用等价的手写校验替代 `Config`；另外多了 try/catch 回退、`saved.name ?? image.name`、`attachmentId` 相同则跳过等细节。完整实现见 `plugins/read-image-compress/index.js`。

### 6.3 默认参数建议

| 配置 | 默认 | 理由 |
|---|---|---|
| `maxEdge` | 1568 | 常见视觉模型的长边 sweet spot；比 2048 省约 40% 像素 |
| `maxBytes` | 512 KiB | 低于 pi-ai 默认 1 MiB 请求上限，替换后请求层会直通，不会二次压缩 |
| `minBytes` | 128 KiB | 小图压缩收益小，避免无意义的画质损失 |
| `minResizeScale` | 0.9 | 只有 `maxEdge` 不超过长边 90% 时才缩放；避免 1600→1568 这类边际缩放反而增大字节 |
| `downscaleWebp` | true | WebP 大图也能降像素；格式不换，仍走 WebP |
| `skipGif` | true | 避免把动画 GIF 变成单帧 JPEG |

### 6.4 这个方案真正的收益

- **小 PNG（≤1 MiB）**：模型从 PNG 直通变成 JPEG/WebP，实测 714 KB → 102 KB；
- **Web UI / 磁盘**：新 `read_image` 的存储对象从 3.9 MB 变 300 KB 级；
- **降尺寸**：1568 长边把 2.06 MP 压到 1.56 MP，token/解码时间下降；
- **请求层不再重编码**：新对象 ≤ 4 MP / 1 MiB，`readImageRequest` 直通，省掉一次 PNG decode + 重编码；
- **无新依赖**：`readImageRequest` / `saveImage` 都是 `ctx.attachments` 的公开方法。

### 6.5 这个方案做不到 / 代价

- **不能强制 JPEG**：有 alpha 的图仍会被 DSH 编码成 WebP。要严格 JPEG，需要 flatten alpha；这要 `sharp` 或 Electron `nativeImage`，会引入依赖/平台限制，而且实测 JPEG 反而更大。
- **额外一次 decode+encode**：post-execute 拿到的是已入库的 ref，要重新 `readImageRequest`（读盘 + decode + encode），2 MP 图约 80–190 ms。方案 A 在入库时顺路完成，没有这次额外开销。
- **只影响新调用**：已存在的 `read_image` 结果、历史 session、旧附件不会变。
- **GIF 动画**：默认跳过。
- **坐标映射**：如果降了尺寸，必须写 `originalDimensions`；否则模型按新图坐标去原图找会偏。
- **post-execute 顺序**：要 `await next()` 后合并，避免和别的 post-execute 的 `content`/`block` 冲突；上面的写法已经处理。
- **`saveImage` 二次规范化**：如果 target 超出 `normalizedImage*` 上限，会再缩一次；默认 1568/512 KiB 不会。

---

## 7. 方案 C：配置 + hook 混合

先用方案 A 把“所有图”的入库尺寸/字节收紧；再让 hook 只处理 `read_image` 的特殊情况（比如工具读取希望更小、或用户上传希望保留原图）。通常没必要：A 已经覆盖了 90% 收益；B 的增量主要是“只影响工具、可单独调参”。

如果两者都开，hook 会看到 A 已经压过的对象，大多数会命中“已足够小”而直接跳过；逻辑上安全，但意义有限。

---

## 8. 风险与边界（按重要性排序）

1. **不要指望 JPEG 降 token。** token 由像素数决定；想省 token 必须降 `width×height`。JPEG 只降字节。
2. **大图请求体已经很小。** 3.9 MB PNG 在 pi-ai 默认下已经变成 300–400 KB WebP/JPEG；如果目标是“模型发送时间”，先测量实际 `ImageBlock` variant 的 `bytes`，不要看磁盘原图。
3. **已有附件不会自动变小。** 配置和 hook 都只影响新写入/新读取；要瘦身历史 UI 图片，需要迁移（重写附件引用/对象），代价高，暂不建议。
4. **alpha 是 WebP，不是 JPEG。** 强行 flatten 会丢透明，且实测更大；只有在 provider 不接受 WebP 时才值得。
5. **GIF 动画**会被单帧化；默认跳过。
6. **图片质量。** 文字截图对 q85 + 1.5 MP 通常可读；如果模型要读小字，先保留 2048/4 MP，或把 `maxEdge` 调到 1920。
7. **安装方式。** 当前 profile 的 `tool-plugin-manager` 在 base 里是 `disabled: true`，这个 session 没有 `plugin_manager` 工具。本次按 bundle 的落盘路径手工完成：`dsh plugin --profile web add link:<包目录>` 会把包加入依赖，并因为包声明了 `dsh.bundle.patch` 自动加入 `dsh.profile.bundles`；HMR 监听 profile manifest/patch，重排后 live 生效，无需重启。详见第 10 节。

---

## 9. 建议

> 本次已按方案 B 安装并 live 验证。方案 A 仍是后续可选的整体优化（覆盖用户上传与历史新图），不是 B 的替代。

- **如果你的目标是“整体变快/变小”**：先做方案 A，只改 `attachment-local` 的 `normalizedImageMaxPixels` / `normalizedImageMaxBytes`，重启后拿 2–3 张典型截图对比：
  - 新附件的 `mediaType` / `bytes` / `width×height`；
  - 模型请求里 `request-images` 是否直通（没有新 variant 文件）；
  - Web UI 加载时间；
  - 模型读小字是否仍清楚。
- **如果目标明确是“只改 `read_image`，不动用户上传”**：做方案 B，默认 `1568 / 512 KiB / 128 KiB`，先只启用 `maxEdge` 降尺寸，确认坐标映射和文字可读性，再决定是否对小图换格式。
- **如果你要“严格 JPEG”**：先确认 provider 是否真的不接受 WebP；如果接受，建议保持 WebP。若必须 JPEG，需要 flatten alpha，建议单独评估 `sharp` 依赖或 Electron `nativeImage`，不要把它混进第一版 hook。

---

## 10. 安装记录（2026-10-27）

- **包目录**：`F:\OneDrive\文档\deepseek-harness\default-workspace\plugins\read-image-compress`
- **bundle 名**：`@local/dsh-read-image-compress`（`link:` 依赖）
- **安装命令**：

  ```powershell
  dsh plugin --profile web add "link:F:/OneDrive/文档/deepseek-harness/default-workspace/plugins/read-image-compress"
  ```

  该命令把包加入 profile 依赖；因为包声明了 `dsh.bundle.patch`，DSH 同时把它加入 `dsh.profile.bundles`。bundle 自己的 `cordis.patch.yml` 插入唯一一行 `read-image-compress`。
- **组合校验**：`dsh --profile web --dump-config` 中只有 1 个 `- id: read-image-compress`。
- **live 验证**：对 3.97 MB、1800×1143、带 alpha 的 PNG 调用 `read_image`，结果为：
  - `image/webp`，1568×996，287,108 bytes；
  - 新对象：`C:\Users\q1325\.dsh\attachments\v1\objects\aa\aa55265acfd776b9246585f2fcacba12ada5e24e595083352517328b5c92953f`；
  - 工具信封正确显示 “downscaled from 1800x1143 … multiply coordinates by 1.15”。
  - 另外 714 KB PNG → `image/jpeg` 1230×480，104,610 bytes；1600×1450 PNG 在 `minResizeScale` 保护下保持 1600×1450，388,224 bytes（不再因边际缩放变大）。
- **基准报告**：压缩率、PSNR/SSIM、缓存命中与配置权衡见 [`read-image-compress-benchmark.md`](read-image-compress-benchmark.md)。
- **HMR**：patch/bundle 选择变化由 profile HMR 重排，当前进程已生效，无需重启；重启后 bundle 仍会加载。`link:` 包代码变更本身不会触发 HMR，需一次 profile patch/manifest 重排。
- **当前配置**（bundle patch + profile override）：`maxEdge: 1568`、`maxBytes: 524288`、`minBytes: 131072`、`minResizeScale: 0.9`、`downscaleWebp: true`、`skipGif: true`。要覆盖，可在 profile patch 加 `- id: read-image-compress` 的 config（只写想改的键也会整体替换 bundle config）。
- **回滚**：
  - UI 的 Plugins 页面取消/移除该 bundle；或
  - 从 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 和 `dependencies` 中删除 `@local/dsh-read-image-compress`，再执行 `dsh plugin --profile web remove @local/dsh-read-image-compress`；重启或触发一次 profile 重排。
  - 同时删除 `~/.dsh/profiles/web/cordis.patch.yml` 末尾的 `# read-image-compress: profile override` 段（`- id: read-image-compress`），否则 row 删除后该 override 失去目标。

---

## 11. v0.2 设置项与 UI（2026-10-28）

### 11.1 设置项

Host 的 `Config` 用了 schemastery `.volatile()`，因此会出现在 **Plugins → bundle → row → Configure** 页面；客户端模块 `client.js` 注册 `plugins.row.config`（key `@local/dsh-read-image-compress#read-image-compress`），页面用 `form.state`/`form.mutate` 直接写 profile 的 config override。

| 设置 | 默认 | 作用 |
|---|---:|---|
| `enabled` | true | 关闭 hook |
| `quality` | 85 | JPEG/WebP 质量 1–100 |
| `resolutionScale` | 1 | 相对源图长边再缩放，0.1–1；与 `maxEdge` 取更小目标 |
| `format` | auto | auto / jpeg / webp / png |
| `maxEdge` | 1568 | 长边硬上限 |
| `maxBytes` | 524288 | 字节目标；JPEG/WebP 从 `quality` 向 40 逐级降质量直到满足 |
| `minBytes` | 131072 | 不需要缩放且小于此值则跳过 |
| `minResizeScale` | 0.9 | 只有目标长边 ≤ 源长边 90% 才缩放 |
| `webpEffort` | 4 | WebP 编码强度 0–6 |
| `jpegBackground` | #ffffff | JPEG flatten alpha 的背景 |
| `cacheEntries` | 128 | 进程内 derived-ref LRU |
| `downscaleWebp` | true | 允许缩小 WebP |
| `skipGif` | true | 跳过 GIF |

### 11.2 编码器

v0.2 不再只依赖 `readImageRequest()`，而是从 DSH 安装里解析 `sharp 0.35.5 / libvips 8.18.7`：

- `process.resourcesPath/app.asar/dsh/node_modules/sharp`（Electron 主进程可读，已 probe 验证）；
- 读 `ctx.attachments.readImage(ref)` 拿源字节；
- 按 `resolutionScale` + `maxEdge` + `minResizeScale` 计算目标；
- 按 `format` 输出 JPEG/WebP/PNG；JPEG flatten alpha；
- 质量阶梯从 `quality` 递减到 40，尽量满足 `maxBytes`；
- `saveImage` 提交，内容寻址去重；
- 进程内 LRU 缓存 derived ref，避免重复编码。

若 `sharp` 解析失败，回退到 `ctx.attachments.readImageRequest()`；此时 `format`/`quality` 设置被忽略（会 warn 一次），但仍会降尺寸/压缩。

### 11.3 live 验证

| 设置 | 结果 |
|---|---|
| 默认 auto/q85/scale1/maxEdge1568 | WebP 1568×996，255,086 bytes（3.97 MB 源） |
| format=jpeg, quality=70, resolutionScale=0.75 | JPEG 1350×857，179,404 bytes |
| format=webp, quality=90, resolutionScale=0.5 | WebP 900×572，133,148 bytes |
| 恢复默认 | WebP 1568×996，255,086 bytes |

### 11.4 已知边界

- 设置页只在该 row 的 `Config` 全部为 volatile 字段时出现；已用 `ctx.settings.describe()` 验证 `ns=read-image-compress`、13 个键、`quality.meta.volatile=true`。
- 设置写 profile patch 后通过 volatile refs 在**下一次 read_image** 生效，无需重启；如果 HMR 重排，也会重新 apply。
- 客户端模块新增时，Web GUI 需要一次刷新才能加载新的 browser bundle；之后 HMR/重新打开 Plugins 页即可。
- `format=png` 不受 `quality`/`maxBytes` 约束，可能比源图更大。
- `format=jpeg` 丢 alpha；`auto` 保留 WebP alpha。
- 缓存是进程内 LRU，重启/HMR 清空；不跨 session 持久化。

---

## 附录：关键源码位置

- `@deepseek-ai/dsh-tool-fs/lib/index.js`
  - `applyReadImageTool`：约 984–1068 行
  - `IMAGE_VALUE_SCHEMA` / `formatImageReadOutput`：约 845–959 行
- `@deepseek-ai/dsh-tools/lib/index.js`
  - `postExecute`：约 3599–3627 行
  - `createSuccessResult`：约 3636–3666 行
- `@deepseek-ai/dsh-attachment-local/lib/index.js`
  - `canPassThroughNormalization`：约 212–214 行
  - `normalizeImage`：约 255–271 行
  - `readRequestImageFile` / `createRequestImage`：约 802–810、865–891 行
  - 默认 limits / config：约 895–915、973–1014 行
- `@deepseek-ai/dsh-llm-pi-ai/lib/index.js`
  - `prepareRequestImages`：约 1252–1259 行
  - `userContent` base64：约 1220–1246 行
  - 默认 request target：约 953–957、1077–1079、1379–1384 行
- `@deepseek-ai/dsh-repeat-tool-reminder/lib/index.js`
  - `tools/post-execute` 现有用法：约 2247–2260 行

## 12. v0.3 底部描述与目录迁移（2026-10-28）

### 12.1 展开底部的描述从哪来

`read_image` 的会话卡片由 `dsh-client-ui-conversation` 的 `image-card-model.ts` 构建：

- `imageMeta` 只读结果 `meta.path`，所以路径行不能改；
- 大小行由 `attachment.width/height/bytes` 经 `row.imageSize`（或 `row.imageSizeDownscaled`）渲染；
- 真正可以追加的是 `extraText`：`extraTexts(content)` 把内容里**所有非 envelope 的 text block** 拼起来，渲染在 `imageMeta` 之后的 `imageExtra` 里，也就是展开态的底部。

因此底部描述的唯一合法载体是「结果内容里的一个普通 text block」。

### 12.2 为什么不再替换 value，而是替换 content

`tools/post-execute` 的 accept 决策明确禁止同时替换 `value` 和 `content`：

```ts
if (Object.hasOwn(decision, "content") && Object.hasOwn(decision, "value"))
  throw new TypeError("tools/post-execute accept decision cannot replace both value and content");
```

替换 `value` 会走 `createSuccessResult()` → `tool.output.render()` 重新生成内容，尾部文本必然被丢掉；只替换 `content` 才能既换图又加尾部文本。`value` 保留原始引用，而模型请求、卡片画廊、历史回放用的都是 `content`，所以显示与发送都是压缩后的图。

代价：`block.value.image` 仍是原图（审计视角），`block.content` 是压缩图（呈现/模型视角）。本插件在文档里显式写明这一点。

### 12.3 内容重建

`compressedContent()` 做三件事：

1. 用 `IMAGE_ENVELOPE` 正则定位 envelope text block，按新尺寸重建（含 `compressed from WxH px, N bytes; multiply coordinates by x` 的坐标提示）；
2. 把 image block 的 `attachment` 换成新提交的引用，且**不再带 `originalDimensions`**，避免内置大小行与底部描述重复；
3. 末尾追加描述 text block。

「原图」的事实来源：`originalDimensions`（入库规范化前）优先，否则用附件栅格；字节数优先 `stat(meta.path)` 取磁盘真实大小（入库规范化会重新编码，`bytes` 只是规范化后的字节数），stat 失败时退回附件字节。

### 12.4 描述格式

```text
原图: 3200×2000 · 2.05 MB · PNG | 压缩后: 1568×980 · 43.9 KB · JPEG | 压缩比: 47.9×（体积 ↓97.9%，长边 49%）
```

- `formatBytes`：B/KB/MB/GB 自适应，≥100 取整、≥10 一位、其余两位；
- `压缩比` = 原字节 / 压缩字节，括号里给体积变化与长边比例；
- `summaryMode: compact` → `3200×2000 2.05 MB → 1568×980 43.9 KB · 47.9×`；
- `summaryMode: off` → 不追加（但 envelope 仍按新图重建）；
- `summaryLanguage: zh | en` 切换标签。

### 12.5 设置项

`summaryMode`、`summaryLanguage` 均为 `.volatile()`，Plugins → Configure 新增「结果描述」一节，两个下拉框；写入走 `form.mutate`，下一次 `read_image` 立即生效。

### 12.6 目录迁移

插件源码从工作区（OneDrive）迁到：

```text
F:\dev\github\dsh-read-image-compress
```

profile 依赖改为 `link:F:/dev/github/dsh-read-image-compress`，`node_modules/@local/dsh-read-image-compress` junction 指向新目录。运行中的 Host 仍持有旧路径的模块实例，重新组合后（重启 DSH 或在 Plugins 页触发一次重载）才会加载新代码。

## 13. 设置入口挪到 bundle 页（2026-10-28）

### 13.1 原来的位置为什么是“二级界面”

DSH 插件页的结构：

- `Plugins` 列表 → 点 bundle → bundle 页（图标、标题、一行简介、`plugins.bundle.config` 区、组件行列表、来源）。
- 组件行右侧的箭头 → 行配置页（`plugins.row.config`，`view: 'page'`），再里面才是表单。

我们的 v0.2/v0.3 把表单注册在 `plugins.row.config`，所以必须点两次才看到设置。

### 13.2 改成 `plugins.bundle.config`

参考本地安装的 `@moguiyu/dsh-tavily`：它只注册 `plugins.bundle.config`（key 为包名），bundle 页在简介下方直接渲染设置卡片。

`plugins.bundle.config` 的渲染点是 `PackageDetail`：

```js
configured ? section(renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })) : null
```

`configured` 来自 `ledger.bundles.has(pkg.name)`，而 ledger 是槽位注册表的投影，所以只要注册 key 等于包名，区块就出现，不需要行级配置页。

### 13.3 表单从哪来

bundle 槽位不传 `form`（行配置页才传），但客户端服务 `ctx.configForms` 暴露同一份文档：

```js
const form = ctx.configForms.get('read-image-compress')   // 行 id = 设置命名空间
form.getSnapshot()   // { status, value, base, user, revision, writable }
form.subscribe(fn)
form.mutate([{ op: 'set', path: [key], value }], revision)
```

这与插件页内部 `formFor(id)` 用的是同一个控制器实例，所以：

- 同一命名空间只有一个写队列，bundle 卡片和行页面不会互相覆盖；
- 写作携带 revision 栅栏，冲突时宿主拒绝并触发恢复读；
- 客户端仍先做一次 schema 校验，宿主再做完整校验。

卡片用 `ctx.configForms.whileServed(['read-image-compress'], register)` 注册，命名空间不被服务时整张卡片消失，不会留空壳。

### 13.4 变更

- 注册槽位：`plugins.bundle.config`，`key/id = @local/dsh-read-image-compress`；
- 移除 `plugins.row.config` 注册（行右侧箭头随之消失，设置只有一处）；
- 字段分「常用设置」（启用、质量、格式、缩放、描述、描述语言）与「高级设置」（长边、字节目标、跳过阈值、最小缩放、缓存、WebP、GIF）；
- 组件改为直接订阅 form 快照，保存仍是整表一次原子 mutate。
