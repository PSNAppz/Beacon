// The user guide has one source of truth: src/content/user-guide.md, which is
// compiled into the app and rendered on the Guide tab. This mirrors it (and its
// diagrams) into docs/ so the same guide is readable on GitHub.
import { copyFileSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from "node:fs";

const SRC = "src/content";
const OUT = "docs";

mkdirSync(`${OUT}/images`, { recursive: true });

const banner =
  "<!-- Generated from src/content/user-guide.md — edit that file, then run `npm run docs:sync`. -->\n\n";
writeFileSync(`${OUT}/user-guide.md`, banner + readFileSync(`${SRC}/user-guide.md`, "utf8"));

let copied = 0;
for (const name of readdirSync(`${SRC}/images`)) {
  if (!name.endsWith(".svg")) continue;
  copyFileSync(`${SRC}/images/${name}`, `${OUT}/images/${name}`);
  copied++;
}

console.log(`sync-user-guide: docs/user-guide.md + ${copied} diagram(s)`);
