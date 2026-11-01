import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root =
  process.env.BIMAX_DESKTOP_REPO ||
  JSON.parse(readFileSync(path.join(import.meta.dirname, "../.bimax-desktop-link.json"), "utf8")).desktopRoot;
for (const file of ["verify-mobile-workspaces.mjs", "verify-mobile-live.mjs", "verify-mobile-history.mjs", "verify-mobile-renderer.mjs", "verify-mobile-chat-ui.mjs", "verify-mobile-routing-recovery.mjs"]) {
  const r = spawnSync(process.execPath, [path.join(root, "app/scripts", file)], {
    cwd: root,
    stdio: "inherit",
    timeout: 60000,
  });
  if (r.error) throw r.error;
  if (r.status) process.exit(r.status);
}
