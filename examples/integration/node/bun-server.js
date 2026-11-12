// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// In-process Bun streaming server: the `streaming-server.js` journey on
// `Bun.serve` instead of `node:http`.
//
// `protocol.streamResponse()` returns a session whose methods *return* bytes,
// so the transport stays here. Bun pulls the body from an async generator: the
// generator only resumes when the socket wants more, which is the backpressure
// contract, and Bun calls `return()` at the pending `yield` when the client
// leaves. `request.signal` ends the waits between chunks on disconnect.
//
// Prerequisites:
//   1. Install dependencies:  bun install
//   2. Build the packages:    bun run --filter @microsoft/webui --filter @microsoft/webui-framework build
//   3. Native addon: the @microsoft/webui-<platform> package, a cargo build of
//      microsoft-webui-node, or WEBUI_ADDON_PATH pointing at a webui.node.
//
// Usage:
//   bun bun-server.js [--port 3041] [--batch-delay-ms 600] [--job-delay-ms 1500]

import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build, Protocol } from "@microsoft/webui";

const options = parseOptions(process.argv.slice(2));

const frameworkDir = dirname(fileURLToPath(import.meta.resolve("@microsoft/webui-framework")));
const appDir = resolve(import.meta.dirname, "streaming-app");

// Compile once at startup; every request shares the immutable protocol.
const result = build({ appDir, plugin: "webui", css: "style" });
const protocol = new Protocol(result.protocol, { plugin: "webui" });

const LOG_BATCHES = [
  [
    { level: "info", text: "resolving workspace" },
    { level: "info", text: "restoring 412 packages" },
  ],
  [
    { level: "info", text: "compiling 87 modules" },
    { level: "warn", text: "unused import in src/legacy.ts" },
  ],
  [
    { level: "info", text: "bundling client entry" },
    { level: "info", text: "done in 4.1s" },
  ],
];

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: options.port,
  routes: {
    "/": {
      GET: (request) =>
        new Response(streamPage(request.signal), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
          },
        }),
    },
    "/framework/*": {
      GET: (request) => sendFrameworkModule(new URL(request.url).pathname.slice("/framework/".length)),
    },
  },
  fetch(request) {
    return request.method === "GET"
      ? text(404, "Not Found")
      : text(405, "Method Not Allowed");
  },
  error(error) {
    console.error(`streaming request failed: ${error instanceof Error ? error.message : String(error)}`);
    return text(500, "Internal Server Error");
  },
});

console.log(`Bun streaming server on ${server.url}`);

/**
 * Yield one progressive response, one chunk per session call.
 *
 * A throw before the first `yield` becomes a 500 through `error()`. After the
 * first chunk the status line is committed, so Bun drops the connection.
 */
async function* streamPage(signal) {
  const session = protocol.streamResponse({ entry: "index.html", requestPath: "/" });

  let step = session.start({ jobState: "running", jobDetail: "" });
  yield step.bytes;

  const jobStatus = pendingBoundary(step, "job-status");
  step = session.resume(
    jobStatus.instanceId,
    { jobState: "running", jobDetail: "starting" },
    "updatable",
  );
  yield step.bytes;

  // Started, not awaited: the job races the log batches below.
  const job = runSlowJob(options.jobDelayMs, signal);
  let jobPending = true;

  for (let index = 0; index < LOG_BATCHES.length; index++) {
    const batch = delay(options.batchDelayMs, signal).then(() => "batch");

    if (jobPending) {
      const ready = await Promise.race([job, batch]);
      if (ready !== "batch") {
        // Patch the committed boundary on this same response.
        yield session.update(jobStatus.instanceId, ready);
        jobPending = false;
        await batch;
      }
    } else {
      await batch;
    }

    if (index === LOG_BATCHES.length - 1 && jobPending) {
      yield session.update(jobStatus.instanceId, await job);
      jobPending = false;
    }
    step = session.advance();
    yield step.bytes;
    const boundary = pendingBoundary(step, `log-batch-${index + 1}`);
    step = session.resume(boundary.instanceId, {
      [`batch${index + 1}`]: LOG_BATCHES[index],
    });
    yield step.bytes;
  }

  step = session.advance();
  yield step.bytes;
  if (!step.done) {
    throw new Error("streaming session did not complete after advancing the final log batch");
  }
}

function pendingBoundary(step, expectedName) {
  const boundary = step.boundary;
  if (step.done || !boundary) {
    throw new Error(`expected pending boundary ${expectedName}, but the stream is done`);
  }
  if (boundary.owner !== "index.html" || boundary.name !== expectedName) {
    throw new Error(
      `expected index.html/${expectedName}, received ${boundary.owner}/${boundary.name}`,
    );
  }
  return boundary;
}

async function runSlowJob(delayMs, signal) {
  await delay(delayMs, signal);
  return { jobState: "succeeded", jobDetail: "3 targets built" };
}

async function sendFrameworkModule(relativePath) {
  // Contain the served path to the framework's own output directory.
  const target = join(frameworkDir, normalize(relativePath));
  if (!target.startsWith(frameworkDir + sep) || !target.endsWith(".js")) {
    return text(404, "Not Found");
  }
  const file = Bun.file(target);
  if (!(await file.exists())) {
    return text(404, "Not Found");
  }
  return new Response(file, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function delay(milliseconds, signal) {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal.aborted) {
      rejectDelay(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function text(status, body) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function parseOptions(args) {
  return {
    port: numberOption(args, "--port", 3041),
    batchDelayMs: numberOption(args, "--batch-delay-ms", 600),
    jobDelayMs: numberOption(args, "--job-delay-ms", 1500),
  };
}

function numberOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = Number(args[index + 1]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} requires a non-negative integer`);
  }
  return value;
}
