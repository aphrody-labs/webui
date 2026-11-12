// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Official esbuild adapter for bundler-neutral state projection.
 *
 * This module uses esbuild types only. It never imports the esbuild runtime;
 * the application-owned esbuild instance supplies the plugin API and version.
 */

import * as path from "node:path";
import type {
  BuildResult,
  PartialMessage,
  Plugin,
  PluginBuild,
} from "esbuild";
import {
  ProjectionError,
  createDiagnostic,
} from "../diagnostics.js";
import type { ProjectionDiagnostic } from "../diagnostics.js";
import { preloadProjectionCompiler } from "../loader.js";
import {
  adapterError,
  emitMetafileProjection,
} from "./metafile.js";
import type { MetafileVirtualSource } from "./metafile.js";

/** Configuration for the official esbuild projection adapter. */
export interface EsbuildProjectionOptions {
  /**
   * Manifest path. Relative values resolve from esbuild's `absWorkingDir`.
   *
   * Defaults to `<outdir>/webui-projection.json` or the directory containing
   * `outfile`.
   */
  readonly manifest?: string;
}

/** Create the official esbuild projection plugin. */
export function esbuildProjection(
  options: EsbuildProjectionOptions = {}
): Plugin {
  return {
    name: "webui-state-projection",
    setup(build) {
      build.initialOptions.metafile = true;
      const versionError = validateEsbuildVersion(build.esbuild.version);
      const compilerLoad = versionError
        ? Promise.resolve(undefined)
        : preloadProjectionCompiler().then(
            () => undefined,
            (error: unknown) => error
          );
      if (versionError) {
        build.onStart(() => ({
          errors: [diagnosticMessage(versionError)],
        }));
      }

      build.onEnd(async (result) => {
        if (result.errors.length > 0 || versionError) return;
        try {
          const compilerError = await compilerLoad;
          if (compilerError !== undefined) throw compilerError;
          await emitProjectionManifest(build, result, options);
        } catch (error: unknown) {
          return {
            errors: errorMessages(error),
          };
        }
      });
    },
  };
}

async function emitProjectionManifest(
  build: PluginBuild,
  result: BuildResult,
  options: EsbuildProjectionOptions
): Promise<void> {
  const metafile = result.metafile;
  if (!metafile) {
    throw adapterError(
      "esbuild did not return a metafile",
      "Do not disable metafile after esbuildProjection() configures the build."
    );
  }

  const workingDirectory = path.resolve(
    build.initialOptions.absWorkingDir ?? process.cwd()
  );
  await emitMetafileProjection({
    bundlerName: "esbuild",
    bundlerVersion: build.esbuild.version,
    metafile,
    // esbuild writes every metafile path relative to absWorkingDir.
    inputBase: workingDirectory,
    outputBase: workingDirectory,
    manifestPath: resolveManifestPath(workingDirectory, build, options),
    outputFiles: result.outputFiles,
    publicPath: build.initialOptions.publicPath,
    virtualSources: stdinSources(build),
  });
}

function resolveManifestPath(
  workingDirectory: string,
  build: PluginBuild,
  options: EsbuildProjectionOptions
): string {
  if (options.manifest) {
    return path.resolve(workingDirectory, options.manifest);
  }
  const outdir = build.initialOptions.outdir;
  if (outdir) {
    return path.resolve(
      workingDirectory,
      outdir,
      "webui-projection.json"
    );
  }
  const outfile = build.initialOptions.outfile;
  if (outfile) {
    return path.join(
      path.dirname(path.resolve(workingDirectory, outfile)),
      "webui-projection.json"
    );
  }
  throw adapterError(
    "esbuildProjection() requires outdir, outfile, or an explicit manifest path",
    "Configure an emitted file location so projection output hashes can be validated."
  );
}

/** esbuild names stdin `<stdin>` or its `sourcefile`; both stay virtual. */
function stdinSources(
  build: PluginBuild
): MetafileVirtualSource[] {
  const stdin = build.initialOptions.stdin;
  if (!stdin) return [];
  const contents =
    typeof stdin.contents === "string"
      ? stdin.contents
      : Buffer.from(stdin.contents).toString("utf8");
  const sourcefile = stdin.sourcefile ?? "<stdin>";
  return [...new Set([sourcefile, "<stdin>"])].map((id) => ({
    id,
    contents,
  }));
}

function validateEsbuildVersion(
  version: string
): ProjectionDiagnostic | undefined {
  const parsed = parseVersion(version);
  if (
    parsed === undefined ||
    parsed.major !== 0 ||
    parsed.minor !== 28 ||
    parsed.patch < 1
  ) {
    return createDiagnostic("PROJ-P002", {
      help: `Install an application-owned esbuild peer compatible with ^0.28.1; found ${version}.`,
    });
  }
  return undefined;
}

function parseVersion(
  value: string
): { major: number; minor: number; patch: number } | undefined {
  const segments = value.split(".");
  if (segments.length < 3) return undefined;
  const major = Number(segments[0]);
  const minor = Number(segments[1]);
  const patchText = segments[2]!;
  let end = 0;
  while (
    end < patchText.length &&
    patchText.charCodeAt(end) >= 48 &&
    patchText.charCodeAt(end) <= 57
  ) {
    end++;
  }
  if (end === 0) return undefined;
  const patch = Number(patchText.slice(0, end));
  return Number.isInteger(major) &&
    Number.isInteger(minor) &&
    Number.isInteger(patch)
    ? { major, minor, patch }
    : undefined;
}

function errorMessages(error: unknown): PartialMessage[] {
  if (error instanceof ProjectionError) {
    return error.diagnostics.map(diagnosticMessage);
  }
  return [
    diagnosticMessage(
      createDiagnostic("PROJ-C013", {
        help:
          error instanceof Error
            ? error.message
            : String(error),
      })
    ),
  ];
}

function diagnosticMessage(
  diagnostic: ProjectionDiagnostic
): PartialMessage {
  return {
    id: diagnostic.code,
    pluginName: "webui-state-projection",
    text: `${diagnostic.code}: ${diagnostic.title}`,
    ...(diagnostic.location === undefined
      ? {}
      : {
          location: {
            file: diagnostic.location,
          },
        }),
    ...(diagnostic.help === undefined
      ? {}
      : {
          notes: [{ text: `help: ${diagnostic.help}` }],
        }),
    detail: diagnostic,
  };
}
