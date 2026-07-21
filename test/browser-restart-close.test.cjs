const assert = require("node:assert/strict");
const test = require("node:test");
const {
  closeBrowserContextWithinDeadline,
} = require("../scripts/test_browser_restart_lifecycle.cjs");

test(
  "restart Browser close timeout terminates only pre-identified Chromium processes",
  { timeout: 2_000 },
  async () => {
    const terminatedPids = [];
    const context = { close: () => new Promise(() => undefined) };

    await assert.rejects(
      closeBrowserContextWithinDeadline(context, {
        deadline: Date.now() + 100,
        ownedChromiumPids: new Set([101, 202]),
        terminateProcess: (pid) => terminatedPids.push(pid),
      }),
      /timed out closing restart lifecycle Browser context/,
    );
    assert.deepEqual(terminatedPids, [101, 202]);
  },
);
