// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { runWebUIClientBuild } from "../../build-client.mjs";

await runWebUIClientBuild({
  entryPoints: ["src/app.ts", "src/service-worker.ts"],
  outdir: "public",
  external: ["./wasm/handler/webui_wasm_handler.js"],
});
