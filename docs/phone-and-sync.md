# Phone (Android) and device sync

LearnHarness can run on an Android phone through [Termux](https://f-droid.org/packages/com.termux/), and keep your chats and knowledge graph in sync between the phone and the desktop app through a **private GitHub repo**. Both are free and need no payment card.

## How sync works

- Your whole data folder (chats, graph, practice sets, settings) lives in a private git repo. It is plain JSON, a few MB.
- When LearnHarness **starts**, it downloads the latest data and marks the device as the one using it (a lock file, `.lh-lock.json`).
- When LearnHarness **stops**, it uploads your changes and releases the lock.
- If you start it on a second device while the first still holds the lock, it warns you. Stop it on the first device (which uploads), then start it on the second.
- Sign-ins (Claude, ChatGPT, API keys) are stored **outside** the data folder and are never uploaded. Sign in once on each device.
- Nothing is ever deleted by sync. If two copies conflict, sync stops and asks you to choose; both versions are kept as `backup-*` tags in the repo.

The desktop app syncs automatically once its data folder is connected. On Windows that folder is `%APPDATA%\LearnHarness\data`.

## One-time setup on the PC

Needs git, Node.js and the GitHub CLI (`gh`), logged in.

1. Quit LearnHarness.
2. Create the private repo:

   ```sh
   gh repo create learnharness-data --private
   ```

3. Upload your current data and turn on sync (from a checkout of this repo):

   ```sh
   node electron/data-sync.cjs init --dir "$APPDATA/LearnHarness/data" --remote https://github.com/USER/learnharness-data.git --device pc
   ```

4. Start LearnHarness. From now on it syncs on start and quit.

## One-time setup on the phone

1. Build the bundle on the PC: `npm run build && node scripts/build-server.mjs && npm run phone:bundle`. This writes `dist/learnharness-phone.tar.gz`.
2. Install **Termux from F-Droid** (the Play Store version is outdated).
3. In Termux, run `termux-setup-storage` and allow access, then copy the bundle to the phone's Downloads folder.
4. Unpack and run setup:

   ```sh
   mkdir -p ~/lh-bundle && tar -xzf ~/storage/downloads/learnharness-phone.tar.gz -C ~/lh-bundle && bash ~/lh-bundle/setup.sh
   ```

5. When asked, enter the repo URL, your GitHub username, and as the password a **fine-grained access token** (GitHub → Settings → Developer settings → Fine-grained tokens) limited to the `learnharness-data` repo with *Contents: Read and write*. Termux remembers it in `~/.git-credentials`.

## Daily use on the phone

- `lh` starts LearnHarness and opens it in your browser at `http://localhost:3000`. Add it to your home screen from Chrome's menu for an app-like icon.
- Press **Ctrl+C** in Termux to stop it; it uploads your chats. Wait for "Synced and released." before closing Termux.
- `lh release` uploads and frees your chats without starting the app, for example if Termux was closed before it finished.
- `lh status` shows which device is using your chats.
- `lh --force` starts even if another device holds the lock (only if that device is lost or you know it has nothing new).
- `lh resolve local` or `lh resolve remote` picks a copy after a conflict.

Android may stop Termux in the background. `lh` takes Termux's wake lock while running; also set Termux to *Unrestricted* in Android's battery settings.

## Limits

- 64-bit ARM phones only (nearly all current Android phones).
- The background web-browsing helper needs a headless Chrome and does not run on the phone.
- The server listens on `127.0.0.1` only, so other devices on your Wi-Fi cannot reach it. It has no login of its own.
