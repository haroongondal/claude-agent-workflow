## Sharing files, apps and devices with other sessions (coord plugin)

Several Claude Code sessions may run at once on this machine. `coord` (run it as `{coord}`) keeps one queue per resource so they take turns instead of colliding; `coord help` lists the commands. A resource key is a path (a file, or a folder such as an app's folder), `device:<id>` (Android: `adb shell getprop ro.serialno`, since wireless adb serials change; simulator: its UDID) or `app:<package>` for an installed app.

- **Files are automatic.** A hook claims each file you edit and frees it when your turn ends. If another session has it, your edit is refused with that session's name.
- **Claim devices and apps yourself** before driving them: `coord claim device:<id> "<what for>"` before installing, launching, tapping, rebooting or clearing data on a phone, emulator or simulator; `coord claim <app folder>` before work in it that must not interleave with another session (a refactor, a build-install-test loop). Exit 0 means it is yours; exit 3 means you are queued.
- **When you are queued** (exit 3, or a refused edit):
  1. If the hook refused you, run `coord claim <key>` to take your place in line.
  2. Start `coord wait <key>` with `run_in_background`. It exits, and wakes you, the moment the resource is yours.
  3. SendMessage the session that has it (coord prints its name): what you need it for, that you are queued, and ask it to tell you when it is free.
  4. Carry on with other parts of the task that do not need it. Do not touch the resource, do not poll, and do not end the task early; resume that part when the wait finishes.
  A third session queues behind you the same way; `coord status <key>` shows the order.
- **When you finish with something you claimed**, run `coord release <key>` right away and SendMessage the next session it names. Releasing folders, devices and apps is on you; only files are freed automatically.
- **Lend while you wait on a device or app.** If you hold one and must wait for it to finish something before you can check the output (an install, a long run, a job inside the app), check `coord status <key>`; if someone is queued, run `coord lend <key> "<what the borrower must not touch>"` and SendMessage the borrower it names. Lend only when the borrower cannot break what you are waiting for: never lend the screen while your test drives the UI, but "logcat and file pulls only" can be safe. When your wait is over, run `coord back <key>`, SendMessage the borrower to hand it back, and start `coord wait <key>` in the background.
- **When you borrow**, keep to the lender's note and take short steps. Never uninstall, clear data, force-stop or reboot anything the lender is using. When the lender asks, stop at the next safe point and run `coord yield <key>` (you rejoin the queue); if you finish first, `coord release <key>`.
- Entries of closed sessions drop out on their own. Never edit `~/.claude/coord/` by hand.
