# read2xsgg

[![Test](https://github.com/baixiaoshengofficial/read2xsgg/actions/workflows/test.yml/badge.svg)](https://github.com/baixiaoshengofficial/read2xsgg/actions/workflows/test.yml)
[![Docker Hub](https://img.shields.io/docker/v/knighttools/read2xsgg?label=Docker%20Hub&sort=semver)](https://hub.docker.com/r/knighttools/read2xsgg)

把「阅读 / Legado 3.x」的 JSON 书源转换成「香色闺阁」可导入的 `.xbs` 源，同时生成一份可审阅的香色 JSON 和兼容性报告。

## 功能

- 支持单个书源、书源数组，以及常见的 `sources` / `bookSources` 包装格式。
- 按阅读 `bookSourceType` 映射香色 `sourceType`：`0→text`、`1→audio`、`2→comic`、`4→video`；对历史源中误标为 `0` / `3` 的类型，会结合分组和正文能力推断小说、漫画、音频或视频，真正的文件下载源仍按 text 输出并告警。
- 转换搜索、详情、目录、正文和发现页规则；漫画正文由通用图片桥接提取，音频和视频正文由通用媒体桥接输出香色播放用的 `{url, httpHeaders, forbidCache}` JSON。
- 转换 XPath、JSONPath、阅读的 Jsoup 链式选择器、常见 CSS，以及 `{{@sel}}` / `{{Get('url')}}` 一类 Mustache 模板（登录分流回退为 `config.host`）。
- 转换 GET、POST、请求头、表单参数、关键字/页码模板和 GBK 编码配置。
- 原生生成 XXTEA 加密的 `.xbs`，不依赖外部转换程序。
- 对无法无损翻译的阅读 JS、`imageDecode`、登录 UI、递归 JSONPath、详情 `init` 等规则生成结构化告警。
- 输入既可以是本地文件、URL，也可以来自标准输入。
- 提供 HTTP 在线转换服务，香色闺阁可以直接订阅转换 URL。
- 提供受 SSRF 防护的图片代理与可扩展解码器：普通图片直通，已内置猕猴桃漫画的 AES-CBC 图片解码。
- 为没有可移植发现页的源自动补充“站点首页”或“搜索入口”分类，避免源已导入但无法在香色的切换站点列表中选中。
- 提供 Docker Compose 一键部署、健康检查、缓存、并发控制和 SSRF 防护。

## 环境

需要 Node.js 18 或更高版本，无第三方运行时依赖。

```bash
npm test
npm link
```

也可以不安装，直接用 `node ./bin/read2xsgg.js`。

## Docker Compose 一键部署

直接使用 Docker Hub 镜像：

```bash
docker compose pull
docker compose up -d
```

镜像地址：`knighttools/read2xsgg:latest`。

如果希望从当前源码重新构建：

```bash
docker compose up -d --build
```

默认监听 `http://localhost:3000`，检查服务状态：

```bash
curl http://localhost:3000/healthz
docker compose ps
```

停止服务：

```bash
docker compose down
```

修改宿主机端口：

```bash
APP_PORT=8080 docker compose up -d --build
```

指定版本镜像：

```bash
IMAGE_TAG=0.2.0 docker compose up -d
```

## 本地发布到 Docker Hub

不再通过 GitHub Actions 推镜像（无需配置 `DOCKERHUB_TOKEN` secret）。本机登录 Docker Hub 后执行：

```bash
docker login
./scripts/docker-push.sh
```

默认推送：

- `knighttools/read2xsgg:latest`
- `knighttools/read2xsgg:sha-<commit>`
- 两个标签都包含 `linux/amd64` 和 `linux/arm64` 镜像清单

可覆盖镜像名 / 标签 / 平台：

```bash
IMAGE=knighttools/read2xsgg TAG=0.2.0 PLATFORM=linux/amd64 ./scripts/docker-push.sh
```

服务器部署时直接拉取：

```bash
docker compose pull
docker compose up -d
```

## 在线 URL 转换

香色闺阁会检查链接是否以 `.xbs` 结尾，因此推荐下面这种**最好手拼**的写法：

```text
{转换站}/xbs/{去掉 https:// 后的阅读源地址}.xbs
```

例如阅读源是：

```text
https://www.yckceo.com/yuedu/shuyuans/json/id/1193.json
```

对应订阅地址：

```text
https://xs.example.com/xbs/www.yckceo.com/yuedu/shuyuans/json/id/1193.json.xbs
```

单个书源示例（爱丽丝书屋）：

```text
https://xs.example.com/xbs/www.yckceo.com/yuedu/shuyuan/json/id/7585.json.xbs
```

也可以用短查询参数（路径本身带 `.xbs`，一般不用编码）：

```text
https://xs.example.com/x.xbs?u=https://www.yckceo.com/yuedu/shuyuans/json/id/1193.json
```

旧接口仍然可用：

```text
http://localhost:3000/convert.xbs?url=https://example.com/legado.json
http://localhost:3000/url/https://example.com/legado.json.xbs
```

查看转换后的 JSON 和兼容性告警：

```text
http://localhost:3000/j/www.example.com/legado.json
http://localhost:3000/convert/json?url=https://example.com/legado.json
```

可以直接运行 HTTP 服务而不使用 Docker：

```bash
npm start
# 或
node ./bin/server.js
```

### 漫画图片解码代理

香色不能执行阅读的 `java.createSymmetricCrypto` 或 Android 图像 API。服务提供图片代理，把解码放在 Node.js 侧：

```text
{转换站}/image?url=https://cdn.example.com/image.jpg
{转换站}/image/mwwz-aes?url=https://cdn.example.com/encrypted-image
{转换站}/image/jm-scramble?url=https://cdn.example.com/photos/230000/1.jpg
```

`/image` 会直通 JPEG、PNG、GIF、WebP 等常见图片，并尝试已注册的解码能力。在线转换不会按站点域名选择解码器，而是分析阅读源 `imageDecode` 中的算法：AES-CBC 前缀 IV 会自动提取 16/24/32 字节密钥；MD5 分块倒序会自动提取取模数和偏移量；书号/图片号分块会按规则形态启用对应能力。旧的 `/image/mwwz-aes`、`/image/jm-scramble` 地址仅作为兼容别名保留。代理只会返回验证过图片文件头的结果，且与在线转换一样禁止访问内网地址。

在线转换时，所有漫画正文都会使用规则驱动的通用桥接。转换器先把阅读 `ruleContent.content` 编译成一个不含可执行代码的提取计划，自动识别 JSON/JavaScript 属性（如 `imageUrl`、`pageSrc`、`url`）和 HTML 属性（如 `src`、`data-original`、`data-src`）；服务端再按该计划解析 HTML、JSON API、Next/React 分片脚本、`img/source` 标签或纯 URL 列表，最后返回香色原生的 `{urls:[...]}`。没有明确字段提示时，会自动发现包含图片 URL 的属性组并选择最可信的连续序列。整个过程不使用站点域名作为判断条件，也不会执行阅读源携带的任意 JavaScript。

提取图片序列后，编译器会继续按 `imageDecode` 的算法能力选择参数化解码器。代理地址会从本次转换 URL 自动推导：优先使用 `Forwarded` 或 `X-Forwarded-Host` / `X-Forwarded-Proto`，公网域名默认使用 HTTPS；无需配置对外基础 URL。反向代理应保留 `Host`，并传递主机和协议头。

解码器按算法能力注册，而不是按网站注册。若以后出现当前能力集之外的全新加密或像素算法，只需新增一次该算法能力；采用相同算法的其他阅读源会从规则中自动识别并复用，不需要再增加域名或站点分支。登录态、验证码以及依赖完整 Android 环境的任意 JavaScript 仍无法安全地凭空执行。

### 音频与视频媒体桥接

音频和视频源采用与漫画相同的能力驱动方式。转换器从 `ruleContent` 中编译安全的字段和 HTML 属性提示，在线服务再从 JSON、HTML、脚本片段、`audio` / `video` / `source` / `iframe` 标签中寻找媒体地址，同时支持 HLS（`.m3u8`）和 DASH 分片。若章节 URL 本身就是媒体地址则直接播放；若接口同时返回多个清晰度，会优先选择较高质量版本。

转换器不会执行阅读源携带的远程 JavaScript、`eval` 或 Android 原生 API。这样同一套逻辑可以复用到不同站点，也避免把不可信书源代码带到服务端执行。

### 大型混合源验证

`1197.json` 这类聚合源同时包含小说、漫画、音频、视频，以及只能在阅读 Android 运行时执行的规则。在线转换会先检查分类、搜索、详情、目录和正文五段核心链路；仍含 Android 专用运行时、必要字段缺失或无法转换的条目不会写进 XBS。Compose 默认还会探测上游站点，连接失败、返回 5xx 或拒绝访问的条目也会跳过。因此输出数量会随源文件内容和站点存活状态变化，不能把输入条目数当作可用源数量。

响应头 `X-Converted-Count` 是本次实际写入的源数量，`X-Skipped-Count` 是跳过数量。JSON 调试接口还会返回 `skipped` 和 `warnings`，用于定位具体源在哪一段被过滤。

`npm test` 只运行可重复的离线测试；需要检查真实上游的详情、目录和正文时运行 `npm run test:live`。这样上游临时断线不会让 GitHub Actions 每次推送都误报失败。

### 服务配置

Compose 支持通过环境变量调整：

| 变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `APP_PORT` | `3000` | 映射到宿主机的端口 |
| `FETCH_TIMEOUT_MS` | `15000` | 下载在线阅读源的超时时间 |
| `MAX_SOURCE_BYTES` | `10485760` | 在线阅读源最大字节数 |
| `MAX_IMAGE_BYTES` | `26214400` | 单张代理图片最大字节数 |
| `MAX_REDIRECTS` | `5` | 最大重定向次数 |
| `MAX_CONCURRENT` | `8` | 最大并发转换数 |
| `CACHE_TTL_SECONDS` | `300` | 内存缓存时间，设为 `0` 可关闭 |
| `MAX_CACHE_ENTRIES` | `100` | 最大缓存条目数 |
| `CORS_ORIGIN` | `*` | 允许的跨域来源 |
| `ALLOW_PRIVATE_NETWORKS` | `false` | 是否允许抓取本机或内网 URL |
| `ALLOW_DNS_PROXY_NETWORKS` | `true` | 允许域名经 Docker Desktop、Clash 等代理解析到 `198.18.0.0/15`；直接输入该网段 IP 仍会被拦截 |
| `PREFLIGHT_SOURCES` | `true`（Compose） | 聚合源转换前探测上游站点，跳过连接失败、5xx 或拒绝访问的源 |
| `PREFLIGHT_TIMEOUT_MS` | `2500` | 单个上游站点预检超时时间 |
| `PREFLIGHT_CONCURRENCY` | `48` | 上游站点并发预检数量 |

服务默认禁止访问回环、内网、链路本地和保留地址，以降低公开部署时的 SSRF 风险。如果只在可信内网使用，并且阅读源本身位于局域网，可以这样开启：

```bash
ALLOW_PRIVATE_NETWORKS=true docker compose up -d
```

如果服务器没有使用虚拟 DNS/透明代理，并希望采用最严格的公网地址校验，可以关闭兼容开关：

```bash
ALLOW_DNS_PROXY_NETWORKS=false docker compose up -d
```

## 使用

```bash
read2xsgg legado.json \
  -o sources.xbs \
  --json sources.converted.json \
  --report sources.report.json
```

只查看转换后的 JSON：

```bash
read2xsgg legado.json --json-only > sources.json
```

从 URL 或管道读取：

```bash
read2xsgg https://example.com/legado.json -o sources.xbs
curl -s https://example.com/legado.json | read2xsgg - --json-only > sources.json
```

在代码中调用：

```js
import { convertLegado, encodeXbs } from "read2xsgg";

const { sources, warnings } = convertLegado(legadoJson);
const xbs = encodeXbs(sources);
```

## 转换范围与限制

两款应用的规则引擎并不相同，因此转换器采取“能确定语义就转换，不能确定就保留并告警”的策略。

可以自动转换的主要内容：

| 阅读 | 香色闺阁 |
| --- | --- |
| `searchUrl` | `searchBook.requestInfo` |
| `ruleSearch` | `searchBook` |
| `ruleBookInfo` | `bookDetail` |
| `ruleToc` | `chapterList` |
| `ruleContent` | `chapterContent` |
| `exploreUrl` + `ruleExplore` | `bookWorld` |
| `{{key}}` / `{{page}}` | `%@keyWord` / `%@pageIndex` |
| Jsoup/CSS/JSONPath | XPath/香色 JSON 路径 |

以下内容需要重点查看 `--report` 生成的报告：

- `@js:`、`<js>` 规则：两边的全局变量和原生 API 不同，代码会保留，但通常需要手工适配。
- `$..field` 递归 JSONPath：香色没有完全等价的递归下降表达式，会退化为普通路径。
- `ruleBookInfo.init`：香色没有直接对应字段。
- 登录、验证码、WebView 注入、加密签名等依赖阅读运行时的高级行为。
- 已下线、拒绝当前服务器访问或必须登录才能读取的上游站点；转换器不会用站点专用逻辑伪造可用结果。

建议第一次转换时始终同时生成 JSON 和报告，先在香色闺阁中导入少量源测试搜索、详情、目录、正文四个环节，再批量导入。

## XBS 兼容性

`.xbs` 的编码/解码实现与开源项目 [xbsrebuild](https://github.com/ne1llee/xbsrebuild) 的格式兼容。测试覆盖了加解密往返；项目本身不会联网提交或执行书源中的脚本。
