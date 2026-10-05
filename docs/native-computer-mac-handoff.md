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
  USEBRIAN_DISABLE_AUTO_UPDATE=1 NATIVE_COMPUTER_ENABLED=true \
  NATIVE_COMPUTER_INSPECTOR_ENABLED=true "$check_dir/Use Brian.app/Contents/MacOS/Use Brian"
```

The connected API must also run this branch with normal migrations, including `622_computer_profiles.sql`. A desktop rebuild does not update a remote API.

## Use it

1. Open **This computer** and create a named profile. No assistant/chat/task/goal picker is required.
2. Grant Accessibility if needed, select a disposable TextEdit window, enable control and click **Connect computer**. Approve the native dialog. With control off, the button performs a local read-only inspection instead.
3. In your assistant's **Tools**, enable its computer-use permission and grant it this computer profile.
4. In a normal chat with that assistant, ask: **Use my computer profile to replace the TextEdit document with Hello team.** Approve the chat's local window grant and each proposed edit. Check the actual document.
5. Ask it to release the computer. In another chat, request access again: expect fresh local consent, without creating a task or reconnecting the profile.

## Check refusals

- Deny an action: no edit. Stop from the page, tray or **Cmd+Shift+Escape**: no further actions or automatic reconnect. An action already in handoff may finish.
- Revoke the assistant's profile access: its next tool call must refuse.
- Capture requires separate consent, Screen Recording permission and the approved model/image policy. Only the packaged public-shapes fixture supports screenshot-guided actions; arbitrary screenshots and no-AX canvas clicks remain unsupported.

Report **pass / fail / blocked**, the exact error, and the actual window change. Do not change acceptance flags, providers or budgets to force a pass. Native acceptance remains pending; engineering fixes defects.
