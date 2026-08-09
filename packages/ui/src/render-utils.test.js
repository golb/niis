import assert from "node:assert/strict";
import test from "node:test";
import { escapeHtml } from "./render-utils.js";

test("escapeHtml encodes all five HTML-significant characters", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});
