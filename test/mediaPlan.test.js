import assert from "node:assert/strict";
import test from "node:test";
import {
  compileMediaExtractionPlan,
  decodeMediaExtractionPlan,
  encodeMediaExtractionPlan,
  pageMediaUrls,
} from "../src/index.js";

test("媒体提取计划只保留安全字段和属性提示", () => {
  const plan = compileMediaExtractionPlan(`
    @js:var url = JSON.parse(src).data.playPath; java.lang.Runtime.getRuntime().exec('bad');
    audio@data-url
  `, "audio", { "User-Agent": "AudioClient/1", "Content-Length": "999" });
  assert.equal(plan.kind, "audio");
  assert.ok(plan.properties.includes("playPath"));
  assert.ok(plan.attributes.includes("data-url"));
  assert.deepEqual(plan.headers, { "User-Agent": "AudioClient/1" });
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
