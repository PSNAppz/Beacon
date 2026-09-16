// bundle_dmg.sh cannot attach a new disk image while a previous run's scratch
// volume is still mounted, which happens whenever a `tauri build` is interrupted.
// Detach leftovers and drop the read-write scratch image before bundling.
// No-ops off macOS, so the Linux and Windows CI runners are unaffected.
import { execSync } from "node:child_process";
import { rmSync, readdirSync } from "node:fs";

if (process.platform !== "darwin") process.exit(0);

try {
  const info = execSync("hdiutil info", { encoding: "utf8" });
  for (const line of info.split("\n")) {
    const match = line.match(/(\/Volumes\/dmg\.\S+)\s*$/);
    if (!match) continue;
    console.log(`clean-dmg-mounts: detaching stale ${match[1]}`);
    try {
      execSync(`hdiutil detach '${match[1]}' -force`, { stdio: "ignore" });
    } catch {
      // Already gone, or busy — the bundler will report it if it still matters.
    }
  }
} catch {
  // hdiutil unavailable; nothing to clean.
}

const dir = "src-tauri/target/release/bundle/macos";
try {
  for (const name of readdirSync(dir)) {
    if (name.startsWith("rw.") && name.endsWith(".dmg")) {
      rmSync(`${dir}/${name}`, { force: true });
      console.log(`clean-dmg-mounts: removed scratch image ${name}`);
    }
  }
} catch {
  // Bundle dir does not exist yet on a clean tree.
}
