// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
  bunProjection,
  hashContent,
  validateManifestSchema,
  ProjectionError,
} from "@microsoft/webui/projection.js";
import type { ProjectionManifest } from "@microsoft/webui/projection.js";

const FRAMEWORK_ENTRY = path.resolve("..", "webui-framework", "src", "index.ts");

/** Bun.build has no `alias`; resolve the framework to its sources like the esbuild tests. */
const frameworkSource: Bun.BunPlugin = {
  name: "framework-source",
  setup(build) {
    build.onResolve({ filter: /^@microsoft\/webui-framework$/ }, () => ({
      path: FRAMEWORK_ENTRY,
    }));
  },
};

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(process.cwd(), ".tmp-bun-projection-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "projection-fixture" }));
  // The framework's decorators are TypeScript experimental decorators.
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } })
  );
  return root;
}

async function readManifest(root: string): Promise<ProjectionManifest> {
  return JSON.parse(
    await readFile(path.join(root, "dist", "webui-projection.json"), "utf8")
  ) as ProjectionManifest;
}

function resolvedArtifact(root: string, manifest: ProjectionManifest, key: string): string {
  return path.resolve(root, "dist", ...manifest.root.split("/"), ...key.split("/"));
}

async function writeCardFixture(root: string): Promise<void> {
  await writeFile(path.join(root, "src", "entry.ts"), "import('./card.ts');\n");
  await writeFile(
    path.join(root, "src", "card.ts"),
    `
import { WebUIElement, observable, attr } from '@microsoft/webui-framework';
class Card extends WebUIElement {
  @observable value = '';
  @attr({ attribute: 'display-value' }) displayValue = '';
}
Card.define('probe-card');
`
  );
}

async function writeSharedChunkFixture(root: string): Promise<void> {
  await writeFile(
    path.join(root, "src", "shared.ts"),
    `
import { WebUIElement, observable } from '@microsoft/webui-framework';
export class Base extends WebUIElement {
  @observable shared = '';
}
export const padding = '${"padding".repeat(2048)}';
`
  );
  for (const [file, tag] of [["entry.ts", "probe-main"], ["island.ts", "probe-island"]]) {
    await writeFile(
      path.join(root, "src", file!),
      `
import { Base, padding } from './shared.ts';
class Element extends Base {}
Element.define('${tag}');
export const used = padding.length;
`
    );
  }
}

describe("bunProjection", () => {
  test("emits a code-split manifest from the same Bun.build run", async (t) => {
    const root = await fixtureRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeCardFixture(root);

    const result = await Bun.build({
      entrypoints: [path.join(root, "src", "entry.ts")],
      outdir: path.join(root, "dist"),
      splitting: true,
      format: "esm",
      plugins: [frameworkSource, bunProjection()],
    });

    assert.ok(result.metafile, "adapter should enable the Bun metafile");
    const manifest = await readManifest(root);
    assert.deepEqual(validateManifestSchema(manifest), []);
    assert.deepEqual(manifest.adapter, { name: "bun", bundler: `bun@${Bun.version}` });
    assert.deepEqual(manifest.components["probe-card"]?.hydrationKeys, ["displayValue", "value"]);
    assert.deepEqual(manifest.components["probe-card"]?.navigationKeys, ["displayValue", "value"]);
    assert.equal(manifest.components["probe-card"]?.outputs.length, 1);

    for (const [key, expectedHash] of Object.entries(manifest.outputs)) {
      const bytes = await readFile(resolvedArtifact(root, manifest, key));
      assert.equal(hashContent(bytes), expectedHash);
    }
    const files = await readdir(path.join(root, "dist"));
    assert.equal(files.some((name) => name.includes(".tmp-")), false);

    // `card.ts` is reached only through `import()`, so its chunk is never
    // preloaded. (Bun may still hoist shared runtime helpers into a chunk the
    // entry imports statically; that one is preloaded.)
    const closures = manifest.entryClosures ?? {};
    const entryKey = Object.keys(closures).find((key) => key.endsWith("/entry.js"));
    assert.ok(entryKey);
    const cardOutput = manifest.components["probe-card"]!.outputs[0]!;
    assert.equal(closures[entryKey]!.includes(cardOutput), false);
  });

  test("records each entry's static import closure, largest first", async (t) => {
    const root = await fixtureRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeSharedChunkFixture(root);

    await Bun.build({
      entrypoints: [path.join(root, "src", "entry.ts"), path.join(root, "src", "island.ts")],
      outdir: path.join(root, "dist"),
      splitting: true,
      format: "esm",
      plugins: [frameworkSource, bunProjection()],
    });

    const manifest = await readManifest(root);
    assert.deepEqual(validateManifestSchema(manifest), []);
    const closures = manifest.entryClosures ?? {};
    const entryKeys = Object.keys(closures).filter(
      (key) => key.endsWith("/entry.js") || key.endsWith("/island.js")
    );
    assert.equal(entryKeys.length, 2);
    for (const entryKey of entryKeys) {
      const closure = closures[entryKey]!;
      assert.ok(closure.length > 0, `${entryKey} must reach the shared chunk`);
      assert.equal(closure.includes(entryKey), false);
      const sizes: number[] = [];
      for (const member of closure) {
        assert.ok(manifest.outputs[member] !== undefined);
        sizes.push((await readFile(resolvedArtifact(root, manifest, member))).byteLength);
      }
      for (let index = 1; index < sizes.length; index++) {
        assert.ok(sizes[index - 1]! >= sizes[index]!);
      }
    }
  });

  test("hashes in-memory outputs when there is no outdir", async (t) => {
    const root = await fixtureRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeCardFixture(root);
    const manifestPath = path.join(root, "out", "webui-projection.json");

    const result = await Bun.build({
      entrypoints: [path.join(root, "src", "entry.ts")],
      splitting: true,
      format: "esm",
      plugins: [frameworkSource, bunProjection({ manifest: manifestPath })],
    });

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProjectionManifest;
    assert.deepEqual(validateManifestSchema(manifest), []);
    const hashes = new Set(Object.values(manifest.outputs));
    for (const artifact of result.outputs) {
      assert.ok(hashes.has(hashContent(new Uint8Array(await artifact.arrayBuffer()))));
    }
  });

  test("rejects the build when the manifest collides with an output", async (t) => {
    const root = await fixtureRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeCardFixture(root);

    await assert.rejects(
      Bun.build({
        entrypoints: [path.join(root, "src", "entry.ts")],
        outdir: path.join(root, "dist"),
        format: "esm",
        plugins: [frameworkSource, bunProjection({ manifest: path.join(root, "dist", "entry.js") })],
      }),
      (error: unknown) =>
        error instanceof ProjectionError &&
        error.diagnostics.some((diagnostic) => diagnostic.code === "PROJ-C013")
    );
  });

  test("requires outdir or an explicit manifest path", async (t) => {
    const root = await fixtureRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeCardFixture(root);

    await assert.rejects(
      Bun.build({
        entrypoints: [path.join(root, "src", "entry.ts")],
        format: "esm",
        plugins: [frameworkSource, bunProjection()],
      }),
      (error: unknown) =>
        error instanceof ProjectionError &&
        error.diagnostics.some((diagnostic) =>
          diagnostic.help?.includes("requires outdir or an explicit manifest path")
        )
    );
  });
});
