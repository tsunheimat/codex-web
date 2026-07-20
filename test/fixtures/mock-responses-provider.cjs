#!/usr/bin/env node

const http = require("node:http");

const scenarios = new Map(
  JSON.parse(process.env.CODEX_WEB_MOCK_SCENARIOS ?? "[]").map((scenario) => [
    scenario.token,
    {
      ...scenario,
      active: false,
      completedAt: null,
      firstChunkSentAt: null,
      requestCount: 0,
      startedAt: null,
    },
  ]),
);

let responseCounter = 0;
const sockets = new Set();
const timers = new Set();

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json",
  });
  response.end(body);
}

function writeSse(response, event) {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function completedEvent(responseId) {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function finishAssistantResponse(response, responseId, messageId, output) {
  writeSse(response, {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id: messageId,
      content: [{ type: "output_text", text: output }],
    },
  });
  writeSse(response, completedEvent(responseId));
  response.end();
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body === "" ? {} : JSON.parse(body);
}

function publicScenarioState(scenario) {
  return {
    token: scenario.token,
    active: scenario.active,
    completedAt: scenario.completedAt,
    firstChunkSentAt: scenario.firstChunkSentAt,
    requestCount: scenario.requestCount,
    startedAt: scenario.startedAt,
  };
}

async function handleResponsesRequest(request, response) {
  const requestBody = await readJsonBody(request);
  const serializedRequest = JSON.stringify(requestBody);
  const scenario = [...scenarios.values()]
    .map((candidate) => ({
      candidate,
      position: serializedRequest.lastIndexOf(candidate.token),
    }))
    .filter(({ position }) => position !== -1)
    .sort((left, right) => right.position - left.position)[0]?.candidate;
  const responseId = `resp-codex-web-${++responseCounter}`;
  const messageId = `msg-codex-web-${responseCounter}`;
  const output = scenario?.output ?? "CODEX_WEB_MOCK_BACKGROUND_RESPONSE";
  const delayMs = scenario?.delayMs ?? 0;
  const splitAt = Math.max(1, Math.floor(output.length / 2));

  if (scenario) {
    scenario.requestCount += 1;
    scenario.startedAt = Date.now();
    scenario.active = true;
  }

  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "close",
    "content-type": "text/event-stream",
  });
  writeSse(response, {
    type: "response.created",
    response: { id: responseId },
  });
  writeSse(response, {
    type: "response.output_item.added",
    item: {
      type: "message",
      role: "assistant",
      id: messageId,
      content: [{ type: "output_text", text: "" }],
    },
  });
  writeSse(response, {
    type: "response.output_text.delta",
    delta: output.slice(0, splitAt),
  });
  response.flushHeaders();

  if (scenario) {
    scenario.firstChunkSentAt = Date.now();
  }

  const timer = setTimeout(() => {
    timers.delete(timer);
    if (response.destroyed) {
      return;
    }
    writeSse(response, {
      type: "response.output_text.delta",
      delta: output.slice(splitAt),
    });
    finishAssistantResponse(response, responseId, messageId, output);
    if (scenario) {
      scenario.active = false;
      scenario.completedAt = Date.now();
    }
  }, delayMs);
  timers.add(timer);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/__control/state") {
      sendJson(response, 200, {
        pid: process.pid,
        scenarios: Object.fromEntries(
          [...scenarios].map(([token, scenario]) => [
            token,
            publicScenarioState(scenario),
          ]),
        ),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      sendJson(response, 200, {
        object: "list",
        data: [
          {
            id: "mock-model",
            object: "model",
            created: 0,
            owned_by: "codex-web-lifecycle-test",
          },
        ],
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/responses") {
      await handleResponsesRequest(request, response);
      return;
    }
    sendJson(response, 404, { error: "not found" });
  } catch (error) {
    sendJson(response, 500, { error: String(error) });
  }
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

function shutdown() {
  for (const timer of timers) {
    clearTimeout(timer);
  }
  timers.clear();
  server.close(() => process.exit(0));
  for (const socket of sockets) {
    socket.destroy();
  }
  setTimeout(() => process.exit(0), 1_000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock provider did not bind a TCP address");
  }
  process.send?.({
    type: "ready",
    baseUrl: `http://127.0.0.1:${address.port}`,
    pid: process.pid,
  });
});
