---
title: read_image 结果压缩：设计与实现
description: 说明 DSH 插件如何在 tools/post-execute 拦截 read_image 结果，用 Sharp 降低分辨率与码率，并在图片下方追加原图、压缩后、压缩比与 token 估算的底部描述。
ms.date: 2026-10-31
ms.topic: concept-article
---

# read_image 结果压缩：设计与实现

`dsh-read-image-compress` 是 DSH 的一个 bundle。宿主侧监听 `tools/post-execute`，在 `read_image` 返回后替换图片引用，用 Sharp 降低分辨率与码率，并在图片下方追加一行对比描述。当前版本 0.15.0，验证环境为 DSH `0.2.1-rc.3`（`D:\SOFT\tools\dsh`）与 `web` profile。

插件不改工具实现，也不需要 fork `dsh-tool-fs`。`read_image` 走普通工具管线，替换结果属于官方扩展点。

插件能省下的量取决于宿主已经做了什么。DSH 已经在附件入库与请求投影两层做 WebP 与 JPEG 压缩。对 4 MB 的截图，模型实际收到的通常只有 300–400 KB，不是 4 MB。真正还没被压缩的，是低于 1 MiB 的 PNG 直通，以及 Web UI 与磁盘上的 4 MB 原图。插件的收益主要落在这三处，而不是再压一次 JPG。

## 工作原理

当前安装里 `read_image` 的实现位于 `@deepseek-ai/dsh-tool-fs/lib/index.js` 的 `applyReadImageTool`（约 984–1068 行）。一次读取按以下顺序完成：

1. 校验扩展名与文件签名，确认是 PNG、JPEG、WebP 或 GIF。
2. 用当前 route 的 provider 与 model 检查是否声明 `image` 输入。
3. 由 `ctx.fs.readBytes` 读出源文件字节，上限由 `maxImageBytes` 决定。
4. 调用 `ctx.attachments.saveImage({ data, mediaType, name })`：完整 decode；按 `attachment-local` 的 normalization policy 决定原样直通还是重编码；返回内容寻址的 `attachmentId` 与实际存储的 `mediaType`、`width`、`height`、`bytes`。
5. 工具返回结构化 value。
6. 工具定义的 `output.render` 把 value 变成模型看到的两块内容：一段文本信封（包裹 `<path>`、`<type>`、`<content>` 三个标签）以及一个 `ImageBlock`。`ImageBlock` 只带 `attachment` 引用，不带 base64。

第 5 步的 value 形状如下：

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

所以 hook 的切入点不是改字节，而是在 value 提交前换掉其中的 `image` 引用。

## 工具结果模型

`@deepseek-ai/dsh-tools` 的 README 与实现把一次工具调用固定成一条管线，替换结果只能在 `tools/post-execute` 阶段完成。

### 工具调用管线

```text
tools/pre-execute  (allow/deny/ask)
  → guards
  → tools/execute  (around dispatch)
  → tools/post-execute  (inspect / replace)
  → definition.finalizeContent
  → tools/result  (observe only)
```

关键代码在 `dsh-tools/lib/index.js`：

- `postExecute()`（约 3599–3627 行）：
  - `tools/post-execute` 返回 `{ kind: 'accept', value }` 时，registry 调用 `createSuccessResult(exec, tool, value)`；
  - 返回 `{ kind: 'accept', content }` 时只替换内容；
  - `value` 与 `content` 不能同时替换；
  - `block` 会变成 `isError`。
- `createSuccessResult()`（约 3636–3666 行）：
  - `snapshotToolValue` → `validateJsonSchemaValue(tool.output.schema, …)`；
  - `tool.output.render(exec.arguments, value)` 重新生成 content；
  - 因此替换后的 value 必须严格符合 `read_image` 的 output schema，渲染会自动跟着新 value 走。

### 扩展点的依据

`dsh-tools` README 第 89、109、141 行明确写了 `tools/post-execute` 可以 "inspect or replace the result"。`dsh-repeat-tool-reminder` 已经用同样的写法在线上运行：`ctx.on('tools/post-execute', async (exec, result, next) => …)`。这说明扩展点不是纸面设计，一个 host-only 的 Cordis 插件就能 hook，不需要 fork `dsh-tool-fs`。

## DSH 内置的两级压缩

判断插件能省多少之前，先看清宿主已经做了哪两级压缩。

### 附件入库规范化

`normalizeImage()`（约 255–271 行）与 `canPassThroughNormalization()`（约 212–214 行）决定源图是直通还是重编码。

源图若同时满足以下全部条件，字节原样直通：

- 非 GIF、非动画；
- 不带 EXIF、XMP、ICC、评论等元数据；
- 8-bit、sRGB；
- `bytes <= normalizedImageMaxBytes`，默认 4 MiB；
- `width*height <= normalizedImageMaxPixels`，默认 4,194,304（约 4.2 MP）；
- 长边 `<= normalizedImageMaxDimension`，默认 8192。

否则重编码。编码器按 `hasAlpha` 选格式：有 alpha 用 WebP（`effort: 0`），无 alpha 用 JPEG；质量阶梯 85 → 75 → 60，取第一个满足 `maxBytes` 的，全都不满足时取最小的那个。默认 policy 见 `dsh-attachment-local/lib/index.js` 约 895–915、973–1014 行。

> [!NOTE]
> 一张 3.9 MB、1800×1143 的 PNG 截图满足 `3.9 MB < 4 MiB` 且 `2.06 MP < 4.2 MP`，会被原样存成 PNG。磁盘与 Web UI 拿到的就是这 3.9 MB。

### 请求投影

`dsh-llm-pi-ai` 的 `prepareRequestImages()`（约 1252–1259 行）对每个 `ImageAttachmentRef` 调一次 `readImageRequest`：

```js
attachments.readImageRequest(ref, requestImageTarget(ref, budget), signal)
```

`dsh-attachment-local` 的 `readRequestImageFile()` 与 `createRequestImage()`（约 802–810、865–891 行）按以下规则处理：

- 若 `target.width >= ref.width && target.height >= ref.height && ref.bytes <= target.maxBytes`，原样直通；
- 否则重编码，同样按 alpha 选 WebP 或 JPEG，质量阶梯 85/75/60；
- 结果写入 `attachments/v1/request-images/…` 缓存，variant id 由 attachment、target 与 encoder 共同决定；
- 最终 `userContent()`（约 1220–1246 行）把 `version.data` 转成 base64，`mimeType` 用 `version.mediaType` 发给模型。

base64 会让线上字节再膨胀约 4/3。下表里的“发给模型”是编码后的原图字节，实际 HTTP body 约乘以 1.33。

`dsh-llm-pi-ai` 的默认 target 有三项：

- `requestImagePixelBudget`：`2048 × 2048 = 4,194,304`；
- `requestImageMaxBytes`：1 MiB；
- `maxRequestImageBytes`：整个请求体的 base64 上限，20 MiB。

在这些默认值下，存储层与请求层的差别如下：

| 源图（存储层） | 实际发给模型 | 触发原因 |
|---|---|---|
| 3.9 MB PNG，1800×1143，有 alpha | WebP ≈ 356–364 KB | 尺寸没超 4.2 MP，但字节超过 1 MiB，触发重编码 |
| 3.9 MB PNG，1800×1143，无 alpha | JPEG ≈ 405–414 KB | 同上，走 JPEG q85 |
| 714 KB PNG，1230×480 | PNG 714 KB，直通 | 尺寸与字节都没超 target，不重编码 |
| 400 KB PNG，小图 | PNG 400 KB，直通 | 同上 |

### 收益归属

- 对大图，模型收到的已经不是 4 MB，而是 300–400 KB。再 hook 一次 JPG，请求体几乎不变。
- 对小于 1 MiB 的 PNG，模型收到的仍是 PNG。这类图才是 hook 能明显减少发送字节的地方。
- JPEG 不减少 token。token 由像素尺寸决定；要省 token 与解码时间，必须降 `width×height`，不是换编码格式。
- Web UI 与磁盘始终拿存储层对象。对 3.9 MB PNG，UI 仍要传 3.9 MB，浏览器仍要解 PNG。这是本地发送与解码的大头。

## 插件实现

### 包结构与职责

Host-only bundle，无构建，也没有 `sharp` 依赖：

```text
read-image-compress/
  package.json
  cordis.patch.yml
  index.js
  locale/en.json
  locale/zh.json
  icon.svg
```

`index.js` 的主干是监听 `tools/post-execute`，只处理 `read_image`，把图片引用换成更小的引用；预览路由也在同一个文件里注册。

### 编码器实现

编码器从 DSH 安装里解析 `sharp 0.35.5 / libvips 8.18.7`，不经过 `readImageRequest()`：

- `process.resourcesPath/app.asar/dsh/node_modules/sharp`（Electron 主进程可读，已 probe 验证）；
- 读 `ctx.attachments.readImage(ref)` 拿源字节；
- 按 `resolutionScale`、`maxEdge`、`minResizeScale` 计算目标；
- 按 `format` 输出 JPEG、WebP 或 PNG，JPEG 会 flatten alpha；
- 质量阶梯从 `quality` 递减到 40，尽量满足 `maxBytes`；
- `saveImage` 提交，内容寻址去重；
- 进程内 LRU 缓存 derived ref，避免重复编码。

若 Sharp 解析失败，回退到 `ctx.attachments.readImageRequest()`。此时 `format` 与 `quality` 设置被忽略（会 warn 一次），但仍会降尺寸与压缩。

### 默认参数

`maxEdge` 用 1568，是因为常见视觉模型的长边最优区间就在这一档；其余默认值要配合宿主的 1 MiB 请求上限：

| 配置 | 默认 | 理由 |
|---|---:|---|
| `maxEdge` | 1568 | 常见视觉模型的长边最优区间；比 2048 省约 40% 像素 |
| `maxBytes` | 512 KiB | 低于 pi-ai 默认的 1 MiB 请求上限，替换后请求层会直通，不会二次压缩 |
| `minBytes` | 128 KiB | 小图压缩收益小，避免无意义的画质损失 |
| `minResizeScale` | 0.9 | 只有 `maxEdge` 不超过长边 90% 时才缩放；避免 1600→1568 这类边际缩放反而增大字节 |
| `downscaleWebp` | true | WebP 大图也能降像素；格式不换，仍走 WebP |
| `skipGif` | true | 避免把动画 GIF 变成单帧 JPEG |

## 分辨率与码率两种模式

降分辨率与降码率是两件事：像素决定 token 与解码量，码率只决定上传体积。管线把它们拆成两个独立复选框，任意组合都成立。

### 四种组合

| 分辨率压缩 | 码率压缩 | 行为 |
|---|---|---|
| 开 | 开 | 降像素，再沿质量阶梯压到 `maxBytes`。默认，体积最小。 |
| 开 | 关 | 只降像素。`format: auto` 时沿用源编码（PNG 仍无损、JPEG 与 WebP 各自不变），阶梯从 100 级、4:4:4 色度开始，只有当 100 级会让结果比原图更大时才往下走，`maxBytes` 完全不参与。 |
| 关 | 开 | 一个像素都不动，只把原图沿阶梯压进 `maxBytes`。适合细节必须留、但文件太大的场景。 |
| 关 | 关 | 什么都不做，`read_image` 原样入库；卡片顶部给出提示。 |

### 保真档的字节预算

把码率关掉只写 `quality: 100` 有一个反直觉的后果：一张 3200×2000 JPEG q78（539 KB）降到 1568×980 后，q100 加 4:4:4 反而要 600 KB 以上，文件比原图更大。所以关掉码率时的保真档，预算不是 `maxBytes`（那是码率旋钮），而是源文件字节数：从 100 级往下走，只走到不比原图大为止。实测：

| 源 | 目标 | 结果 |
|---|---|---|
| 12.2 MB PNG（噪声很重） | 1568×980 | 2.02 MB PNG，与直接 resize 逐像素相同 |
| 7.9 MB JPEG q100 4:4:4 | 1568×980 | 1.29 MB，停在 100 级（4:4:4 生效） |
| 539 KB JPEG q78 | 1568×980 | 133 KB，停在 90 级，比源更清晰且更小 |

于是保真档的承诺可以精确表述为：像素一定只减不增；JPEG 与 WebP 的字节一定不超过原图。PNG 无法用质量换体积，它走单趟无损编码（`compressionLevel: 9`），体积随像素等比下降。

### 实现要点

- `targetFor()` 在 `compressResolution === false` 时直接返回原尺寸 `{ resize: false }`，下游全部按无需缩放处理。
- `formatFor(hasAlpha, options, sourceMediaType)`：保真档下 `auto` 返回源编码，避免不压码率却把 PNG 转成 JPEG。
- `encodePlan(options, sourceBytes)` 统一给出 `{ qualities, budget }`：码率档给 `qualitySteps(quality)` 与 `maxBytes`，保真档给 `qualitySteps(100)` 与 `sourceBytes - 1`。`encodeBest()` 是两边共用的编码器，hook 与设置页预览因此走同一份逻辑，预览不再各写一份阶梯。
- `shouldSkip()`：没有缩放时，保真档只在显式改格式时才有活干，否则直接跳过；码率档保留原来的 `minBytes` 与同格式且已达标判断。
- 缓存键加入两个开关，否则先关后开拿到的是旧档位的结果。
- 底部描述只输出非零差值（`|delta| < 0.05%` 不写），否则只压码率会冒出分辨率 ↓0.0% 的噪声。
- 设置卡片：两个复选框放在各自分组标题里（`h4 > label > input`），关掉时该组 `opacity: .45` 变灰但仍可编辑，可以先调好参数再打开；码率关掉时格式栏补一行说明“自动沿用源编码，PNG 仍是无损”；两个都关时顶部出现警示行。

### 验证覆盖

`ric-test-modes.mjs` 用真实的 `sharp`（libvips 8.18.7，通过 asar 形状的 junction 让插件解析到同一份构建）跑 8 个组合，断言像素、编码格式、字节上限、PNG 逐像素一致。`ric-test-client.mjs` 断言两个复选框的位置、变灰与提示文案。`ric-test-host.mjs` 覆盖 Sharp 不可用时的 fallback 路径。

## 结果描述

### 描述载体

`read_image` 的会话卡片由 `dsh-client-ui-conversation` 的 `image-card-model.ts` 构建：

- `imageMeta` 只读结果 `meta.path`，所以路径行不能改；
- 大小行由 `attachment.width/height/bytes` 经 `row.imageSize`（或 `row.imageSizeDownscaled`）渲染；
- 真正可以追加的是 `extraText`：`extraTexts(content)` 把内容里所有非 envelope 的 text block 拼起来，渲染在 `imageMeta` 之后的 `imageExtra` 里，也就是展开态的底部。

因此底部描述的唯一合法载体，是结果内容里的一个普通 text block。

### 替换内容而非结果值

`tools/post-execute` 的 accept 决策明确禁止同时替换 `value` 与 `content`：

```ts
if (Object.hasOwn(decision, "content") && Object.hasOwn(decision, "value"))
  throw new TypeError("tools/post-execute accept decision cannot replace both value and content");
```

替换 `value` 会走 `createSuccessResult()` → `tool.output.render()` 重新生成内容，尾部文本必然被丢掉；只替换 `content` 才能既换图又加尾部文本。`value` 保留原始引用，而模型请求、卡片画廊、历史回放用的都是 `content`，所以显示与发送都是压缩后的图。

> [!NOTE]
> `block.value.image` 仍是原图（审计视角），`block.content` 是压缩图（呈现与模型视角）。

### 内容重建

`compressedContent()` 只做两件事：

1. 把 image block 的 `attachment` 换成新提交的引用，仍旧不带 `originalDimensions`，避免与内置大小行重复。
2. 末尾追加描述 text block。

envelope（`<path>`、`<type>`、`<content>`、`</content>`）整块原样透传，一个字都不改。取舍是刻意的：DSH 的 `output.render()` 只认 `value`，走 content 替换就没有可靠途径重算这行文字。与其复刻或改写一个不属于插件的格式，不如让它保持工具自己写的原样，压缩事实全部交给底部描述。代价是模型在 envelope 里读到的是压缩前的尺寸与字节数，底部描述里写明压缩后的事实与压缩比。

“原图”的事实来源按优先级取三处：

- 尺寸：`originalDimensions`（入库规范化前）优先，否则用附件栅格。
- 字节：优先用 `stat(meta.path)` 取磁盘真实大小，因为入库规范化会重新编码、`bytes` 只是规范化后的字节数；stat 失败时退回附件字节。
- 格式：读磁盘扩展名，因为规范化可能把 PNG 存成 JPEG，实测 3200×2000 的 PNG 在附件里就是 `image/jpeg`。

### 描述格式

```text
原图: 3200×2000 · 2.05 MB · PNG | 压缩后: 1568×980 · 43.9 KB · JPEG | 压缩比: 47.9×（体积 ↓97.9%，分辨率 ↓51.0%）
```

- `formatBytes`：B、KB、MB、GB 自适应，大于等于 100 取整，大于等于 10 保留一位，其余保留两位；
- `压缩比` 是原字节除以压缩字节，括号里给体积变化与分辨率降幅（1 − 压缩后长边 ÷ 原长边），与体积同为降了多少的口径；
- `summaryMode: compact` 输出 `3200×2000 2.05 MB → 1568×980 43.9 KB · 47.9×`；
- `summaryMode: off` 不追加，但 envelope 仍按新图重建；
- `summaryLanguage: zh | en` 切换标签；
- `summaryLine()` 末尾追加 `| ≈N tokens`（compact 为 `· ≈N tokens`），`off` 不显示。放在最后而不是压缩比括号里，因为它是独立的一档信息。

### 描述设置项

`summaryMode` 与 `summaryLanguage` 都是 `.volatile()`，设置卡片的「结果描述」组有两个下拉框；写入走 `form.mutate`，下一次 `read_image` 立即生效。

## 像素预算与图片 token

### 像素预算

provider 按像素给图片计费：小于约 544×544 的图会被放大，更大的图会被缩到总像素约等于 1300×1300，单张上限约 1024 tokens。只限长边不够：1568×1568 的正方形有 2.46 MP，超过 1300×1300 的 1.69 MP，却仍按同一上限计费，只是白白多出字节与首帧解码时间。

`targetFor()` 取四个上界的最小值：

```text
scale = min(1, resolutionScale, maxEdge / 长边, sqrt(maxPixels / 面积))
```

- `maxPixels` 默认 `1690000`（= 1300×1300，正好是 provider 自己的目标），提交的图不会超过它愿意保留的像素；
- 该字段进缓存键，改设置后不会命中旧结果；
- 设置卡片「高级设置」里的「像素上限（百万）」默认 1.69。

实测：3000×3000、3 MB 的正方形变成 1300×1300（分辨率 ↓56.7%）；3200×2600 这类更接近正方形的图先命中像素预算，按公式 `sqrt(1690000 / 8320000) ≈ 0.451` 得到约 1442×1172。长边与像素预算谁更紧就听谁的，两者都只是上界。

### 官方计算器口径

`api-docs.deepseek.com` 的 `Image Token Calculator` 不是按面积线性折算，而是一个 patch 网格模型：

- patch 为 14 px，3× 下采样，每个 token 覆盖 42×42 px；
- 单图上限 1024 tokens；小于 544²（295,936 px）的图先按比例放大到该面积；
- 先 pad 到 14 的整数倍，再算 `nLlmH × (nLlmW + 1) + 2`；超上限时用 `solveResizeRatio` 求缩放比例，再迭代到收敛。

实现从官网 bundle 里逐行复刻（阈值、取整、迭代上限 10 次都一致），并对照原实现验证：

| 尺寸 | 官方计费（cap 1024） | 不封顶 |
|---|---:|---:|
| 1024×1024 | 652 | 652 |
| 1568×980 | 938 | 938 |
| 1300×1300 | 994 | 994 |
| 544×544 | 184 | 184 |
| 1920×1080 | 968 | 1224 |
| 2048×1280 | 962 | 1552 |
| 3200×2000 | 962 | 3746 |
| 5000×5000 | 994 | 14522 |

展示策略：底部与预览卡片显示不封顶值，说明超了多少；触顶时只标注服务端可能二次压缩，不写具体计费值。极端长宽比在求解器里可能抛错，此时退回按面积折算的估算，保证底部描述不会因为一次估算失败而中断。

### 触顶标注

估算结果达到或超过 1024 tokens 时，底部描述追加标注，分两种情况：

- `tokens > 1024`：`（大于 DeepSeek 单张 1024 tokens 上限，服务端可能二次压缩）`；
- `tokens == 1024`：`（已达 DeepSeek 单张 1024 tokens 上限）`。

这样既能看到这张图超了多少，也说明服务端会二次压缩、实际计费仍不超过 1024。强调 DeepSeek，是因为 1300² 与 1024 都是 DeepSeek 的口径；换模型后上限与换算可能完全不同，这个数字只作参考，不能当成通用报价。英文标签是 `(at the DeepSeek 1024-token cap)`。

### 口径提示

设置卡片网格下方固定一行：`token 按 DeepSeek 口径估算（1300×1300 ≈ 1024，超出即封顶）；其他模型的上限与算法可能不同。` 每张卡片在 `capped` 时把上限标注附在 tokens 后面，与底部描述一致。

## 设置卡片

设置卡片在 **Plugins** 的 bundle 页，位于包简介下方，不经过行级配置页。同一批字段也可以写进 `cordis.patch.yml`。

### 字段与分组

bundle 槽位不传 `form`，但客户端服务 `ctx.configForms` 暴露同一份配置文档：

```js
const form = ctx.configForms.get('read-image-compress')   // 行 id = 设置命名空间
form.getSnapshot()   // { status, value, base, user, revision, writable }
form.subscribe(fn)
form.mutate([{ op: 'set', path: [key], value }], revision)
```

这与插件页内部 `formFor(id)` 用的是同一个控制器实例，因此同一命名空间只有一个写队列，不会出现两处互相覆盖；写作携带 revision 栅栏，冲突时宿主拒绝并触发恢复读；客户端先做一次 schema 校验，宿主再做完整校验。卡片用 `ctx.configForms.whileServed(['read-image-compress'], register)` 注册，命名空间不被服务时整张卡片消失，不会留空壳。

字段分两组：常用设置（启用、质量、格式、缩放、描述、描述语言）与高级设置（长边、字节目标、跳过阈值、最小缩放、缓存、WebP、GIF）。组件直接订阅 form 快照，保存仍是整表一次原子 mutate。设置项与默认值如下：

| 设置 | 默认 | 作用 |
|---|---:|---|
| `enabled` | true | 关闭 hook |
| `compressResolution` | true | 分辨率压缩开关；关闭时一个像素都不动 |
| `compressBitrate` | true | 码率压缩开关；关闭时沿用源编码、质量 100，只降到不超过源字节 |
| `quality` | 85 | JPEG 与 WebP 质量，1–100 |
| `resolutionScale` | 1 | 相对源图长边再缩放，0.1–1；与 `maxEdge` 取更小目标 |
| `format` | auto | auto、jpeg、webp、png |
| `maxEdge` | 1568 | 长边硬上限 |
| `maxPixels` | 1690000 | 总像素上限，约 1300×1300；与长边相比谁更紧听谁的 |
| `maxBytes` | 524288 | 字节目标；JPEG 与 WebP 从 `quality` 向 40 逐级降质量直到满足 |
| `minBytes` | 131072 | 不需要缩放且小于此值则跳过 |
| `minResizeScale` | 0.9 | 只有目标长边不超过源长边 90% 才缩放 |
| `webpEffort` | 4 | WebP 编码强度，0–6 |
| `jpegBackground` | `#ffffff` | JPEG flatten alpha 的背景 |
| `cacheEntries` | 128 | 进程内 derived-ref LRU |
| `downscaleWebp` | true | 允许缩小 WebP |
| `skipGif` | true | 跳过 GIF |
| `summaryMode` | detailed | 底部描述：detailed、compact、off |
| `summaryLanguage` | zh | 底部描述语言：zh、en |

### 写入与生效

- 设置卡片只在该行的 `Config` 全部由 schemastery `.volatile()` 字段组成时出现，命名空间为 `read-image-compress`，每个键都带 `meta.volatile=true`。
- 设置写 profile patch 后，通过 volatile refs 在下一次 `read_image` 生效，无需重启；如果 HMR 重排，也会重新 apply。
- 客户端模块新增时，Web GUI 需要一次刷新才能加载新的 browser bundle；之后 HMR 或重新打开 **Plugins** 页即可。

## 预览与全屏查看

### 三个变体

预览把三种真实编码结果并排显示：

| 变体 | 含义 |
|---|---|
| 原图 | 示例图 3200×2000（JPEG q92） |
| 原生压缩 | 不带本插件时链路给出的结果：fit 2048²，JPEG 质量阶梯到 1 MiB |
| 插件压缩 | 按当前草稿的 `maxEdge`、`maxPixels`、`resolutionScale`、`format`、`quality` 编码 |

### Host 侧编码

浏览器 canvas 的 JPEG 与 WebP 编码器和 libvips 不同，尺寸、字节、画质都会与真实提交对不上；预览的意义就是所见即所得。所以由 Host 用同一套 Sharp 编码，客户端只负责取回与渲染。

### 路由与缓存

沿用 `@moguiyu/dsh-tavily` 的形态：

```js
ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/read-image-compress/preview', handler }))
```

- `POST` 草稿 JSON（不超过 16 KB），返回 `{ ok, sample, variants[] }`；
- 每个变体带真实宽高、字节、估算 token，以及 560 px 缩略图的 data URL；
- 结果按草稿 JSON 做 LRU（6 条），缩略图只用于显示，统计值取真实编码。

不能在 `apply()` 里直接取 `ctx.get('webServer')`：插件的 inject 只有 `attachments`，组合顺序靠前时 webServer 尚未就绪，启动日志会留下 `Preview route not registered: sharp or webServer is unavailable`。路由改用 `ctx.inject(['webServer'], (webCtx) => …)`，等服务挂载后再注册，这也是仓库里 `dsh-api-remote-access`、`dsh-client-modules` 的写法。

### 示例图与上传

`preview/sample.png` 是仓库里的一张真实照片，但不进 npm 包。开发目录里直接读本地文件；安装后的副本按 `package.json` 的 `repository` 拼出两条 GitHub 路由（jsDelivr CDN 与 `raw.githubusercontent.com`）并让它们**同时**发起请求，先到的字节胜出，输的那条立刻中止——一条被墙而挂起时不会拖住另一条。两条都不在窗口内响应时改用 Bing 当日壁纸，因此离线或受限网络下，预览仍有一张真实照片，而不是空框。Host 首次取到时把它 cover 到 3200×2000、JPEG q92 作为原图并缓存在进程内；全部来源失败后 60 秒内不再重试，避免每次改设置都等满超时窗口。卡片上方的标签写明当前来源：本地文件、GitHub 仓库或 Bing 每日壁纸。

来源选择集中在 `preview-sample.js`。`parseRepository` 兼容 `repository` 的常见写法（`git+https`、`git@…`、`github:owner/repo`、`owner/repo`），`githubSampleRoutes` 生成两条路由，`bingImageUrl` 从 `HPImageArchive` 的响应里取当日壁纸。GitHub 两条路由共享一个 3.5 秒窗口，Bing 另有 6 秒窗口（先查 `zh-CN` 的归档，再查默认市场；壁纸先取 UHD，再退 1920×1080）。`test/preview-sample.test.mjs` 用注入的 fetch 覆盖成功、逐级回退、挂起路由不拖慢胜者、全部失败与窗口耗尽五种路径。

自定义上传走第二个路由 `POST /api/read-image-compress/source`。它接收原始图片字节，用 Sharp 读元数据校验（`limitInputPixels = 64e6`，body 不超过 16 MiB），返回 `{ id, width, height, bytes }`。上传字节留在内存（最多 4 张，LRU），不落盘；`preview` 请求带 `sourceId` 时用它作为起点，否则用示例图。卡片上方有文件输入与**恢复示例图**，上传后三列立刻按新图重算。不用浏览器 canvas 的原因与上面一致：编码器不同，数字会对不上真实提交；上传只是换了输入，编码仍然在 Host 的 Sharp 上跑。示例图不可用时接口返回 `503` 与 `sample-unavailable`，卡片改为提示上传一张照片，而不是把「接口不可用」摆出来。

### 全屏查看

选择缩略图即可打开全屏遮罩，显示该变体的真实尺寸、字节与 tokens；在遮罩外按下或按 `Esc` 关闭，三个变体使用同一裁剪。

- 每个变体的真实编码字节经 `GET /api/read-image-compress/preview/image?key=…&variant=…` 原样流式返回；
- 全屏遮罩铺满视口，默认适应窗口：以视口（窗口宽高减 padding 与标题栏）为基准算 `fitScale = min(boxW/imgW, boxH/imgH)`，不限制放大，所以 931 px 的输出和 3200 px 的原图会铺到同样高，能真正同尺寸对比；
- 可切到 1:1 原始像素，此时浏览器不再缩放，压缩块效应能直接看出来；
- 滚轮缩放以 fit 为 1×，范围 0.2×–8×；`−` 与 `+` 按 1.25 步进，`1:1` 直接换算到原始像素（`zoom = 1 / fitScale`）；
- 放大后可按住左键拖拽平移：按下时记录滚动位置，移动事件挂在 window 上（指针移出图片也继续），松开结束；拖拽超过 3 px 会吞掉该次 `click` 事件，避免误关遮罩；
- 顶部可在三个变体之间切换，切换保留当前缩放，便于同倍率对比；`Esc` 关闭；
- 图片按显式像素宽度渲染，超出即出现滚动条，不再被浏览器缩放掩盖细节；
- `previewViews` 保留最近 6 组变体字节（每组约 2–3 MB），随预览缓存一起淘汰。

### 客户端行为

草稿变化后 300 ms 去抖发起请求，`AbortController` 取消上一次；失败时显示提示而不是空白；`summaryMode: off` 在网格下方单独注明，预览仍展示压缩效果，只是展开时不会有那行文字。

原生压缩是近似：只建模请求投影（2048²、1 MiB、85-75-60），不重复附件入库规范化的画质损失；放大后的示例图细节偏软，画质差异主要由分辨率决定，但尺寸、字节与 token 都是真实编码值。

## 安装与验证

### 安装步骤

- 包目录：`F:\dev\github\dsh-read-image-compress`
- bundle 名：`dsh-read-image-compress`

安装命令（发布后从 registry 安装，或从工作副本以 `link:` 安装）：

```powershell
dsh plugin --profile web add dsh-read-image-compress
dsh plugin --profile web add "link:F:/dev/github/dsh-read-image-compress"
```

该命令把包加入 profile 依赖；因为包声明了 `dsh.bundle.patch`，DSH 同时把它加入 `dsh.profile.bundles`。bundle 自己的 `cordis.patch.yml` 插入唯一一行 `read-image-compress`，其 `name` 与包名逐字相同——loader 以 profile 根目录为锚点解析这个名字，包名带 scope 时 `name` 也必须带 scope。

组合校验：`dsh --profile web --dump-config` 中只有 1 个 `- id: read-image-compress`。

### 验证记录

对 3.97 MB、1800×1143、带 alpha 的 PNG 调用 `read_image`，默认设置与改设置后的输出如下：

| 设置 | 结果 |
|---|---|
| 默认 auto、q85、scale=1、maxEdge=1568 | WebP 1568×996，255,086 bytes |
| `format: jpeg`，`quality: 70`，`resolutionScale: 0.75` | JPEG 1350×857，179,404 bytes |
| `format: webp`，`quality: 90`，`resolutionScale: 0.5` | WebP 900×572，133,148 bytes |

另外，714 KB PNG 输出 `image/jpeg` 1230×480、104,610 bytes；1600×1450 PNG 在 `minResizeScale` 保护下保持 1600×1450、388,224 bytes。

压缩率、PSNR、SSIM、缓存命中与配置权衡见 [压缩基准](benchmark.md)。

### 热更新与重启

patch 与 bundle 的选择变化由 profile HMR 重排，当前进程即生效，无需重启；重启后 bundle 仍会加载。`link:` 包代码变更本身不会触发 HMR，需要一次 profile patch 或 manifest 重排。

### 当前配置

bundle patch 加 profile override 后的关键值：两个模式开关都开，`quality: 85`、`format: auto`、`maxEdge: 1568`、`maxPixels: 1690000`、`maxBytes: 524288`、`summaryMode: detailed`、`summaryLanguage: zh`。与 schema 默认值不同的只有 `cacheEntries`：bundle patch 里是 64，默认 128；其余键取上文设置项表里的默认值。

> [!IMPORTANT]
> 在 profile patch 里加 `- id: read-image-compress` 的 config 覆盖时，只写想改的键也会整体替换 bundle 的 config。

### 回滚步骤

1. 在 **Plugins** 页面取消或移除该 bundle。
2. 或者从 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 与 `dependencies` 中删除 `dsh-read-image-compress`，执行 `dsh plugin --profile web remove dsh-read-image-compress`，再重启或触发一次 profile 重排。
3. 采用第 2 种方式时，同时删除 `~/.dsh/profiles/web/cordis.patch.yml` 末尾的 `# read-image-compress: profile override` 段（`- id: read-image-compress`），否则 row 删除后该 override 失去目标。

## 已知限制

### 收益边界

1. 不要指望 JPEG 降 token。token 由像素数决定；想省 token 必须降 `width×height`。JPEG 只降字节。
2. 大图请求体已经很小。3.9 MB PNG 在 pi-ai 默认下已经变成 300–400 KB 的 WebP 或 JPEG；如果目标是模型发送时间，先测量实际 `ImageBlock` variant 的 `bytes`，不要看磁盘原图。
3. 已有附件不会自动变小。配置与 hook 都只影响新写入与新读取；要瘦身历史 UI 图片，需要迁移（重写附件引用与对象），代价高，暂不建议。
4. alpha 是 WebP，不是 JPEG。强行 flatten 会丢透明，且实测更大；只有在 provider 不接受 WebP 时才值得。
5. GIF 动画会被单帧化，默认跳过。
6. 图片质量：文字截图在 q85 与 1.5 MP 下通常可读；如果模型要读小字，先保留 2048 与 4 MP，或把 `maxEdge` 调到 1920。
7. 如果目标是让所有附件（含用户上传）整体变小，直接收紧 `dsh-attachment-local` 的 `normalizedImageMaxPixels` 与 `normalizedImageMaxBytes` 即可，不必安装本插件。

### 格式与缓存

- `format=png` 不受 `quality` 与 `maxBytes` 约束，可能比源图更大。
- `format=jpeg` 丢 alpha；`auto` 保留 WebP alpha。
- 缓存是进程内 LRU，重启或 HMR 会清空，不跨 session 持久化。

### 安装方式

当前 profile 的 `tool-plugin-manager` 在 base 里是 `disabled: true`，没有 `plugin_manager` 工具可用，因此安装按 bundle 的落盘路径手工完成：`dsh plugin --profile web add link:<包目录>` 把包加入依赖，并因为包声明了 `dsh.bundle.patch` 自动加入 `dsh.profile.bundles`；HMR 监听 profile manifest 与 patch，重排后立即生效，无需重启。

## DSH 关键源码位置

下列符号与行号来自当前安装的 DSH `0.2.1-rc.3`：

- `@deepseek-ai/dsh-tool-fs/lib/index.js`
  - `applyReadImageTool`：约 984–1068 行
  - `IMAGE_VALUE_SCHEMA` 与 `formatImageReadOutput`：约 845–959 行
- `@deepseek-ai/dsh-tools/lib/index.js`
  - `postExecute`：约 3599–3627 行
  - `createSuccessResult`：约 3636–3666 行
- `@deepseek-ai/dsh-attachment-local/lib/index.js`
  - `canPassThroughNormalization`：约 212–214 行
  - `normalizeImage`：约 255–271 行
  - `readRequestImageFile` 与 `createRequestImage`：约 802–810、865–891 行
  - 默认 limits 与 config：约 895–915、973–1014 行
- `@deepseek-ai/dsh-llm-pi-ai/lib/index.js`
  - `prepareRequestImages`：约 1252–1259 行
  - `userContent` base64：约 1220–1246 行
  - 默认 request target：约 953–957、1077–1079、1379–1384 行
- `@deepseek-ai/dsh-repeat-tool-reminder/lib/index.js`
  - `tools/post-execute` 现有用法：约 2247–2260 行

## 相关内容

- [压缩基准](benchmark.md)：压缩率、编码损失与缓存命中的实测数据。
- [插件入口](../index.js)：`tools/post-execute` hook 的完整实现。
- [插件包说明](../README.md)：bundle 结构、安装形态与配置项。
