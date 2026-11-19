// test/make-fixtures.ts を esbuild で束ねて実行する（アプリのフォント埋め込みコードを共有するため TypeScript で書いている）
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist", ".test");
mkdirSync(outDir, { recursive: true });
await esbuild.build({
  entryPoints: [join(root, "test", "make-fixtures.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(outDir, "make-fixtures.mjs"),
  packages: "external",
  alias: { "@": join(root, "src") },
  logLevel: "warning",
});
const r = spawnSync(process.execPath, [join(outDir, "make-fixtures.mjs"), ...process.argv.slice(2)], { stdio: "inherit", cwd: root });
process.exit(r.status ?? 1);
