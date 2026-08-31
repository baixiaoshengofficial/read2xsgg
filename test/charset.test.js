import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeTextBuffer,
  detectLegadoCharset,
  encodeFormBody,
  sniffCharsetFromHtml,
  xiangseEncodeFields,
  XIANGSE_GBK_ENCODE,
} from "../src/charset.js";
import { convertLegado, compileBookBridgePlan, decodeBridgePlan, downloadAsFetch } from "../src/index.js";

test("detectLegadoCharset 从 searchUrl 识别 gbk", () => {
  assert.equal(detectLegadoCharset({
    searchUrl: '/search.php,{"method":"POST","body":"q={{key}}","charset":"gbk"}',
  }), "gbk");
  assert.equal(detectLegadoCharset({ bookSourceCharset: "GB18030" }), "gbk");
  assert.equal(detectLegadoCharset({ searchUrl: "/search?q={{key}}" }), "");
});

test("decodeTextBuffer 按 GBK 解码页面", () => {
  const gbk = Buffer.from([0xd0, 0xc2, 0xd3, 0xf9, 0xca, 0xe9, 0xce, 0xdd]); // 新御书屋
  assert.equal(decodeTextBuffer(gbk, { charsetHint: "gbk" }), "新御书屋");
  assert.notEqual(decodeTextBuffer(gbk, { charsetHint: "utf-8" }), "新御书屋");
});

test("sniffCharsetFromHtml 读取 meta charset", () => {
  const html = Buffer.from('<html><head><meta charset="gbk" /></head><body>x</body></html>', "utf8");
  assert.equal(sniffCharsetFromHtml(html), "gbk");
});

test("GBK 表单按原始字节进行百分号编码", () => {
  assert.equal(
    encodeFormBody({ keyword: "小说 测试", page: 2 }, { requestParamsEncode: XIANGSE_GBK_ENCODE }),
    "keyword=%D0%A1%CB%B5+%B2%E2%CA%D4&page=2",
  );
  assert.equal(encodeFormBody({ keyword: "小说" }), "keyword=%E5%B0%8F%E8%AF%B4");
});

test("香色动作链 fetch 按页面 meta 解码 GBK", async () => {
  const page = Buffer.concat([
    Buffer.from('<meta charset="gbk"><div id="content">', "ascii"),
    Buffer.from([0xd0, 0xc2, 0xd3, 0xf9, 0xca, 0xe9, 0xce, 0xdd]),
    Buffer.from("</div>", "ascii"),
  ]);
  const response = await downloadAsFetch(async () => page)("https://novel.example/read/1");
  assert.match(await response.text(), /新御书屋/);
});

test("香色动作链不会二次解码识站已标准化的 UTF-8 页面", async () => {
  const page = Buffer.from('<meta charset="gbk"><div>新御书屋</div>', "utf8");
  Object.defineProperty(page, "read2xsggDecodedText", { value: true });
  const response = await downloadAsFetch(async () => page)("https://novel.example/read/1");
  assert.match(await response.text(), /新御书屋/);
});

test("香色动作链 fetch 保留真实响应 URL 与 Content-Type", async () => {
  const page = Buffer.from("<html>not media</html>");
  Object.defineProperty(page, "read2xsggResponseUrl", { value: "https://media.example/player" });
  Object.defineProperty(page, "httpHeaders", { value: { "content-type": "text/html; charset=utf-8" } });
  const response = await downloadAsFetch(async () => page)("https://media.example/player?url=x.m3u8");
  assert.equal(response.url, "https://media.example/player");
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
});

test("GBK 源转换后分类/正文动作与 bridge plan 携带编码", () => {
  const source = {
    bookSourceName: "新御书屋测试",
    bookSourceUrl: "https://www.xyushuwu5.com",
    searchUrl: '/modules/article/search.php,{"method":"POST","body":"searchkey={{key}}","charset":"gbk"}',
    exploreUrl: "校园言情::/xiaoyuan/",
    ruleSearch: {
      bookList: ".txt-list li",
      name: "span:nth-child(2) a",
      bookUrl: "span:nth-child(2) a@href",
    },
    ruleExplore: {
      bookList: ".txt-list li",
      name: "span:nth-child(2) a",
      bookUrl: "span:nth-child(2) a@href",
    },
    ruleBookInfo: { name: "h1" },
    ruleToc: { chapterList: "#list a", chapterName: "a", chapterUrl: "a@href" },
    ruleContent: { content: "#content@html" },
  };
  const { sources } = convertLegado(source, { imageProxyBase: "https://xs.example.com" });
  const converted = sources["新御书屋测试"];
  assert.equal(converted.searchBook.responseEncode, XIANGSE_GBK_ENCODE);
  assert.equal(converted.bookWorld["校园言情"].responseEncode, XIANGSE_GBK_ENCODE);
  assert.equal(converted.chapterContent.responseEncode, XIANGSE_GBK_ENCODE);
  assert.match(converted.bookWorld["校园言情"].requestInfo, /adapter\/books\?plan=/);
  const planToken = converted.bookWorld["校园言情"].requestInfo.match(/plan=([A-Za-z0-9_-]+)/)[1];
  const plan = decodeBridgePlan(planToken);
  assert.equal(plan.charset, "gbk");
  assert.deepEqual(xiangseEncodeFields("gbk"), {
    requestParamsEncode: XIANGSE_GBK_ENCODE,
    responseEncode: XIANGSE_GBK_ENCODE,
  });
  const nativePlan = compileBookBridgePlan({
    host: "https://www.xyushuwu5.com",
    responseFormatType: "html",
    responseEncode: XIANGSE_GBK_ENCODE,
    list: "//li",
    bookName: ".//a",
    detailUrl: ".//a/@href",
  });
  assert.equal(nativePlan.charset, "gbk");
});
