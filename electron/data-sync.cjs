"use strict";
/** Git-backed data sync between devices (desktop and the Termux phone build).
 *
 * One private git repo holds the whole LH_DATA_DIR. A lock file in the repo
 * records which device is using the data, so two devices never edit separate
 * copies: `pull` on start takes the lock, `push` on stop commits everything and
 * releases it. Credentials (auth.json, *-credentials.json) live outside the
 * data dir and are never synced. Plain Node, no Electron: the desktop main
 * process requires it, and the phone's `lh` command runs it as a CLI.
 *
 * Nothing is ever deleted: a conflict stops and reports, and `resolve` tags
 * both sides as backups before choosing one. */
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const LOCK = ".lh-lock.json";
const BRANCH = "main";
const GITIGNORE = ["debug/", "*.tmp", "*.tmp.*", ".DS_Store", ""].join("\n");
// Ledgers and chats are byte-exact JSON/JSONL: never let git rewrite line endings.
const GITATTRIBUTES = "* -text\n";

function git(dir, args, { timeout = 60000 } = {}) {
	return new Promise((resolve, reject) => {
		execFile("git", ["-C", dir, ...args], { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
			if (error) reject(Object.assign(new Error(String(stderr || error.message).trim()), { cause: error }));
			else resolve(String(stdout).trim());
		});
	});
}
const tryGit = (dir, args) => git(dir, args).then(() => true, () => false);

function enabled(dir) { return fs.existsSync(path.join(dir, ".git")); }
function readLock(dir) {
	try { return JSON.parse(fs.readFileSync(path.join(dir, LOCK), "utf8")); } catch { return null; }
}
async function device(dir, fallback) { return fallback || (await git(dir, ["config", "--get", "lh.device"]).catch(() => "")) || "unknown"; }
async function commitAll(dir, message) {
	await git(dir, ["add", "-A"]);
	if (await git(dir, ["status", "--porcelain"])) await git(dir, ["commit", "-q", "-m", message]);
}
async function remoteHasBranch(dir) { return tryGit(dir, ["rev-parse", "--verify", "-q", `origin/${BRANCH}`]); }
/** Replay local commits on top of the remote. A failed rebase is aborted, leaving the local copy untouched. */
async function catchUp(dir) {
	if (!(await remoteHasBranch(dir))) return "ok";
	if (await tryGit(dir, ["rebase", "-q", `origin/${BRANCH}`])) return "ok";
	await tryGit(dir, ["rebase", "--abort"]);
	return "conflict";
}
async function configure(dir, name) {
	await git(dir, ["config", "core.autocrlf", "false"]);
	await git(dir, ["config", "user.name", `LearnHarness (${name})`]);
	await git(dir, ["config", "user.email", "learnharness@localhost"]);
	await git(dir, ["config", "lh.device", name]);
	for (const [file, body] of [[".gitignore", GITIGNORE], [".gitattributes", GITATTRIBUTES]]) {
		if (!fs.existsSync(path.join(dir, file))) fs.writeFileSync(path.join(dir, file), body);
	}
}
const stamp = () => new Date().toISOString();

/** Connect a data dir to the sync repo. Never overwrites data: if both the
 *  folder and the repo already hold data, it refuses unless replaceLocal, which
 *  moves the local folder aside as a backup first. */
async function init(dir, { remote, device: name, replaceLocal = false }) {
	if (!name) throw new Error("A device name is required (for example: pc, phone).");
	if (enabled(dir)) {
		await configure(dir, name);
		return { status: "ok", message: `Already connected; device name set to "${name}".` };
	}
	if (!remote) throw new Error("A remote repo URL is required.");
	const remoteHasData = !!(await git(path.dirname(path.resolve(dir)), ["ls-remote", "--heads", remote, BRANCH]).catch((error) => { throw new Error(`Could not reach ${remote}: ${error.message}`); }));
	const localHasData = fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
	if (localHasData && remoteHasData) {
		if (!replaceLocal) return { status: "both", message: "Both this folder and the sync repo already contain data. Re-run with --replace-local to keep the repo's copy (this folder is moved aside as a backup, not deleted)." };
		const backup = `${dir}.backup-${Date.now()}`;
		fs.renameSync(dir, backup);
		await git(path.dirname(path.resolve(dir)), ["clone", "-q", "--branch", BRANCH, remote, dir]);
		await configure(dir, name);
		return { status: "ok", message: `Using the repo's copy. Your previous folder was kept at ${backup}.` };
	}
	if (remoteHasData) {
		fs.mkdirSync(path.dirname(path.resolve(dir)), { recursive: true });
		if (fs.existsSync(dir)) fs.rmdirSync(dir); // empty: nothing to lose
		await git(path.dirname(path.resolve(dir)), ["clone", "-q", "--branch", BRANCH, remote, dir]);
		await configure(dir, name);
		return { status: "ok", message: "Downloaded your data from the sync repo." };
	}
	fs.mkdirSync(dir, { recursive: true });
	await git(dir, ["init", "-q", "-b", BRANCH]);
	await configure(dir, name);
	await git(dir, ["remote", "add", "origin", remote]);
	await commitAll(dir, `init: ${name} ${stamp()}`);
	await git(dir, ["push", "-q", "-u", "origin", BRANCH]);
	return { status: "ok", message: "Uploaded this folder's data to the sync repo." };
}

/** On start: download the latest data and take the lock.
 *  Returns status ok | locked (with lock) | offline | conflict | disabled. */
async function pull(dir, { device: name, force = false } = {}) {
	if (!enabled(dir)) return { status: "disabled" };
	name = await device(dir, name);
	await commitAll(dir, `sync: ${name} unsaved changes ${stamp()}`);
	if (!(await tryGit(dir, ["fetch", "-q", "origin"]))) return { status: "offline", message: "Could not reach the sync repo." };
	if ((await catchUp(dir)) === "conflict") return { status: "conflict", message: "This device and the sync repo both have changes that can't be combined automatically." };
	const lock = readLock(dir);
	if (lock && lock.device !== name && !force) return { status: "locked", lock };
	fs.writeFileSync(path.join(dir, LOCK), `${JSON.stringify({ device: name, since: stamp() })}\n`);
	await commitAll(dir, `lock: ${name}`);
	if (!(await tryGit(dir, ["push", "-q", "origin", `HEAD:${BRANCH}`]))) return { status: "offline", message: "Downloaded, but could not mark this device as active (push failed)." };
	return { status: "ok" };
}

/** On stop: commit everything, release this device's lock, upload. */
async function push(dir, { device: name } = {}) {
	if (!enabled(dir)) return { status: "disabled" };
	name = await device(dir, name);
	await commitAll(dir, `sync: ${name} ${stamp()}`);
	if (readLock(dir)?.device === name) {
		fs.rmSync(path.join(dir, LOCK));
		await commitAll(dir, `unlock: ${name}`);
	}
	if (!(await tryGit(dir, ["fetch", "-q", "origin"]))) return { status: "offline", message: "Saved on this device; upload failed. It will upload next time." };
	if ((await catchUp(dir)) === "conflict") return { status: "conflict", message: "Saved on this device, but the sync repo has different changes. Run resolve to choose a copy." };
	if (!(await tryGit(dir, ["push", "-q", "origin", `HEAD:${BRANCH}`]))) return { status: "offline", message: "Saved on this device; upload failed. It will upload next time." };
	return { status: "ok" };
}

/** Pick one copy after a conflict. Both sides are pushed as backup tags first. */
async function resolve(dir, { keep }) {
	if (!enabled(dir)) return { status: "disabled" };
	if (keep !== "local" && keep !== "remote") throw new Error('Choose --keep local or --keep remote.');
	const name = await device(dir);
	await commitAll(dir, `sync: ${name} before resolve ${stamp()}`);
	await git(dir, ["fetch", "-q", "origin"]);
	const id = Date.now();
	await git(dir, ["tag", `backup-${id}-${name}`, "HEAD"]);
	if (await remoteHasBranch(dir)) await git(dir, ["tag", `backup-${id}-repo`, `origin/${BRANCH}`]);
	await git(dir, ["push", "-q", "origin", "--tags"]);
	if (keep === "local") await git(dir, ["push", "-q", "--force", "origin", `HEAD:${BRANCH}`]);
	else await git(dir, ["reset", "-q", "--hard", `origin/${BRANCH}`]);
	return { status: "ok", message: `Kept the ${keep === "local" ? "copy on this device" : "repo's copy"}. Both versions are saved as tags backup-${id}-*.` };
}

async function status(dir) {
	if (!enabled(dir)) return { status: "disabled", message: "Sync is not set up for this folder." };
	const name = await device(dir);
	const lock = readLock(dir);
	return { status: "ok", device: name, lock, message: lock ? `In use on "${lock.device}" since ${lock.since}.` : "Not in use on any device." };
}

module.exports = { init, pull, push, resolve, status, enabled, readLock };

// CLI: node data-sync.cjs <init|pull|push|status|resolve> --dir D [--remote URL] [--device NAME] [--force] [--keep local|remote] [--replace-local]
// Exit codes: 0 ok · 2 locked · 3 offline · 4 conflict/both · 5 disabled · 1 error.
if (require.main === module) {
	const [command, ...rest] = process.argv.slice(2);
	const flag = (n) => { const i = rest.indexOf(`--${n}`); return i === -1 ? undefined : rest[i + 1]; };
	const has = (n) => rest.includes(`--${n}`);
	const dir = flag("dir");
	const run = { init, pull, push, resolve, status }[command];
	if (!run || !dir) {
		console.error("usage: data-sync.cjs <init|pull|push|status|resolve> --dir DATA_DIR [--remote URL] [--device NAME] [--force] [--keep local|remote] [--replace-local]");
		process.exit(1);
	}
	run(path.resolve(dir), { remote: flag("remote"), device: flag("device"), force: has("force"), keep: flag("keep"), replaceLocal: has("replace-local") }).then((result) => {
		if (result.status === "locked") console.log(`Your chats are in use on "${result.lock.device}" (since ${result.lock.since}). Stop LearnHarness there first so it syncs.`);
		else if (result.message) console.log(result.message);
		else if (result.status === "ok") console.log(command === "push" ? "Synced and released." : "Synced.");
		process.exit({ ok: 0, locked: 2, offline: 3, conflict: 4, both: 4, disabled: 5 }[result.status] ?? 1);
	}, (error) => { console.error(error.message); process.exit(1); });
}
