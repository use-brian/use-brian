# Use Brian Firefox Companion

The companion lets Firefox use Use Brian's **My Browser** backend without the
Electron desktop app. It registers the existing `ai.usebrian.browser` native
messaging host and starts Firefox with a loopback-only WebDriver BiDi endpoint.
Firefox launches the companion on demand; there is no daemon or listening port.

## Install From This Repository

The standalone companion supports Linux and macOS. Windows uses the packaged
desktop app because Firefox native messaging requires a native `.exe` host.

Build and install the CLI globally as the same OS user that runs Firefox:

```bash
pnpm --filter @use-brian/firefox-companion build
npm install -g ./apps/firefox-companion
use-brian-firefox install
```

Quit every Firefox process, then start the controllable instance:

```bash
use-brian-firefox start
```

Check endpoint discovery with:

```bash
use-brian-firefox status
```

Non-standard server installations can set absolute paths:

```bash
USE_BRIAN_FIREFOX_PATH=/opt/firefox/firefox \
USE_BRIAN_FIREFOX_PROFILE_ROOT=/srv/firefox/profiles \
use-brian-firefox start
```

The Firefox extension, browser relay, and account pairing are still required.
The browser needs a graphical session (for example, a VNC-accessible display)
because every new task keeps the extension's explicit Allow prompt. The
companion does not enable unattended or headless browser control.
