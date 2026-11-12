// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Official Bun adapter for bundler-neutral state projection.
 *
 * Add `bunProjection()` to `Bun.build({ plugins })`. The plugin turns on the
 * metafile, waits for the build, and writes the projection manifest from the
 * same run. A projection failure rejects the `Bun.build()` promise with a
 * `ProjectionError`.
 *
 * The types below are structural so the published declarations do not depend
 * on `@types/bun`; they are a subset of Bun's `BunPlugin` and `BuildOutput`.
 */

import * as path from "node:path";
import { preloadProjectionCompiler } from "../loader.js";
import {
  adapterError,
  emitMetafileProjection,
} from "./metafile.js";
import type { ProjectionMetafile } from "./metafile.js";

/** Configuration for the official Bun projection adapter. */
export interface BunProjectionOptions {
  /**
   * Manifest path. Relative values resolve from the current directory, like
   * Bun's own `outdir`.
   *
   * Defaults to `<outdir>/webui-projection.json`.
   */
  readonly manifest?: string;
}

/** The part of a Bun build artifact that projection reads. */
export interface BunProjectionArtifact {
  readonly path: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The part of Bun's `BuildOutput` that projection reads. */
export interface BunProjectionBuildOutput {
  readonly success: boolean;
  readonly outputs: ReadonlyArray<BunProjectionArtifact>;
  readonly metafile?: ProjectionMetafile | undefined;
}

/** The part of Bun's `PluginBuilder` that projection uses. */
export interface BunProjectionPluginBuild {
  readonly config: {
    outdir?: string | undefined;
    publicPath?: string | undefined;
    metafile?: unknown;
  };
  onEnd(
    callback: (result: BunProjectionBuildOutput) => void | Promise<void>
  ): unknown;
}

/** A `Bun.build()` plugin. */
export interface BunProjectionPlugin {
  readonly name: string;
  setup(build: BunProjectionPluginBuild): void;
}

/** Runtime helpers Bun links into bundles; not part of the module graph. */
const BUN_INTERNAL_IMPORTS: ReadonlySet<string> = new Set(["bun:wrap"]);

/** Create the official Bun projection plugin. */
export function bunProjection(
  options: BunProjectionOptions = {}
): BunProjectionPlugin {
  return {
    name: "webui-state-projection",
    setup(build) {
      // `true` or a metafile path both return the metafile on the result.
      if (!build.config.metafile) build.config.metafile = true;
      const compilerLoad = preloadProjectionCompiler().then(
        () => undefined,
        (error: unknown) => error
      );
      const outdir = build.config.outdir;
      const publicPath = build.config.publicPath;

      build.onEnd(async (result) => {
        if (!result.success) return;
        const compilerError = await compilerLoad;
        if (compilerError !== undefined) throw compilerError;
        const metafile = result.metafile;
        if (!metafile) {
          throw adapterError(
            "Bun did not return a metafile",
            "Do not disable metafile after bunProjection() configures the build."
          );
        }
        const workingDirectory = process.cwd();
        const outputFiles = await Promise.all(
          result.outputs.map(async (artifact) => ({
            path: path.resolve(outdir ?? workingDirectory, artifact.path),
            contents: new Uint8Array(await artifact.arrayBuffer()),
          }))
        );
        await emitMetafileProjection({
          bundlerName: "bun",
          bundlerVersion: process.versions["bun"] ?? "unknown",
          metafile,
          // Bun writes input ids relative to the current directory and
          // output ids relative to outdir.
          inputBase: workingDirectory,
          outputBase: path.resolve(workingDirectory, outdir ?? "."),
          manifestPath: resolveManifestPath(workingDirectory, outdir, options),
          outputFiles,
          publicPath,
          internalImports: BUN_INTERNAL_IMPORTS,
        });
      });
    },
  };
}

function resolveManifestPath(
  workingDirectory: string,
  outdir: string | undefined,
  options: BunProjectionOptions
): string {
  if (options.manifest) {
    return path.resolve(workingDirectory, options.manifest);
  }
  if (outdir) {
    return path.resolve(workingDirectory, outdir, "webui-projection.json");
  }
  throw adapterError(
    "bunProjection() requires outdir or an explicit manifest path",
    "Configure an emitted file location so projection output hashes can be validated."
  );
}
