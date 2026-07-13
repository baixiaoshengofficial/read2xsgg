# 香色闺阁书源规则（本仓库引用）

转换逻辑以这里的文档为准，禁止凭感觉改字段语义。

## 权威来源

| 文件 | 来源 | 用途 |
|------|------|------|
| [香色闺阁书源规则.md](./香色闺阁书源规则.md) | [urzeye/xiangseguige-source-editor](https://github.com/urzeye/xiangseguige-source-editor)（基于 IPA 反解整理） | 字段定义、requestInfo、`@js:` / `\|\|@js:` / `\|@js:` |
| [XBS_JSON_CODING_RULES.md](./XBS_JSON_CODING_RULES.md) | [lindongjiang/xiangseSkill](https://github.com/lindongjiang/xiangseSkill)（StandarReader 2.56.1） | 实战编码约束、queryInfo、列表相对 XPath |

## 与本仓库直接相关的条款（摘要）

### chapterList.requestInfo（书源规则 §七）

- 用途：请求**目录页**。
- `@js:` 时：`result` = **书籍详情页 URL**（不是首章 URL，也不是 HTML）。
- 返回：URL 字符串，或带必填字段 `url` 的请求对象（§九）。

### searchBook.detailUrl（书源规则 §五）

- 语义：书籍**详情页** URL。不要把详情链接改写成目录页。

### bookDetail（书源规则 §六）

- 没有官方 `tocUrl` 字段。目录地址应在 `chapterList.requestInfo` 里用 `result`（详情 URL）推导。

### 列表子字段（精华书阁示例 / Coding Rules §4）

```text
list:  //…/li          （章节行容器）
title: //a/text()
url:   //a/@href
```

相对路径补全优先交给客户端；必要时用 `||@js:`（注意是双竖线）后处理 URL（§七 / §十）。

### alicesw（本仓库适配约定）

站点目录在 `/other/chapters/id/{id}.html`，不在 `/novel/{id}.html`。

按文档尽量走「子级 `%@result`」路径（精华书阁同款）：

1. `searchBook.detailUrl` 用 `|@js:` 把 `/novel/{id}` 改成目录页（落地页=目录页）
2. `bookDetail` / `chapterList` 的 `requestInfo` 用 `%@result`
3. `chapterList.list/title/url` 用 `li` + `//a/text()` + `//a/@href`
