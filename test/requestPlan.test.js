import assert from "node:assert/strict";
import test from "node:test";
import {
  compileSignedRequestPlan,
  decodeSignedRequestPlan,
  encodeSignedRequestPlan,
  signedRequestTarget,
} from "../src/requestPlan.js";
import { refreshEphemeralHeaders } from "../src/requests.js";
import { normalizeDownloadArgs } from "../src/httpTransport.js";

const SEARCH_RULE = `<js>
body = "keyword="+key+"&page="+page+"&size=20&type=2";
url = "https://api.example/walkman/search?"+body;
sign = java.md5Encode(body+"test-secret")
headers = {"headers":{"signature":String(sign)}}
url+","+JSON.stringify(headers)
</js>`;

test("查询串 MD5 请求头脚本编译为受限请求计划", () => {
  const plan = compileSignedRequestPlan(SEARCH_RULE);
  assert.deepEqual(plan, {
    version: 1,
    endpoint: "https://api.example/walkman/search?",
    query: "keyword={{keyWord}}&page={{pageIndex}}&size=20&type=2",
    signatureHeader: "signature",
    signaturePrefix: "",
    signatureSuffix: "test-secret",
  });
  assert.deepEqual(decodeSignedRequestPlan(encodeSignedRequestPlan(plan)), plan);
  const target = signedRequestTarget(plan, { keyWord: "测试", pageIndex: 3 });
  assert.equal(target.url, "https://api.example/walkman/search?keyword=%E6%B5%8B%E8%AF%95&page=3&size=20&type=2");
  assert.match(target.headers.signature, /^[a-f0-9]{32}$/);
});

test("条目字段签名脚本保留字段占位符", () => {
  const plan = compileSignedRequestPlan(`<js>
    body = "album_id={{$.album_id}}";
    url = "https://api.example/album/audio?"+body;
    sign = java.md5Encode(body+"test-secret");
    headers = {"headers":{"signature":String(sign)}};
  </js>`);
  assert.equal(plan.valueField, "album_id");
  assert.equal(
    signedRequestTarget(plan, { value: "A-42" }).url,
    "https://api.example/album/audio?album_id=A-42",
  );
});

test("时间戳型匿名请求头按通用规则刷新", () => {
  assert.deepEqual(refreshEphemeralHeaders({
    visitor_id: "1700000000000",
    device_id: "ordinary-device",
    Authorization: "1700000000000",
  }, 1800000000000), {
    visitor_id: "1800000000000",
    device_id: "ordinary-device",
    Authorization: "1700000000000",
  });
});

test("下载参数保留取消信号", () => {
  const controller = new AbortController();
  const positional = normalizeDownloadArgs({ Referer: "https://example.com" }, {
    method: "POST",
    body: "page=1",
    signal: controller.signal,
  });
  assert.equal(positional.signal, controller.signal);

  const init = normalizeDownloadArgs({
    headers: { Accept: "application/json" },
    signal: controller.signal,
  });
  assert.equal(init.signal, controller.signal);
  assert.deepEqual(init.headers, { Accept: "application/json" });
});
