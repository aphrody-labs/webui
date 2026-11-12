// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Run one application-owned Bun.build invocation with WebUI projection enabled.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

let buildTools;

function resolveImportEntry(require, packageName, subpath) {
  const packageSegments = packageName.split("/");
  for (const searchPath of require.resolve.paths(packageName) ?? []) {
    const packageRoot = path.join(searchPath, ...packageSegments);
    const packageJsonPath = path.join(packageRoot, "package.json");
    if (!existsSync(packageJsonPath)) continue;
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const target = packageJson.exports?.[subpath]?.import?.default;
    if (typeof target === "string") {
      return pathToFileURL(path.resolve(packageRoot, target)).href;
    }
  }
  throw new Error(
    `Cannot resolve ${packageName}${subpath.slice(1)} from ${process.cwd()}`,
  );
}

async function loadBuildTools() {
  if (buildTools) return buildTools;
  const require = createRequire(
    pathToFileURL(path.join(process.cwd(), "package.json")),
  );
  const { bunProjection } = await import(
    resolveImportEntry(require, "@microsoft/webui", "./projection.js")
  );
  const { prepareBuild } = await import(resolveImportEntry(require, "@microsoft/webui", "."));
  buildTools = { bunProjection, prepareBuild };
  return buildTools;
}

/** Compile templates once, bundle their generated inputs, then finalize projection. */
export async function runWebUIBuild({
  outdir = "dist",
  metafilePath,
  clientOptions = {},
  ...options
} = {}) {
  if (process.argv.includes("--watch")) {
    throw new Error("runWebUIBuild is a production build; use the existing client/server watchers for development.");
  }
  const { prepareBuild } = await loadBuildTools();
  const prepared = prepareBuild({
    appDir: "src",
    modulesOut: ".webui",
    ...options,
    metafile: Boolean(metafilePath),
  });
  prepared.writeModules();
  const manifest = path.join(outdir, "webui-projection.json");
  const client = await runWebUIClientBuild({
    outdir,
    ...clientOptions,
    projectionManifest: manifest,
  });
  const result = prepared.finish({ projectionManifests: [manifest] });
  mkdirSync(outdir, { recursive: true });
  for (let i = 0; i < result.cssFiles.length; i += 2) {
    writeFileSync(path.join(outdir, result.cssFiles[i]), result.cssFiles[i + 1]);
  }
  for (const pack of result.lazyPackFiles) {
    const file = path.join(outdir, pack.path);
    mkdirSync(path.dirname(file), { recursive: true });
    if (!existsSync(file) || readFileSync(file, "utf8") !== pack.content) {
      writeFileSync(file, pack.content);
    }
  }
  if (metafilePath) writeFileSync(metafilePath, result.metafile);
  for (const warning of result.warnings) console.warn(warning);
  const protocol = path.join(outdir, "protocol.bin");
  const staged = `${protocol}.${process.pid}.tmp`;
  writeFileSync(staged, result.protocol);
  renameSync(staged, protocol);
  return { result, client };
}

/**
 * Bundle the client with Bun.build.
 *
 * Options are Bun.build options. `entryPoints` (array, or an object whose keys
 * are the entry basenames), `absWorkingDir`, and relative `external` paths
 * are accepted for the callers that predate Bun. Production builds minify and set `__WEBUI_DEV__` to
 * `false`; `--watch` rebuilds on input changes with linked source maps.
 *
 * The returned `metafile` uses esbuild's convention of output paths relative
 * to the working directory, so existing metafile readers keep working.
 */
export async function runWebUIClientBuild(options = {}) {
  const { bunProjection } = await loadBuildTools();
  const watchMode = process.argv.includes("--watch");
  const {
    projectionManifest,
    plugins = [],
    entryPoints,
    entrypoints = entryPoints ?? ["src/index.ts"],
    absWorkingDir,
    external = [],
    ...bunOptions
  } = options;
  const relativeExternals = external.filter(isRelativeSpecifier);
  const workingDirectory = path.resolve(absWorkingDir ?? process.cwd());
  const fromWorkingDirectory = (file) => path.resolve(workingDirectory, file);
  const entries = entryList(entrypoints);
  const outdir = fromWorkingDirectory(bunOptions.outdir ?? "dist");
  const manifest = projectionManifest ? fromWorkingDirectory(projectionManifest) : undefined;

  const config = {
    target: "browser",
    format: "esm",
    splitting: true,
    minify: !watchMode,
    sourcemap: watchMode ? "linked" : "none",
    // The projection manifest drives server-emitted, size-ordered
    // `modulepreload` hints; Bun's injected preload runtime would duplicate them.
    modulePreload: false,
    ...bunOptions,
    entrypoints: entries.files.map(fromWorkingDirectory),
    outdir,
    // `import()` targets keep their module name (`lazy-panel.webui-<hash>.js`),
    // as with esbuild; Bun's default would call every chunk `chunk-<hash>.js`.
    naming: {
      chunk: "[name]-[hash].[ext]",
      ...entries.naming,
      ...(typeof bunOptions.naming === "object" ? bunOptions.naming : {}),
      ...(typeof bunOptions.naming === "string" ? { entry: bunOptions.naming } : {}),
    },
    external: external.filter((specifier) => !isRelativeSpecifier(specifier)),
    define: {
      ...(!watchMode ? { __WEBUI_DEV__: "false" } : {}),
      ...bunOptions.define,
    },
    metafile: true,
    plugins: [
      ...(relativeExternals.length ? [keepExternal(relativeExternals)] : []),
      ...plugins,
      bunProjection(manifest ? { manifest } : undefined),
    ],
  };

  if (watchMode) return watchBuild(config, workingDirectory);
  const result = await Bun.build(config);
  return { ...result, metafile: workingDirectoryMetafile(result.metafile, outdir, workingDirectory) };
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/** Bun.build matches `external` against bare specifiers only; keep exact relative imports too. */
function keepExternal(specifiers) {
  const exact = new Set(specifiers);
  return {
    name: "webui-relative-externals",
    setup(build) {
      build.onResolve({ filter: /^\.\.?\// }, (args) =>
        exact.has(args.path) ? { path: args.path, external: true } : undefined,
      );
    },
  };
}

/** Bun takes an entry list; an esbuild-style `{ name: file }` map names outputs by basename. */
function entryList(entrypoints) {
  if (Array.isArray(entrypoints)) return { files: entrypoints };
  const files = [];
  for (const [name, file] of Object.entries(entrypoints)) {
    if (path.basename(file, path.extname(file)) !== name) {
      throw new Error(
        `Entry '${name}' must match its file name (${file}): Bun names entry outputs by basename.`,
      );
    }
    files.push(file);
  }
  return { files, naming: { entry: "[name].[ext]" } };
}

/** Rewrite Bun's outdir-relative output ids to esbuild's working-directory-relative ids. */
function workingDirectoryMetafile(metafile, outdir, workingDirectory) {
  if (!metafile) return metafile;
  const rebase = (id) =>
    path.relative(workingDirectory, path.resolve(outdir, id)).split(path.sep).join("/");
  const outputs = {};
  for (const [id, output] of Object.entries(metafile.outputs)) {
    outputs[rebase(id)] = {
      ...output,
      imports: output.imports.map((entry) =>
        entry.external ? entry : { ...entry, path: rebase(entry.path) },
      ),
      ...(output.cssBundle ? { cssBundle: rebase(output.cssBundle) } : {}),
    };
  }
  return { ...metafile, outputs };
}

/** Rebuild whenever a directory that holds a bundled input changes. */
async function watchBuild(config, workingDirectory) {
  const watchers = new Map();
  let timer;
  let running = Promise.resolve();
  const rebuild = () => {
    running = running.then(async () => {
      try {
        const result = await Bun.build({ ...config, throw: false });
        for (const log of result.logs) console.error(log);
        if (result.metafile) track(result.metafile);
        console.error(`[webui] client ${result.success ? "rebuilt" : "build failed"}`);
      } catch (error) {
        console.error(error);
      }
    });
    return running;
  };
  const track = (metafile) => {
    for (const id of Object.keys(metafile.inputs)) {
      const directory = path.dirname(path.resolve(workingDirectory, id));
      if (watchers.has(directory) || directory.includes(`${path.sep}node_modules${path.sep}.bun${path.sep}`)) continue;
      if (!existsSync(directory)) continue;
      watchers.set(directory, watch(directory, () => {
        clearTimeout(timer);
        timer = setTimeout(rebuild, 50);
      }));
    }
  };
  await rebuild();
  return {
    rebuild,
    dispose() {
      clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  await runWebUIClientBuild();
}
