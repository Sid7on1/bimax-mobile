import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root =
  process.env.BIMAX_DESKTOP_REPO ||
  JSON.parse(readFileSync(path.join(import.meta.dirname, "../.bimax-desktop-link.json"), "utf8")).desktopRoot;
const script = path.join(root, "app/scripts/build-mobile-renderer.mjs");
const result = spawnSync(process.execPath, [script, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: root,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
