# Mac check: computer profiles from chat

The previous package build **failed**. Do not reuse that ZIP. Pull the fixes and rebuild:

```sh
bash scripts/package-desktop.sh --arm64
```

Continue only after **Done**. Quit the old Use Brian instance. Use the ZIP path printed by that run, not the old `release/usebrian.zip`:

```sh
zip='/paste/the/printed/path/usebrian.zip'
check_dir="$(mktemp -d)"
ditto -x -k "$zip" "$check_dir" && \
  open -n --env USEBRIAN_DISABLE_AUTO_UPDATE=1 \
  --env NATIVE_COMPUTER_ENABLED=true --env NATIVE_COMPUTER_INSPECTOR_ENABLED=true \
  --stdout "$check_dir/native-computer.stdout.log" \
  --stderr "$check_dir/native-computer.stderr.log" "$check_dir/Use Brian.app"
```

Launch the `.app` through Launch Services (`open`), not its `Contents/MacOS` executable from a terminal. macOS responsibility tracking can attribute directly launched children to the terminal; see [Apple's explanation](https://developer.apple.com/forums/thread/125438) and [Qt's reproduction](https://www.qt.io/blog/the-curious-case-of-the-responsible-process). This is a possible explanation for the operator's missing Use Brian entry, not a verified TCC result for that run. `open --env` preserves the explicit test flags without changing login-session environment. Quit the previous instance first so the single-instance lock does not redirect to it. Read only the `[native-computer]` lines in the two local log files; do not upload full logs.

The connected API must also run this branch with normal migrations, including `622_computer_profiles.sql`. A desktop rebuild does not update a remote API. Profile creation does not require native execution to be enabled. If loading or connecting fails, the page now distinguishes API compatibility, missing schema, sign-in/access, and execution availability; Mac permission changes do not fix those backend failures.

The API needs `NATIVE_COMPUTER_ENABLED=true` and a stable `NATIVE_COMPUTER_DEPLOYMENT_ID`; the relay also needs `NATIVE_COMPUTER_ENABLED=true`, with its existing JWT/relay credentials matching the API. These are backend startup settings, separate from the desktop's launch flags. The normal OSS launcher reads the repository-root dotenv file and passes its settings to both services. If reaching the development stack through SSH, forward its relay port as well as API/web/doc-sync: for the existing default relay, add `-L 127.0.0.1:8094:127.0.0.1:8094`. The relay URL sent to the desktop must resolve to that reachable endpoint. A catalog entry or an assistant grant does not establish running native tool registration.

## Use it

1. Open **This computer** and create a named profile. No assistant/chat/task/goal picker is required.
2. Click **Request Mac Accessibility permission** if needed, approve the local setup dialog and grant Accessibility to Use Brian in macOS settings. macOS may suppress a repeated prompt; the settings pane still opens. Refresh windows afterward so a fresh helper checks the actual permission. Return, click **Refresh windows** and select a disposable TextEdit window, enable control and click **Connect computer**. Approve the native dialog. With control off, the button performs a local read-only inspection instead.
3. In your assistant's **Tools**, enable its computer-use permission and grant it this computer profile.
4. In a normal chat with that assistant, ask: **Use my computer profile to replace the TextEdit document with Hello team.** Approve the chat's local window grant and each proposed edit. Check the actual document.
5. Ask it to release the computer. In another chat, request access again: expect fresh local consent, without creating a task or reconnecting the profile.

## Check refusals

- Deny an action: no edit. Stop from the page, tray or **Cmd+Shift+Escape**: no further actions or automatic reconnect. An action already in handoff may finish.
- Revoke the assistant's profile access: its next tool call must refuse.
- Capture requires separate consent, Screen Recording permission and the approved model/image policy. Only the packaged public-shapes fixture supports screenshot-guided actions; arbitrary screenshots and no-AX canvas clicks remain unsupported.

Report **pass / fail / blocked**, the exact error, and the actual window change. Do not change acceptance flags, providers or budgets to force a pass. Native acceptance remains pending; engineering fixes defects.
