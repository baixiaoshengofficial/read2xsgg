# XBS JSON 编码规则（基于 `sourceModelList.json`）

## 1) 顶层结构

- 顶层必须是对象：`{ "<sourceAlias>": { ...sourceConfig } }`
- 每个源建议同时保留：
  - `sourceName`
  - `sourceUrl`
  - `enable`
  - `weight`
  - `miniAppVersion`
  - `lastModifyTime`
  - `sourceType`（`text` / `comic` / `video` / `audio`）

`lastModifyTime` 建议使用 Unix 秒级时间戳字符串（如 `"1772463417"`），避免被客户端错误解析为“很久以前”。

`sourceName` 命名规范（团队约定）：

- `sourceName` 仅保留“站点名 + 版本”语义，不承担宣传信息。
- 示例：`瀚海书阁-txtdd-v0303-nojs`

交付备注规范（团队约定）：

- 公众号信息统一写在交付备注区（`delivery_notes`），不写入 `sourceName`。
- 固定文案：`公众号:好用的软件站`
- `delivery_notes` 属于交付说明元数据，可写在发布说明、PR 描述或检测报告中（不是 source JSON 必填字段）。

`weight` 规则（新版本）：

- 数值越大优先级越高
- 交付产物目标：整数字符串（例如：`"9999"`）
- 输入层若出现 `int/bool`，应先归一化再发布（默认校验警告，严格模式可拦截）
- 建议范围：`"1"` 到 `"9999"`
- 默认值：`"9999"`
- `0` / `"0"` 视为不可用（新版本已增加权重限制）

`enable` 规则（2.56.1）：

- 交付产物目标：整型 `1/0`
- 输入层若出现 `"1"`/`true` 等多态，建议归一化为 `1/0`

## 1.1) StandarReader 2.56.1 编辑器兼容约束（新增）

背景：存在“导入可用，但编辑页点击保存闪退”的客户端问题。  
结论：必须把“编辑保存稳定性”作为独立验收项，不可仅看抓取链路可用。
日志指纹（已实锤）：`-[__NSCFNumber length]`，对应字段类型错配；本轮定位到 `weight(number)` 是高概率主因。

导入闪退补充（2.56.1，Mac Catalyst）：

- 若崩溃日志出现 `NSInvalidArgumentException` + `-[__NSArrayI allKeys]`，
  表示客户端把数组按字典读取。
- 已确认高风险触发点：`bookWorld.categories` 数组形态。
- 兼容写法：`bookWorld` 使用分类字典（`bookWorld.{分类名}`），不要输出 `categories` 数组。

强制验收：

- 不改任何字段直接保存，不闪退
- 修改 `sourceName/bookSourceName` 1 个字符后保存，不闪退
- 修改 1 个规则字段（XPath 或 `requestInfo`）后保存，不闪退

建议流程：

- 常规规则先跑 schema 检查：`check_xiangse_schema.py`
- 再跑编辑兼容检查：`check_editor_compat.py` 或 `xbs_tool.py check-editor`
- 若命中高风险项，先产出 `editor_safe` 版本再交付

`editor_safe`（默认面向 2.56.1）约束：

- `weight` 必须为整数字符串（默认 `"9999"`）
- 保留 `bookWorld` 分类能力
- `requestFilters` 统一为字符串形态
- `validConfig` 统一降级为空字符串
- 优先回避高风险结构组合（通过 A/B 变体定位后再放开）

## 1.2) StandarReader 2.56.1 逆向真值补丁（2026-03）

以下枚举来自 `lpnet_modelInfo` 反编译解包结果，作为 2.56.1 优先基线：

- `responseFormatType` 合法值：
  - `""`（普通字符串）
  - `base64str`
  - `html`
  - `xml`
  - `json`
  - `data`
- `responseDecryptType` 合法值：
  - `""`（无需解密）
  - `encryptType1`（自定义解密1）

占位符（主程序字符串已实锤）：

- `%@result`
- `%@keyWord`
- `%@pageIndex`
- `%@offset`
- `%@filter`

Schema 分级策略（与脚本保持一致）：

- 继续报错：缺少核心字段、禁用顶层字段、`java.getParams()`
- 默认警告：`method:` / `data:` / `headers:`、`weight` 非字符串、`enable` 非整型
- 严格模式：`check_xiangse_schema.py --strict-requestinfo` 会将 `method/data/headers` 升级为错误

推荐最小骨架：

```json
{
  "示例书源": {
    "sourceName": "示例书源",
    "sourceUrl": "https://example.com",
    "sourceType": "text",
    "enable": 1,
    "weight": "9999",
    "miniAppVersion": "1.0.0",
    "lastModifyTime": "1772463417",
    "searchBook": { "actionID": "searchBook", "parserID": "DOM" },
    "bookDetail": { "actionID": "bookDetail", "parserID": "DOM" },
    "chapterList": { "actionID": "chapterList", "parserID": "DOM" },
    "chapterContent": { "actionID": "chapterContent", "parserID": "DOM" }
  }
}
```

## 2) 核心动作对象

常见动作：

- `searchBook`
- `bookDetail`
- `chapterList`
- `chapterContent`
- `relatedWord`
- `searchShudan`
- `shudanDetail`
- `shudanList`
- `shupingList`
- `shupingHome`
- `bookWorld`

动作对象的硬性字段：

- `actionID`：必须与动作名一致
- `parserID`：通常为 `DOM` 或 `JS`

动作对象常见字段（按出现频率）：

- `host`
- `validConfig`
- `responseFormatType`（`""` / `base64str` / `html` / `json` / `xml` / `data`）
- `responseDecryptType`（`""` / `encryptType1`）
- `requestInfo`
- `list`
- `bookName`
- `detailUrl`
- `cover`
- `title`
- `url`
- `content`
- `author`
- `desc`
- `cat`
- `status`
- `lastChapterTitle`
- `updateTime`
- `httpHeaders`
- `moreKeys`
- `nextPageUrl`

编辑兼容补充（2.56.1）：

- 发布目标建议：`weight` 为整数字符串；若输入为数字类型，先归一化
- 发布目标建议：`enable` 为整型 `1/0`；若输入为字符串/布尔，先归一化
- `requestFilters` 优先字符串形态（兼容优先于结构化数组）
- `validConfig` 优先空字符串（若非必须，不使用 JSON 字符串）

## 3) 请求构建规则（`requestInfo`）

`requestInfo` 两种主流写法：

1. URL 模板写法（老但仍常见）

```text
modules/article/search.php?searchkey=%@keyWord
```

常见占位符：`%@keyWord`、`%@pageIndex`、`%@filter`、`%@result`

补充常见占位符（老模板写法）：

- `%@result`：上一级传入地址
- `%@keyWord`：搜索关键词
- `%@pageIndex`：当前页码
- `%@offset`：偏移量（部分源使用）
- `%@filter`：筛选参数（来自 `requestFilters`）

2. `@js:` 写法（推荐）

```js
@js:
let url = config.host + "/search";
return {
  "url": url,
  "POST": true,
  "httpParams": {"q": params.keyWord},
  "httpHeaders": config.httpHeaders
};
```

`@js:` 返回值常见为：

- 直接返回 URL 字符串
- 返回对象（常用键：`url`、`POST`、`httpParams`、`httpHeaders`、`forbidCookie`、`forbidCache`、`webView`、`webViewSkipUrls`、`cacheTime`）

`@js:` 返回对象示例：

```js
@js:
let hp = {};
hp.key = params.keyWord;
hp.p = params.pageIndex;
let url = "https://www.host.com/search";
let hh = {
  "User-Agent": "Mozilla/5.0",
  "Referer": "https://www.baidu.com"
};
return {
  "url": url,
  "POST": false,
  "httpParams": hp,
  "httpHeaders": hh
};
```

## 3.0) WebView 执行键（2.56.1 专用）

当站点必须依赖页面 JS 渲染或挑战页流程时，可在 `requestInfo` 返回对象中使用：

- `webView`：`true/false`，是否切换到 WebView 请求路径
- `webViewJs`：页面加载后注入执行的 JS 字符串
- `webViewJsDelay`：注入前延迟（秒）
- `webViewSkipUrls`：导航过滤规则（字符串或数组）
- `webViewSkipUrlsUnless`：白名单覆盖规则（字符串或数组）

导入前验收约束（固定）：

- `simulate-live` 默认使用 `--engine auto`，由运行时自动决定 `http/webview`
- WebView 书源必须在报告里看到：
  - `steps.*.runtime_engine`
  - `steps.*.webview_trace`
- 若命中 `403/429/challenge`，按 `blocked` 处理，不归类为 parser 规则失败

建议命令：

```bash
python tools/scripts/xbs_tool.py simulate-live -i <input.xbs|input.json> --engine auto --webview-timeout 25 --report <simulate_report.json>
```

## 3.1) `result` 在不同阶段的含义（重要）

- 在 `requestInfo` 阶段，`result` 通常是上一级传入的 URL 或 `nextPageUrl`
- 在响应解释阶段（字段解析 / `||@js:`），`result` 是当前字段上一层解析产物

排查问题时可临时打印上下文：

```js
return {"config": config, "params": params, "result": result};
```

## 3.2) 章节分页请求（强烈建议固定模板）

章节内容有分页时，`requestInfo` 推荐优先顺序：

1. `params.lastResponse.nextPageUrl`
2. `result`（上一级传入）
3. `params.queryInfo.url`（首章 URL）

并建议在 `requestInfo` 里处理相对路径：

- 优先基于 `params.responseUrl` 组绝对地址
- 再回退到 `config.host`

示例（兼容旧引擎写法）：

```js
@js:
var host = (config && config.host) ? config.host : "https://www.xxx.com/";
function absUrl(u){
  if (!u) return "";
  u = String(u);
  if (/^https?:\/\//i.test(u)) return u;
  if (/^\/\//.test(u)) return "https:" + u;
  var base = (params && params.responseUrl) ? String(params.responseUrl) : host;
  var hm = base.match(/^(https?:\/\/[^\/]+)/i);
  var h = hm ? hm[1] : host.replace(/\/+$/, "");
  if (/^\//.test(u)) return h + u;
  return host + u.replace(/^\/+/, "");
}
if (params && params.lastResponse && params.lastResponse.nextPageUrl) {
  return {"url": absUrl(params.lastResponse.nextPageUrl), "httpHeaders": config.httpHeaders};
}
var u = (typeof result === "string" && result) ? result : (params.queryInfo ? params.queryInfo.url : "");
return {"url": absUrl(u), "httpHeaders": config.httpHeaders};
```

## 3.3) requestInfo JS 转义兼容（实战坑位）

- `requestInfo` 为 `@js:` 时，字符串与正则都要经过 JSON 转义，容易出错。
- 避免使用以下易错写法做 URL 反转义：
  - `String(u).replace(/\\//g,'/')`
- 推荐使用稳定写法：
  - `String(u).split('\\\\/').join('/')`
- 原则：优先“简单字符串处理”替代“高转义复杂正则”。

## 4) 解析规则（DOM / JSON）

1. DOM 解析主流写法

- `list`：列表 XPath
- 子字段（如 `title`、`bookName`、`detailUrl`）使用相对 XPath
- 常见 XPath：`/text()`、`/@href`

章节链接提取（实战优先级，重要）：

- 当 `list` 已经选中章节 `<a>` 节点时，`url/detailUrl` 优先写节点内属性：`//@href`（必要时可用 `@href`）
- 避免在该场景写 `//a/@href[1]` 这类“再全局找一遍”的兜底，容易引入误匹配
- 相对链接通常可交给客户端自动补全 host；仅在确实没补全时再加 `||@js` 做绝对化
- `txtdd` 这类目录结构中，`list='//div[@id=\"chapter-list\"]/a'` + `url='//@href'` 已足够稳定

2. 二段处理语法（非常常见）

- `xpath||@js:...`
- `xpath|@js:...`

示例：

```text
//div[@class="info"]/text()||@js:
return result.replace(/作者：/g, "");
```

3. JSON 响应

- `responseFormatType` 设为 `json`
- 字段可用 `$.` 路径

## 4.3) 搜索结果“列表/详情双形态”兼容

部分站点在 `searchBook` 会出现两种返回形态：

1. 模糊搜索：返回列表页（可通过 `list` 逐项解析）
2. 精确命中：直接返回书籍详情页（没有列表节点）

建议：

- `detailUrl` 仍优先使用 list 上下文相对路径（例如 `//h4.../a/@href`）。
- 同时新增 `url` 作为详情页兜底来源，示例：
  - `//h4[contains(@class,'bookname')]/a/@href||//link[@rel='canonical']/@href||//meta[@property='og:novel:read_url']/@content`
- 后续 `bookDetail/chapterList/chapterContent.requestInfo` 统一按优先级取：
  - `params.queryInfo.detailUrl`
  - `params.queryInfo.url`
  - `result.url / result.detailUrl`

## 4.4) 中文搜索参数编码规范

- 中文关键词搜索优先采用 `GET + encodeURIComponent`。
- 推荐：
  - `modules/article/search.php?searchkey=${encodeURIComponent(params.keyWord)}&searchtype=all`
- 若必须使用 `POST`，需额外验证目标客户端实际编码行为。

## 4.5) bookWorld 分类性能规范

- 分类请求优先依赖 `pageIndex` 构造 URL，不默认依赖 `nextPageUrl` 连续翻页。
- 2.56.1 导入兼容硬约束：`bookWorld` 使用命名分类 map（`bookWorld.{分类名}`），禁用 `bookWorld.categories` 数组。
- `maxPage` 应与站点实际页数匹配，避免“超大页上限 + 自动翻页”导致超时。
- 推荐在调试时先固定：
  - 单页抓取验证字段
  - 再逐步提高 `maxPage`

## 4.6) token 二跳正文接口规范（deqixs 类）

部分站点章节正文链路不是“章节 HTML 直接出正文”，而是：

1. 先请求章节页（或章节脚本）提取 token 参数
2. 再请求正文接口（通常返回 JSON）

典型流程（deqixs）：

- `scripts/chapter.js.php` 提取 `chapterToken/timestamp/nonce`
- `modules/article/ajax2.php` 使用 `aid/cid/token/timestamp/nonce` 获取正文

规则建议：

- `chapterContent.requestInfo` 第一优先处理 `params.lastResponse.nextPageUrl`（第二跳 URL）。
- 第二跳请求显式设置动态请求头（按站点风控要求）：
  - `X-Requested-With: XMLHttpRequest`
  - `Referer: 当前章节 URL`
- URL 回退顺序建议统一：
  - `params.lastResponse.nextPageUrl`
  - `params.queryInfo.url || params.queryInfo.detailUrl`
  - `result.url || result.detailUrl || result`
  - `params.responseUrl`

`content` 解析建议（关键）：

- 不要用“检测到 `chapterToken` 就直接 `return ''`”的早退逻辑。
- 先 `JSON.parse`，失败再正则兜底提取 `\"content\":\"...\"`。
- 对“脚本 + JSON”混合响应，允许先抽取 JSON 片段再解析。

排障信号：

- 返回 `status:0` 且 message 为“仅支持网页端访问/不支持该客户端访问”：
  - 优先检查第二跳请求头。
- 返回 `status:1` 但正文空：
  - 优先检查是否被 token 早退分支误伤；
  - 再检查是否只兼容了单一响应形态。

## 4.7) API-first 站点规范（66shuba 类）

站点特征：

- 页面主要由前端 JS 渲染，核心数据来自 `/api/...`。
- 详情/阅读页可能出现“请先登录”文案，但接口仍可独立访问。

规则建议：

- `searchBook/bookDetail/chapterList/chapterContent` 优先全链路 `responseFormatType: "json"`。
- 避免从详情页 DOM 抠数据，优先使用：
  - `/api/novel/search?keyword=...&page=...`
  - `/api/novel/detail/{bookId}`
  - `/api/novel/catalog/{bookId}`
  - `/api/novel/chapter/{bookId}/{chapterId}`（VIP 再切 `vip-chapter`）
- 搜索返回若为嵌套卡片结构（如 `CardList -> Body -> ItemData`），在 `list` 中用 `||@js` 扁平化。
- 目录必须过滤哨兵章节：
  - 如 `C=-10000`（版权信息）；
  - 通用规则：仅保留 `chapterId/C/id` 为正整数的章节。
- 章节 `url/detailUrl` 建议统一成 read 形态：
  - `/read/{bookId}/{chapterId}`
  - 再在 `chapterContent.requestInfo` 中反解并组装 API URL。
- 封面可优先尝试 `BookCover`，为空时用 `BookId` 拼 CDN：
  - `https://bookcover.yuewen.com/qdbimg/349573/{BookId}/600`

排障信号：

- 返回 `code=0` 但 `content` 是“网络开小差了，请稍后再试”等占位文案：
  - 属于上游数据异常/限流，不是解析规则成功；
  - 需要重试、换章验证，或在报告中标注“占位正文”。

## 4.8) DOM 站正文分页守卫（sudugu 类）

站点特征：

- 正文页底部常见固定结构：`上一章/目录/下一页(或下一章)`。
- 同一 XPath 位在“有分页章节”与“无分页章节”含义会变化：
  - 有分页：`/{bookId}/{chapterId}-2.html`
  - 无分页：`/{bookId}/`（下一章或回目录）

规则建议：

- `chapterContent.nextPageUrl` 不要只写：
  - `//a[contains(text(),'下一页')]/@href`
- 推荐“固定位置 + JS 守卫”：
  - 先取右侧翻页位（例如 `(//div[contains(@class,'prenext')]/span[2]/a/@href)[1]`）
  - 再做 URL 判定：`/{bookId}/{chapterId}(-{page})?.html`
  - 仅当：
    - `bookId` 相同
    - `chapterId` 相同
    - `nextPage > currentPage`
    才返回下一页 URL；否则返回空。

分类/目录分页补充：

- 同站点可能并存多种分页 URL 形态，不要猜测：
  - 目录分页：`p-2.html#dir`
  - 分类分页：`/{cat}/2.html`
- 生产规则应优先依据真实“下一页”链接或页面级模板验证结果。

## 4.9) 外部加密搜索与目录分页去重（shuhaoxs 类）

站点特征：

- 首页搜索可能跳到外部域（例如 `rrssk`），本域不存在稳定搜索接口。
- 外部搜索常见“关键词加密 + 结果链接加密 + JS 解密跳转”：
  - `search_url='/k-{keyword}.html'`
  - `encryptText`（AES-CBC）
  - `toUrl/openUrl` 解密后再跳转
- 目录接口为：
  - `POST /index.php?action=loadChapterPage`
  - 参数：`id={aid}, page={n}`
  - 返回字段：`chapterorder/chapterurl/chaptername`

规则建议：

- 对“外部加密搜索链路”默认谨慎接入：
  - 若解密依赖 `CryptoJS + UA + 动态变量(num)` 且运行时不可保证一致，不建议作为主搜索。
  - 优先降级为“分类页遍历 + 关键词过滤”以保证可用性。
- `bookDetail` 优先 `og:*`：
  - `og:novel:book_name`
  - `og:novel:author`
  - `og:novel:category`
  - `og:novel:status`
  - `og:novel:update_time`
  - `og:novel:latest_chapter_name`
  - `og:url`
  - `og:image`
- `chapterList` 处理分页重复陷阱：
  - 部分书（章节 < 100）对 `page>=2` 仍返回第 1 页数据；
  - 越界页可能反复返回末页数据；
  - 因此 `nextPageUrl` 禁止仅用 `data.length > 0` 判定。
- 推荐增加 `chapterorder` 页范围校验（每页 100 章）：
  - `page=1` 仅接受 `1..100`
  - `page=2` 仅接受 `101..200`
  - 依此类推
  - 若首章序号不匹配当前页起点，视为重复页，停止翻页。

`nextPageUrl` 伪代码（示意）：

```js
@js:
var arr = result || [];
var page = currentPageFromResponseUrl();
var start = (page - 1) * 100 + 1;
if (arr.length === 0) return '';
if (parseInt(arr[0].chapterorder, 10) !== start) return ''; // 重复页/越界页
if (arr.length < 100) return ''; // 最后一页
return nextPageUrl(page + 1);
```

## 4.10) 搜索限流页与目录型 read_url 兼容（bxwx 类）

站点特征：

- 搜索使用本域表单 `POST /search.html`，字段固定为：
  - `searchtype=all`
  - `369koolearn=<keyword>`
- 搜索存在硬限流，短时间重复请求会返回提示页：
  - `搜索间隔为30秒，请稍后在试！`
- 详情页 `og:novel:read_url` 可能直接是目录 URL：
  - `/dir/{aid}/{bid}.htm`
  - 而非 `/b/{aid}/{bid}/` 阅读入口。

规则建议：

- 搜索调试先做“限流页识别”，不要把限流提示页误判为 XPath 失效。
- 搜索链路建议保留 `POST` 真实表单形态，减少站点风控差异。
- `chapterList.requestInfo` 做 URL 归一化时，至少支持两类输入：
  - `/b/{aid}/{bid}/`
  - `/dir/{aid}/{bid}.htm`
- `bookWorld` 分类路径若是站点私有形态（如 `/bsort{n}/`），必须按实测模板写，不复用他站规则。
- 若分类没有稳定翻页语义（`page=2` 空页/错误页），默认 `maxPage=1`。

正文分页补充（bxwx）：

- `#pager_next` 在章节末页常切到“下一章”。
- `nextPageUrl` 必须做同章守卫，仅允许：
  - `/b/{bookId}/{chapterId}(_{page})?.html`
  - 且 `bookId/chapterId` 相同、`nextPage > currentPage`
- 正文建议清洗分页提示尾巴，避免残留：
  - “这章没有结束…下一页继续阅读…”
  - “小主子…下一页继续阅读…”
  - “喜欢…请大家收藏…更新速度全网最快”

## 4.12) 17K 加密正文验收与稳定性

导入稳定性（防闪退）：

- 禁止把超长混淆 WAF JS 直接塞进 `requestInfo/content` 作为主链路。
- 2.56.1 若出现 `-[__NSArrayI allKeys]`，先检查并移除 `bookWorld.categories` 数组形态。
- 若链路依赖复杂反爬脚本且客户端不稳定，优先切换 API 或可复现的降级方案。

加密正文验收（硬规则）：

- 当章节响应出现 `content[].encrypt=1` 时，必须执行“解密成功校验”。
- 以下场景一律判定为失败，不可当作“可用书源”交付：
  - `title` 有值但 `content` 为空；
  - `content` 仍是密文串（如长 base64/密文字段原样透传）；
  - 仅返回占位提示文案，非真实正文。

分类完整性验收：

- 发布前必须检查 `bookWorld` 与 `requestFilters` 设计是否完整。
- 若站点无法提供完整分类能力，需在 `delivery_notes` 明确记录“缺失原因 + 降级策略”。

## 4.1) 手动 JS 解析（选用）

默认可不启用手动函数；当标准规则难以覆盖时可混合使用。

手动函数签名：

```js
function functionName(config, params, result) {
  let list = []; // 自定义解析结果
  return {"list": list};
}
```

调试阶段可返回任意结构查看运行时数据：

```js
function functionName(config, params, result) {
  return {"config": config, "params": params, "result": result};
}
```

## 4.2) 全局请求头与动态资源请求

1. 全局请求头（根级 `httpHeaders`）

```json
{
  "httpHeaders": {
    "User-Agent": "Mozilla/5.0 ...",
    "Referer": "https://www.baidu.com"
  }
}
```

在 `@js:` 里可直接读取：`config.httpHeaders`。

补充（接口风控场景）：

- 全局 `Referer` 仅适合通用请求。
- 若正文接口要求“章节级 Referer”，必须在 `chapterContent.requestInfo` 里动态覆盖：
  - `Referer = params.queryInfo.url / detailUrl`
  - `X-Requested-With = XMLHttpRequest`
- 仅依赖根级 `httpHeaders` 的常见后果：接口返回“仅支持网页端访问 / 不支持该客户端访问”。

2. 章节内容中的图片/音频/视频，若需动态 header，可在字段里返回请求对象：

```text
//a/@href || @js:
return {
  "url": result,
  "httpHeaders": {
    "User-Agent": "Mozilla/5.0 ...",
    "Referer": "https://www.baidu.com"
  }
};
```

## 4.5) 正文为 `document.writeln(...)` 动态写入时（如 base64 包裹）

有些站点正文不在初始 DOM 文本里，而是脚本动态写入，例如：

```html
<script>document.writeln(xxx.yyy('BASE64...'));</script>
```

处理方式：

- `content` 先取包含脚本的容器节点（例如 `//div[@class='word_read']`）
- 在 `||@js:` 中正则提取 `BASE64` 片段并解码，再去掉 `<p>` 等标签
- 若解码失败，回退为“移除 script 后的纯文本”

这类站点通常还带章节分页（`_1.html`, `_2.html`）：

- 用 `nextPageUrl` 提取“下一章/下一页”链接
- 在 `||@js:` 里校验“同章节 ID 才继续翻页”，避免误跳到下一章

看书网（`kanzh.com`）实战建议（已验证）：

- 优先从脚本变量 `hhekgv` 取下一页：`//script[contains(text(),'hhekgv')]/text()`
- `hhekgv` 存在但指向“下一章”时，必须立即停止当前章分页（返回空）
- 仅在抓不到 `hhekgv` 时，才允许 URL 拼接兜底（`cid.html -> cid_1.html -> cid_2.html`）
- 若当前页是 `cid.html`（页码为0）且没有任何“下一页”证据，不要猜测 `_1.html`，避免无分页章节误翻
- 章节内容建议同时配置：`validConfig.maxPage` 与 `moreKeys.maxPage`，双保险防死循环
- 真实站点存在“伪分页 URL”（如 `_1.html` 301 回原页），必须避免盲猜 `_1/_2`

`kanzh` 当前稳定判定规则：

- 先从 `hhekgv` 抽取候选下一页
- 解析当前页与候选页：`/baidu/{aid}/{cid}(_{page})?.html`
- 仅在以下条件同时满足时继续翻页：
  - `aid` 相同
  - `cid` 相同
  - `nextPage > currentPage`
- 否则视为“下一章或无分页”，`nextPageUrl` 返回空

老版本兼容兜底（重要）：

- 部分旧版香色闺阁客户端在 `DOM(html)` 阶段会丢失 `script`，导致 `content || @js` 拿不到 `BASE64` 段。
- 这时改用“手动 JS”旧方案：
  - `chapterContent.parserID = "JS"`
  - `chapterContent.responseFormatType = ""`（普通字符串）
  - 在 `responseJavascript` 里直接处理原始响应字符串 `resStr`，正则提取并解码 `document.writeln(...)` 内容。
- 该方案通常比 `||@js` 更兼容老客户端。

## 4.3) 香色闺阁兼容差异（重要）

在香色闺阁 App 的 DOM 解析里，`list` 命中后，字段写法要区分场景，不要一刀切：

推荐规则（兼容优先）：

- 对“跨层级文本抓取”字段，统一使用绝对 XPath：`//...`
- 对“当前 list 节点自身属性”字段（尤其 `url/detailUrl`），优先使用 `//.../@href` 或 `//@href`
- 禁止在 `list` 子字段使用 `./...` 或 `.//...`（香色运行时高频出现上下文偏移）
- 不要把“当前节点属性读取”过度写成 `//a/@href[1]||@js:...` 复杂链

典型故障特征：

- `listLengthOnlyDebug` 显示正常（如 50）
- 但 `url` 或 `detailUrl` 丢失（只有 `title`）

此时先确认：

- `list` 是否已定位到正确节点（例如章节 `<a>`）
- 若已定位，`url/detailUrl` 直接改为 `//@href`（或明确列路径 `//.../@href`）再测

## 4.11) DOM 表格列表污染与封面回推（libahao 类）

站点特征：

- 搜索/分类结果在 `<table><tbody><tr>...</tr></tbody></table>` 中按列展示。
- 误用宽 XPath 或 `./...` 时，字段容易被整行文本污染（大量换行、空格、`\n`）。
- 分类页通常无 `<img>` 列，封面需由详情 URL 反解。

规则建议：

- `list` 命中 `tr` 后，子字段坚持“列到字段”：
  - `cat -> //td[1]/a/text()`
  - `bookName -> //td[2]/a/text()`
  - `lastChapterTitle -> //td[3]/a/text()`
  - `author -> //td[4]/text()`
  - `updateTime -> //td[5]/text()`
  - `url/detailUrl -> //td[2]/a/@href`
- 文本字段统一做空白归一：
  - `String(result || '').replace(/\\s+/g, ' ').trim()`
  - 分类额外去方括号：`.replace(/[\\[\\]]/g, '')`
- 避免绑定整行类字段（如 `status/wordCount/desc`）到 `tr` 文本，除非确有业务需要且已拆分。
- 分类无封面节点时，使用 URL 反推：
  - 从 `/book/{aid}_{bid}/` 提取 `bid`
  - 生成封面：`/data/image/{bid}.jpg`

## 4.4) `moreKeys` 常用项（筛选 / 分页 / 清洗）

`moreKeys` 是兼容老规则和猴子配置（monkey）时非常实用的扩展位，尤其用于分类、搜索、章节分页。

可直接使用的常见键：

- `requestFilters`：筛选器（如分类、最新、最热）
- `removeHtmlKeys`：对指定字段做外部去标签（含 script 等 HTML 内容清理）
- `skipCount`：列表前 N 条跳过（效果类似 XPath 的 `position() > N`，但更稳定）
- `pageSize`：声明单页条数，用于判断是否还有下一页
- `maxPage`：强制最大分页（章节列表 / 章节内容分页时建议配）

`requestFilters` 支持两种写法：

1. 简单字符串（单筛选）

```text
_cat
玄幻::xuanhuan
言情::yanqing
```

2. 结构化数组（推荐，适合多筛选组）

```json
[
  {
    "key": "category",
    "items": [
      {"title": "玄幻", "value": "xuanhuan"},
      {"title": "言情", "value": "yanqing"}
    ]
  }
]
```

示例：

```json
{
  "moreKeys": {
    "requestFilters": "排序\n最新::latest\n最热::hot\n",
    "removeHtmlKeys": ["bookName", "author", "desc"],
    "skipCount": 6,
    "pageSize": 30,
    "maxPage": 1
  }
}
```

分页控制建议：

- 有稳定每页数量时优先 `pageSize`
- 容易出现死循环翻页时优先 `maxPage`
- 也可以两者同时配置（以安全为先）

## 5) 类型与兼容性规范（建议严格执行）

1. `enable` 统一用数字：`1` / `0`

- 不要混用 `true/false` 或字符串 `"1"`/`"0"`

2. 明确写 `sourceType`

- 避免省略导致兼容分支走错

3. `weight` 使用整数字符串 `"1"`..`"9999"`

- 推荐默认值：`"9999"`
- 需要调低优先级时再使用较小字符串数值

4. `actionID`、`parserID` 任何动作都必须有

5. 能用 `requestInfo=@js:` 就不要走旧字段函数链

6. 章节解析 JS 兼容旧引擎

- 优先用 ES5 写法（`var`/`function`）
- 避免 `new URL()`、可选链、空值合并等新语法
- 手动函数签名统一：`function functionName(config, params, result)`

## 6) 老规则中“尽量不用”的字段

以下字段在样本里大量存在，但属于旧机制或兼容包袱，新写代码默认不要使用：

- `requestJavascript`
- `requestFunction`
- `responseJavascript`
- `responseFunction`
- `requestParamsEncode`
- `responseEncode`
- `JSParser`（默认不用；但老客户端章节正文解析失败时可作为兼容兜底）

另：避免拼写错误键名（例如 `cahceTime`），应统一为 `cacheTime`。

## 7) 新建源最小可运行模板（推荐）

```json
{
  "sourceName": "站点名",
  "sourceUrl": "https://example.com",
  "sourceType": "text",
  "enable": 1,
  "weight": "9999",
  "miniAppVersion": "1.0.0",
  "lastModifyTime": "1772463417",
  "httpHeaders": {
    "User-Agent": "Mozilla/5.0"
  },
  "searchBook": {
    "actionID": "searchBook",
    "parserID": "DOM",
    "host": "https://example.com",
    "validConfig": "",
    "responseFormatType": "html",
    "requestInfo": "@js:\nreturn config.host + '/search?q=' + encodeURIComponent(params.keyWord);",
    "list": "//ul[@id='result']/li",
    "bookName": "//a/text()",
    "detailUrl": "//a/@href",
    "author": "//span[@class='author']/text()"
  },
  "bookDetail": {
    "actionID": "bookDetail",
    "parserID": "DOM"
  },
  "chapterList": {
    "actionID": "chapterList",
    "parserID": "DOM"
  },
  "chapterContent": {
    "actionID": "chapterContent",
    "parserID": "DOM"
  }
}
```
