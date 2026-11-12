// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Bundler-neutral projection from an esbuild-compatible metafile.
 *
 * esbuild and Bun both describe a build with `inputs` (module graph) and
 * `outputs` (emitted files, their member inputs, and their import edges).
 * The official adapters translate their bundler's build into a
 * {@link MetafileBuild} and share everything after that.
 */

import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import * as path from "node:path";
import type {
  AdapterContext,
  ModuleKind,
  ModuleNode,
  ResolvedImport,
} from "../graph.js";
import { mapConcurrent } from "../concurrency.js";
import { resolveBuildRoot } from "../build-root.js";
import {
  ProjectionError,
  createDiagnostic,
} from "../diagnostics.js";
import {
  compareUtf8,
  serializeManifestCanonical,
} from "../manifest.js";
import { compileProjection } from "../loader.js";

/** One import edge of a metafile input. */
export interface MetafileInputImport {
  readonly path: string;
  readonly kind: string;
  readonly external?: boolean;
  readonly original?: string;
}

/** One import edge of a metafile output. */
export interface MetafileOutputImport {
  readonly path: string;
  readonly kind: string;
  readonly external?: boolean;
}

/** The subset of an esbuild-compatible metafile that projection reads. */
export interface ProjectionMetafile {
  readonly inputs: {
    readonly [path: string]: {
      readonly bytes: number;
      readonly imports: ReadonlyArray<MetafileInputImport>;
      readonly format?: string;
    };
  };
  readonly outputs: {
    readonly [path: string]: {
      readonly bytes: number;
      readonly inputs: { readonly [path: string]: unknown };
      readonly imports: ReadonlyArray<MetafileOutputImport>;
      readonly entryPoint?: string;
    };
  };
}

/** Source text for an input that has no file on disk (esbuild `stdin`). */
export interface MetafileVirtualSource {
  readonly id: string;
  readonly contents: string;
}

/** A finished bundler run, described in bundler-neutral terms. */
export interface MetafileBuild {
  /** Adapter and bundler name recorded in the manifest, e.g. `"bun"`. */
  readonly bundlerName: string;
  readonly bundlerVersion: string;
  readonly metafile: ProjectionMetafile;
  /** Absolute directory that metafile input ids are relative to. */
  readonly inputBase: string;
  /** Absolute directory that metafile output ids are relative to. */
  readonly outputBase: string;
  /** Absolute manifest path. */
  readonly manifestPath: string;
  /** Emitted bytes kept in memory; outputs missing here are read from disk. */
  readonly outputFiles?: Iterable<{
    readonly path: string;
    readonly contents: Uint8Array;
  }>;
  readonly publicPath?: string | undefined;
  /** Input ids that are virtual even when a file of that name exists. */
  readonly virtualSources?: ReadonlyArray<MetafileVirtualSource>;
  /** Bundler-internal import specifiers that are not part of the graph. */
  readonly internalImports?: ReadonlySet<string>;
}

interface InputRecord {
  readonly metafileId: string;
  readonly moduleId: string;
  readonly kind: ModuleKind;
  readonly source: string | undefined;
  readonly packageName: string | undefined;
}

const MAX_CONCURRENT_SOURCE_READS = 64;
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
let temporaryFileSequence = 0;

/** Compile and atomically write the projection manifest for one build. */
export async function emitMetafileProjection(
  build: MetafileBuild
): Promise<void> {
  const profile = process.env["WEBUI_PROJECTION_PROFILE"] === "1";
  const profileStart = profile ? performance.now() : 0;
  const { metafile, manifestPath } = build;

  const outputIds = outputPaths(build.outputBase, metafile);
  if (
    [...outputIds.values()].some((outputId) =>
      samePath(outputId, manifestPath)
    )
  ) {
    throw adapterError(
      `the projection manifest path collides with a ${build.bundlerName} build output`,
      "Choose a distinct manifest filename such as dist/webui-projection.json."
    );
  }

  const packageCache = new Map<string, string | undefined>();
  const records = await loadInputRecords(build, packageCache);
  const graphReady = profile ? performance.now() : 0;
  const recordByMetafileId = new Map(
    records.map((record) => [record.metafileId, record])
  );
  const graph = buildModuleGraph(
    metafile,
    records,
    recordByMetafileId,
    build.internalImports
  );
  const membership = buildMembership(
    metafile,
    outputIds,
    recordByMetafileId
  );
  const outputContents = await loadOutputContents(
    build.outputFiles,
    outputIds
  );
  const rootDir = resolveBuildRoot([
    manifestPath,
    ...records
      .filter((record) => record.kind === "file")
      .map((record) => record.moduleId),
    ...outputIds.values(),
  ]);

  const context: AdapterContext = {
    graph,
    membership,
    outputContents,
    entryClosures: buildEntryClosures(
      metafile,
      outputIds,
      build.publicPath
    ),
    rootDir,
    manifestPath,
    bundlerName: build.bundlerName,
    bundlerVersion: build.bundlerVersion,
  };
  const manifest = await compileProjection(context);
  const compiled = profile ? performance.now() : 0;
  await writeAtomic(
    manifestPath,
    serializeManifestCanonical(manifest)
  );
  if (profile) {
    const finished = performance.now();
    console.error(
      `[webui-projection] graph=${(graphReady - profileStart).toFixed(1)}ms compile=${(compiled - graphReady).toFixed(1)}ms write=${(finished - compiled).toFixed(1)}ms total=${(finished - profileStart).toFixed(1)}ms`
    );
  }
}

function outputPaths(
  outputBase: string,
  metafile: ProjectionMetafile
): Map<string, string> {
  const result = new Map<string, string>();
  for (const outputPath of Object.keys(metafile.outputs)) {
    result.set(
      outputPath,
      path.resolve(outputBase, outputPath)
    );
  }
  return result;
}

async function loadInputRecords(
  build: MetafileBuild,
  packageCache: Map<string, string | undefined>
): Promise<InputRecord[]> {
  const { metafile, bundlerName } = build;
  const virtualSources = new Map(
    (build.virtualSources ?? []).map((source) => [source.id, source.contents])
  );
  const entries = Object.keys(metafile.inputs).filter(
    (metafileId) =>
      metafile.inputs[metafileId]?.format !== undefined &&
      (virtualSources.has(metafileId) ||
        isProjectionSourceId(metafileId))
  );
  const records = await mapConcurrent(
    entries,
    MAX_CONCURRENT_SOURCE_READS,
    async (metafileId) => {
      const virtualSource = virtualSources.get(metafileId);
      if (virtualSource !== undefined) {
        return {
          metafileId,
          moduleId: virtualModuleId(bundlerName, metafileId),
          kind: "virtual" as const,
          source: virtualSource,
          packageName: undefined,
        };
      }

      const filePath = path.resolve(build.inputBase, metafileId);
      const source = await readPhysicalSource(filePath);
      if (source !== undefined) {
        return {
          metafileId,
          moduleId: filePath,
          kind: "file" as const,
          source,
          packageName: undefined,
        };
      }

      return {
        metafileId,
        moduleId: virtualModuleId(bundlerName, metafileId),
        kind: "virtual" as const,
        source: undefined,
        packageName: undefined,
      };
    }
  );
  const resolved: InputRecord[] = [];
  for (const record of records) {
    resolved.push(
      record.kind === "file"
        ? {
            ...record,
            packageName: await nearestPackageName(
              record.moduleId,
              packageCache
            ),
          }
        : record
    );
  }
  return resolved;
}

async function readPhysicalSource(
  filePath: string
): Promise<string | undefined> {
  try {
    const bytes = await readFile(filePath);
    return bytes.toString("utf8");
  } catch (error: unknown) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function buildModuleGraph(
  metafile: ProjectionMetafile,
  records: ReadonlyArray<InputRecord>,
  recordByMetafileId: ReadonlyMap<string, InputRecord>,
  internalImports: ReadonlySet<string> | undefined
): AdapterContext["graph"] {
  const modules = new Map<string, ModuleNode>();
  for (const record of records) {
    const input = metafile.inputs[record.metafileId]!;
    const imports = input.imports
      .filter((entry) => !internalImports?.has(entry.path))
      .map((entry) => resolvedImport(entry, recordByMetafileId));
    modules.set(record.moduleId, {
      id: record.moduleId,
      kind: record.kind,
      ...packageNameProperty(record.packageName),
      source: record.source,
      imports,
    });
  }

  const entries = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    if (!output.entryPoint) continue;
    const record = recordByMetafileId.get(output.entryPoint);
    if (record) entries.add(record.moduleId);
  }
  return {
    modules,
    entries: [...entries].sort(comparePaths),
  };
}

function resolvedImport(
  entry: MetafileInputImport,
  recordByMetafileId: ReadonlyMap<string, InputRecord>
): ResolvedImport {
  const target = entry.external
    ? undefined
    : recordByMetafileId.get(entry.path);
  // Non-source inputs stay in the bundler's graph but are external to
  // projection's JavaScript/TypeScript symbol graph.
  const external = entry.external === true || target === undefined;
  return {
    specifier: entry.original ?? entry.path,
    resolvedId: external ? undefined : target.moduleId,
    external,
    kind:
      entry.kind === "dynamic-import" ? "dynamic" : "static",
    ...packageNameProperty(
      target?.packageName ??
        (entry.external ? packageNameFromSpecifier(entry.path) : undefined)
    ),
  };
}

function isProjectionSourceId(
  moduleId: string
): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(moduleId));
}

function packageNameProperty(
  packageName: string | undefined
): { readonly packageName?: string } {
  return packageName === undefined ? {} : { packageName };
}

function buildMembership(
  metafile: ProjectionMetafile,
  outputIds: ReadonlyMap<string, string>,
  recordByMetafileId: ReadonlyMap<string, InputRecord>
): AdapterContext["membership"] {
  const outputs = new Map<string, ReadonlySet<string>>();
  for (const [outputPath, metadata] of Object.entries(
    metafile.outputs
  )) {
    const outputId = outputIds.get(outputPath);
    if (!outputId) continue;
    const members = new Set<string>();
    for (const inputPath of Object.keys(metadata.inputs)) {
      const record = recordByMetafileId.get(inputPath);
      if (record) members.add(record.moduleId);
    }
    outputs.set(outputId, members);
  }
  return { outputs };
}

/**
 * Computes each entry output's transitive static import closure, largest-first.
 *
 * A browser that fetches an entry module must also fetch every chunk the entry
 * reaches through static `import` statements before it can execute, and those
 * chunks are invisible to the preload scanner because they are named only
 * inside the entry's own bytes. Recording the closure here lets the handler
 * emit `modulepreload` hints without a second bundler pass.
 *
 * Ordering is the point, not a detail: preloads are issued in document order
 * over a shared connection, so a small chunk listed ahead of a large one
 * delays the long pole. Only the bundler knows the byte counts, so it sorts.
 */
function buildEntryClosures(
  metafile: ProjectionMetafile,
  outputIds: ReadonlyMap<string, string>,
  publicPath: string | undefined
): ReadonlyMap<string, ReadonlyArray<string>> {
  const closures = new Map<string, ReadonlyArray<string>>();
  for (const [outputPath, metadata] of Object.entries(metafile.outputs)) {
    if (metadata.entryPoint === undefined) continue;
    const entryId = outputIds.get(outputPath);
    if (!entryId) continue;
    if (publicPath) {
      // A public path changes the URL written into emitted import specifiers,
      // but the metafile still exposes local output paths. Until the manifest
      // carries served URLs, retaining an empty owner is safer than synthesizing
      // same-origin hrefs for potentially cross-origin chunks.
      closures.set(entryId, []);
      continue;
    }

    // Iterative worklist: an output import graph may contain cycles, and the
    // repo bans recursion in graph walks.
    const reached = new Set<string>([outputPath]);
    const pending = [outputPath];
    const members: string[] = [];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const imports = metafile.outputs[current]?.imports;
      if (!imports) continue;
      for (const edge of imports) {
        if (edge.kind !== "import-statement" || edge.external === true) {
          continue;
        }
        if (reached.has(edge.path)) continue;
        reached.add(edge.path);
        pending.push(edge.path);
        members.push(edge.path);
      }
    }
    members.sort((left, right) => {
      const bySize =
        (metafile.outputs[right]?.bytes ?? 0) -
        (metafile.outputs[left]?.bytes ?? 0);
      return bySize !== 0 ? bySize : compareUtf8(left, right);
    });

    const resolved: string[] = [];
    for (const member of members) {
      const memberId = outputIds.get(member);
      if (memberId) resolved.push(memberId);
    }
    closures.set(entryId, resolved);
  }
  return closures;
}

async function loadOutputContents(
  outputFiles: MetafileBuild["outputFiles"],
  outputIds: ReadonlyMap<string, string>
): Promise<ReadonlyMap<string, Uint8Array>> {
  const inMemory = new Map<string, Uint8Array>();
  for (const outputFile of outputFiles ?? []) {
    inMemory.set(pathKey(outputFile.path), outputFile.contents);
  }

  const contents = new Map<string, Uint8Array>();
  for (const outputId of outputIds.values()) {
    const memory = inMemory.get(pathKey(outputId));
    contents.set(
      outputId,
      memory ?? (await readFile(outputId))
    );
  }
  return contents;
}

async function nearestPackageName(
  filePath: string,
  cache: Map<string, string | undefined>
): Promise<string | undefined> {
  let directory = path.dirname(filePath);
  const visited: string[] = [];
  while (true) {
    if (cache.has(directory)) {
      const cached = cache.get(directory);
      for (const value of visited) cache.set(value, cached);
      return cached;
    }
    visited.push(directory);
    const packagePath = path.join(directory, "package.json");
    try {
      const text = await readFile(packagePath, "utf8");
      const parsed = JSON.parse(text) as { name?: unknown };
      const name =
        typeof parsed.name === "string" && parsed.name.length > 0
          ? parsed.name
          : undefined;
      for (const value of visited) cache.set(value, name);
      return name;
    } catch (error: unknown) {
      if (!isMissingFile(error)) {
        throw adapterError(
          `could not read package identity from '${packagePath}'`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      for (const value of visited) cache.set(value, undefined);
      return undefined;
    }
    directory = parent;
  }
}

function packageNameFromSpecifier(
  specifier: string
): string | undefined {
  if (
    specifier.length === 0 ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    path.isAbsolute(specifier)
  ) {
    return undefined;
  }
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    return segments.length >= 2
      ? `${segments[0]}/${segments[1]}`
      : undefined;
  }
  return segments[0];
}

function virtualModuleId(bundlerName: string, metafileId: string): string {
  return `\0${bundlerName}:${metafileId}`;
}

function comparePaths(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

/** Case-folded on Windows, where two spellings name one file. */
export function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
}

async function writeAtomic(
  manifestPath: string,
  contents: string
): Promise<void> {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const sequence = temporaryFileSequence++;
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${sequence}`;
  try {
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, manifestPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/** A PROJ-C013 adapter failure with a title and remediation. */
export function adapterError(
  title: string,
  help: string
): ProjectionError {
  return new ProjectionError([
    createDiagnostic("PROJ-C013", { help: `${title}. ${help}` }),
  ]);
}

function isMissingFile(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
