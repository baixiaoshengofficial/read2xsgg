import assert from "node:assert/strict";
import test from "node:test";
import {
  compileMediaExtractionPlan,
  compileMediaResolutionFromRule,
  declaredMediaResolution,
  decodeMediaExtractionPlan,
  encodeMediaExtractionPlan,
  executeMediaResolution,
  mediaPlanHasResolution,
  mediaPlanIsLegacyHrefOnly,
  mediaRuleNeedsPortabilityWarning,
  MEDIA_PORTABILITY_WARNING,
  MEDIA_RECONVERSION_DIAGNOSTIC,
  pageMediaUrls,
  resolveChapterMediaUrls,
} from "../src/index.js";

const SAMPLE_RESOLUTION = {
  extract: [{ name: "token", source: "meta", key: "_t" }],
  request: { url: "{{origin}}/play", method: "POST", body: "t={{token}}" },
  response: { properties: ["url"] },
};

test("declaredMediaResolution：从 ruleContent / nested read2xsgg / 源根提取声明", () => {
  assert.equal(declaredMediaResolution(null), null);
  assert.deepEqual(
    declaredMediaResolution({ ruleContent: { mediaResolution: SAMPLE_RESOLUTION } }),
    SAMPLE_RESOLUTION,
  );
  assert.deepEqual(
    declaredMediaResolution({
      contentRule: { read2xsgg: { mediaResolution: SAMPLE_RESOLUTION } },
    }),
    SAMPLE_RESOLUTION,
  );
  assert.deepEqual(
    declaredMediaResolution({ read2xsgg: { mediaResolution: SAMPLE_RESOLUTION } }),
    SAMPLE_RESOLUTION,
  );
  assert.deepEqual(
    declaredMediaResolution({ mediaResolution: SAMPLE_RESOLUTION }),
    SAMPLE_RESOLUTION,
  );
  // Prefer rule-object declaration over a conflicting source-root bag.
  assert.equal(
    declaredMediaResolution({
      ruleContent: { mediaResolution: SAMPLE_RESOLUTION },
      read2xsgg: { mediaResolution: { ...SAMPLE_RESOLUTION, request: { url: "{{origin}}/other" } } },
    }).request.url,
    "{{origin}}/play",
  );
});

test("媒体提取计划只保留安全字段和属性提示", () => {
  const plan = compileMediaExtractionPlan(`
    @js:var url = JSON.parse(src).data.playPath; java.lang.Runtime.getRuntime().exec('bad');
    audio@data-url
  `, "audio", { "User-Agent": "AudioClient/1", "Content-Length": "999" });
  assert.equal(plan.kind, "audio");
  assert.ok(plan.properties.includes("playPath"));
  assert.ok(plan.attributes.includes("data-url"));
  assert.deepEqual(plan.headers, { "User-Agent": "AudioClient/1" });
  assert.equal(plan.resolution, undefined);
  assert.deepEqual(decodeMediaExtractionPlan(encodeMediaExtractionPlan(plan), "audio"), plan);
  assert.doesNotMatch(Buffer.from(encodeMediaExtractionPlan(plan), "base64url").toString("utf8"), /Runtime|exec|bad/);
});

test("通用媒体提取支持 JSON、HTML 标签和脚本 URL", () => {
  const audioPlan = compileMediaExtractionPlan("$.data.trackUrl", "audio");
  assert.deepEqual(pageMediaUrls(JSON.stringify({ data: { trackUrl: "/media/voice.m4a" } }), "https://audio.example/chapter/1", audioPlan), [
    "https://audio.example/media/voice.m4a",
  ]);

  const videoPlan = compileMediaExtractionPlan("iframe@src", "video");
  assert.deepEqual(pageMediaUrls('<iframe src="/player?id=1"></iframe><script>var backup="https:\\/\\/cdn.example\\/movie.m3u8"</script>', "https://video.example/episode/1", videoPlan), [
    "https://cdn.example/movie.m3u8",
    "https://video.example/player?id=1",
  ]);
});

test("媒体直链无需下载页面即可识别", () => {
  assert.deepEqual(pageMediaUrls("", "https://cdn.example/audio/file.mp3?token=x", { kind: "audio" }), [
    "https://cdn.example/audio/file.mp3?token=x",
  ]);
  assert.deepEqual(pageMediaUrls("", "https://cdn.example/live/master.m3u8", { kind: "video" }), [
    "https://cdn.example/live/master.m3u8",
  ]);
});

test("音频支持 HLS/DASH 并优先较高质量字段", () => {
  const payload = JSON.stringify({
    soundurl: "https://cdn.example/audio.m3u8?quality=64",
    soundurl_128: "https://cdn.example/audio.m3u8?quality=128",
    videourl: "https://cdn.example/video.mp4",
  });
  assert.deepEqual(pageMediaUrls(payload, "https://audio.example/chapter", { kind: "audio" }), [
    "https://cdn.example/audio.m3u8?quality=128",
    "https://cdn.example/audio.m3u8?quality=64",
  ]);
});

test("sourceRegex 扩展名提示进入提取计划并优先匹配", () => {
  const plan = compileMediaExtractionPlan("audio@src", "audio", {}, { sourceRegex: ".*\\.mp3.*" });
  assert.deepEqual(plan.urlHints, [".mp3"]);
  const html = `
    <script>var a="https://cdn.example/preview.m4a"; var b="https://cdn.example/play.mp3?token=1";</script>
  `;
  assert.equal(pageMediaUrls(html, "https://audio.example/chapter", plan)[0], "https://cdn.example/play.mp3?token=1");
});

test("通用媒体扫描不把章节页普通链接当成播放地址", () => {
  // Bare-URL scanner must not treat ordinary page/navigation hrefs as playable
  // just because the synthetic key "media" is semantic.
  const html = `
    <link rel="alternate" href="https://m.example.com/book/14917-1">
    <a href="https://audio.example.com/book/14917-2">下一集</a>
    <meta name="_f" content="mp3"/>
  `;
  const plan = { kind: "audio", properties: [], attributes: ["href"], urlHints: [] };
  assert.deepEqual(pageMediaUrls(html, "https://audio.example.com/book/14917-1", plan), []);
});

test("legacy href-only 计划不把章节 HTML / iframe 当成播放地址", () => {
  const plan = { version: 1, kind: "audio", properties: [], attributes: ["href"], urlHints: [] };
  assert.equal(mediaPlanIsLegacyHrefOnly(plan), true);
  assert.equal(
    mediaPlanIsLegacyHrefOnly({ kind: "audio", properties: ["path"], attributes: ["href"] }),
    false,
  );
  assert.match(MEDIA_RECONVERSION_DIAGNOSTIC, /重新转换/);

  const html = `
    <link rel="alternate" href="https://m.example.com/book/14917-1">
    <iframe src="https://audio.example.com/book/14917-1"></iframe>
    <a href="https://audio.example.com/book/14917-2">下一集</a>
    <meta name="_f" content="mp3"/>
  `;
  assert.deepEqual(pageMediaUrls(html, "https://audio.example.com/book/14917-1", plan), []);
  // Real media still wins even under a legacy plan.
  assert.deepEqual(
    pageMediaUrls(
      `${html}<script>var u="https://cdn.example/a.mp3"</script>`,
      "https://audio.example.com/book/14917-1",
      plan,
    ),
    ["https://cdn.example/a.mp3"],
  );
});

const TWO_STEP_RULE = `
[name="_token"]@content@js:
var body=baseUrl.replace(/.+\\/item\\/(\\d+)-(\\d+)/,"id=$1&page=$2");
var url="/api/play,";
var headers={
  "Content-Type":"application/x-www-form-urlencoded",
  Referer:baseUrl,
  "X-Token":result
};
var options={
  method:"post",
  headers:JSON.stringify(headers),
  body:body
};
JSON.parse(java.ajax(url+JSON.stringify(options))).playUrl
`;

test("可识别的多步媒体规则编译为声明式 MediaResolutionPlan", () => {
  const resolution = compileMediaResolutionFromRule(TWO_STEP_RULE);
  assert.ok(resolution);
  assert.deepEqual(resolution.extract[0], { name: "result", source: "meta", key: "_token" });
  assert.equal(resolution.request.url, "{{origin}}/api/play");
  assert.equal(resolution.request.method, "POST");
  assert.equal(resolution.request.headers["X-Token"], "{{result}}");
  assert.equal(resolution.request.headers.Referer, "{{chapterUrl}}");
  assert.match(resolution.request.body, /id=\{\{g1\}\}/);
  assert.match(resolution.request.body, /page=\{\{g2\}\}/);
  assert.deepEqual(resolution.response.properties, ["playUrl"]);

  const plan = compileMediaExtractionPlan(TWO_STEP_RULE, "audio");
  assert.ok(mediaPlanHasResolution(plan));
  assert.deepEqual(
    decodeMediaExtractionPlan(encodeMediaExtractionPlan(plan), "audio").resolution,
    plan.resolution,
  );
});

test("两步媒体计划执行器按声明取 meta、POST 并选择 JSON URL", async () => {
  const plan = compileMediaExtractionPlan(TWO_STEP_RULE, "audio");
  const html = `
    <html><head><meta name="_token" content="secret-token"/></head>
    <body><a href="/item/9-2">下一集</a></body></html>
  `;
  const calls = [];
  const urls = await executeMediaResolution(
    html,
    "https://media.example/item/42-7",
    plan,
    async (url, init = {}) => {
      calls.push({ url, init });
      return Buffer.from(JSON.stringify({ playUrl: "https://cdn.example/a/42.mp3", url: "https://cdn.example/b.mp3" }));
    },
  );
  assert.deepEqual(urls, ["https://cdn.example/a/42.mp3"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://media.example/api/play");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["X-Token"], "secret-token");
  assert.equal(calls[0].init.headers.Referer, "https://media.example/item/42-7");
  assert.match(String(calls[0].init.body), /id=42/);
  assert.match(String(calls[0].init.body), /page=7/);
});

test("两步媒体解析仅向同源请求继承章节响应的会话 Cookie", async () => {
  const plan = compileMediaExtractionPlan(TWO_STEP_RULE, "audio");
  const page = Buffer.from('<meta name="_token" content="session-token"/>');
  Object.defineProperty(page, "httpHeaders", {
    value: { "set-cookie": ["sid=chapter-session; Path=/; HttpOnly", "visit=1; Path=/"] },
  });
  const calls = [];
  const urls = await resolveChapterMediaUrls(
    page,
    "https://media.example/item/42-7",
    plan,
    async (url, init = {}) => {
      calls.push({ url, init });
      return Buffer.from(JSON.stringify({ playUrl: "https://cdn.example/a/42.mp3" }));
    },
    pageMediaUrls,
  );
  assert.deepEqual(urls, ["https://cdn.example/a/42.mp3"]);
  assert.equal(calls[0].init.headers.Cookie, "sid=chapter-session; visit=1");

  const crossOriginPlan = {
    ...plan,
    resolution: { ...plan.resolution, request: { ...plan.resolution.request, url: "https://other.example/play" } },
  };
  await resolveChapterMediaUrls(
    page,
    "https://media.example/item/42-7",
    crossOriginPlan,
    async (_url, init = {}) => {
      assert.equal(Object.keys(init.headers).some((name) => name.toLowerCase() === "cookie"), false);
      return Buffer.from(JSON.stringify({ playUrl: "https://cdn.example/a/42.mp3" }));
    },
    pageMediaUrls,
  );
});

test("无 resolution 时回退通用页面扫描；空计划不猜测受保护网关", async () => {
  const html = `
    <html><head><meta name="_token" content="x"/></head>
    <body><script>var u="https://cdn.example/direct.mp3"</script></body></html>
  `;
  const scrapePlan = { kind: "audio", properties: [], attributes: [], urlHints: [".mp3"] };
  const scraped = await resolveChapterMediaUrls(
    html,
    "https://media.example/item/1-1",
    scrapePlan,
    async () => { throw new Error("download should not run without resolution"); },
    pageMediaUrls,
  );
  assert.deepEqual(scraped, ["https://cdn.example/direct.mp3"]);

  const emptyPlan = { kind: "audio", properties: [], attributes: ["href"], urlHints: [] };
  const empty = await resolveChapterMediaUrls(
    html.replace("direct.mp3", "next"),
    "https://media.example/item/1-1",
    emptyPlan,
    async () => { throw new Error("must not invent follow-up requests"); },
    pageMediaUrls,
  );
  assert.deepEqual(empty, []);
});

test("直链章节不触发懒加载页面正文", async () => {
  let loaded = false;
  const urls = await resolveChapterMediaUrls(
    async () => {
      loaded = true;
      return "<html></html>";
    },
    "https://cdn.example/live/master.m3u8?token=abc",
    { kind: "video", properties: [], attributes: [], urlHints: [] },
    async () => { throw new Error("follow-up download must not run"); },
    pageMediaUrls,
  );
  assert.deepEqual(urls, ["https://cdn.example/live/master.m3u8?token=abc"]);
  assert.equal(loaded, false);
});

test("WebView/sourceRegex 且无可编译多步流程时给出可移植性警告条件", () => {
  assert.equal(
    mediaRuleNeedsPortabilityWarning(
      { content: "<js>result</js>", sourceRegex: ".*\\.(mp3|m4a).*" },
      { chapterUrl: "tag.a@href@js:result+',{webView:true}'" },
      compileMediaExtractionPlan("<js>result</js>", "audio", {}, { sourceRegex: ".*\\.mp3.*" }),
    ),
    true,
  );
  assert.equal(
    mediaRuleNeedsPortabilityWarning(
      { content: "audio@src", sourceRegex: ".*\\.mp3.*" },
      { chapterUrl: "href" },
      compileMediaExtractionPlan("audio@src", "audio", {}, { sourceRegex: ".*\\.mp3.*" }),
    ),
    false,
  );
  assert.match(MEDIA_PORTABILITY_WARNING, /重新转换/);
});

test("含加密/不可识别脚本的 ajax 规则不猜测协议，只给出可移植性诊断", () => {
  const opaque = `@js:
var body=java.hexDecode(result)+Packages.encrypt(baseUrl);
JSON.parse(java.ajax("/secret,"+body)).ourl
`;
  assert.equal(compileMediaResolutionFromRule(opaque), null);
  const plan = compileMediaExtractionPlan(opaque, "audio");
  assert.equal(plan.resolution, undefined);
  assert.equal(
    mediaRuleNeedsPortabilityWarning({ content: opaque }, { chapterUrl: "href" }, plan),
    true,
  );
});
