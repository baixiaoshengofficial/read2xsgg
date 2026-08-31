import assert from "node:assert/strict";
import test from "node:test";
import { isDateOnlyMetadata } from "../src/elementValidation.js";

test("isDateOnlyMetadata distinguishes update timestamps from chapter titles", () => {
  assert.equal(isDateOnlyMetadata("2026-08-20 01:55"), true);
  assert.equal(isDateOnlyMetadata("2026年8月20日"), true);
  assert.equal(isDateOnlyMetadata("2026-08-20 01:55 第七百二十一章 公平一战！"), false);
});
