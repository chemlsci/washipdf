// テストを実行する：test/*.test.ts を esbuild で束ねてから node --test で動かす。
//   node scripts/test.mjs [--filter 名前]
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(root, "test");
const outDir = join(root, "dist", ".test");
const filter = process.argv.find((a, i) => process.argv[i - 1] === "--filter");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const entries = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts") && (!filter || f.includes(filter)))
  .map((f) => join(testDir, f));

await esbuild.build({
  entryPoints: entries,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  packages: "external",
  alias: { "@": join(root, "src") },
  sourcemap: "inline",
  define: { "process.env.NODE_ENV": '"test"' },
  logLevel: "warning",
});

const files = readdirSync(outDir).filter((f) => f.endsWith(".mjs")).map((f) => join(outDir, f));
const r = spawnSync(process.execPath, ["--test", "--enable-source-maps", ...files], { stdio: "inherit", cwd: root });
process.exit(r.status ?? 1);
