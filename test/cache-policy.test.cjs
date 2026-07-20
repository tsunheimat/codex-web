const assert = require("node:assert/strict");
const test = require("node:test");
const {
  cacheControlForRequestPath,
  cacheControlForResponse,
} = require("../src/server/cache-policy.js");

test("revalidates the shell and stable preload entry", () => {
  assert.equal(cacheControlForRequestPath("/"), "no-cache");
  assert.equal(cacheControlForRequestPath("/index.html"), "no-cache");
  assert.equal(
    cacheControlForRequestPath("/assets/preload.js?deploy=2"),
    "no-cache",
  );
  assert.equal(
    cacheControlForRequestPath("/assets/preload.js.map"),
    "no-cache",
  );
});

test("caches only content-hashed assets immutably", () => {
  assert.equal(
    cacheControlForRequestPath("/assets/page-BF1QkwFT.js"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(
    cacheControlForRequestPath("/assets/app-initial~app-main~page-BF1QkwFT.js"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(cacheControlForRequestPath("/manifest.json"), "no-cache");
  assert.equal(cacheControlForRequestPath("/assets/icon.png"), "no-cache");
});

test("does not cache an HTML or error fallback under a hash-shaped URL", () => {
  const path = "/assets/missing-BF1QkwFT.js";
  assert.equal(
    cacheControlForResponse(path, 200, "text/html; charset=utf-8"),
    "no-cache",
  );
  assert.equal(
    cacheControlForResponse(path, 404, "application/json; charset=utf-8"),
    "no-cache",
  );
  assert.equal(cacheControlForResponse(path, 200, undefined), "no-cache");
  assert.equal(
    cacheControlForResponse(path, 200, "text/javascript; charset=utf-8"),
    "public, max-age=31536000, immutable",
  );
});
