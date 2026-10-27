#!/usr/bin/env node
/** Phone bundle (Android via Termux): packs the standalone server built by
 * `npm run build` + scripts/build-server.mjs with the Termux setup script, the
 * `lh` launcher and the data-sync CLI into dist/learnharness-phone.tar.gz.
 * Desktop-platform native binaries are left out; setup.sh downloads the
 * Android builds of the same versions on the phone. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const NEXT = path.join(ROOT, ".next");
const STANDALONE = path.join(NEXT, "standalone");
const STAGE = path.join(ROOT, "dist", "phone");
const OUT = path.join(ROOT, "dist", "learnharness-phone.tar.gz");

if (!fs.existsSync(path.join(STANDALONE, "server.js"))) {
	console.error("[build-phone] no standalone server: run `npm run build && node scripts/build-server.mjs` first.");
	process.exit(1);
}

// Shell scripts must reach Termux with LF endings even from a Windows checkout.
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
for (const [from, to] of [["scripts/phone/setup.sh", "setup.sh"], ["scripts/phone/lh", "lh"], ["electron/data-sync.cjs", "data-sync.cjs"]]) {
	fs.writeFileSync(path.join(STAGE, to), fs.readFileSync(path.join(ROOT, from), "utf8").replace(/\r\n/g, "\n"), { mode: 0o755 });
}

const natives = [];
for (const scope of ["@resvg", "@napi-rs"]) {
	const dir = path.join(STANDALONE, "node_modules", scope);
	if (!fs.existsSync(dir)) continue;
	for (const name of fs.readdirSync(dir)) if (/-(win32|darwin|linux)-/.test(name)) natives.push(`${scope}/${name}`);
}

// Windows' bsdtar takes drive-letter paths; Git Bash's GNU tar would read "C:" as a remote host.
const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
fs.mkdirSync(path.dirname(OUT), { recursive: true });
execFileSync(tar, [
	"-czf", OUT,
	...natives.flatMap((name) => ["--exclude", `standalone/node_modules/${name}`]),
	"-C", NEXT, "standalone",
	"-C", STAGE, "setup.sh", "lh", "data-sync.cjs",
], { stdio: "inherit" });

console.log(`[build-phone] left out desktop natives: ${natives.join(", ") || "none"}`);
console.log(`[build-phone] phone bundle ready: ${OUT} (${Math.round(fs.statSync(OUT).size / 1024 / 1024)} MB)`);
