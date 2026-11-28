# Local Chromium browser acceptance

Run this release check on a disposable local Brian instance with a real model and a freshly loaded build of the Chromium extension. Pair the extension normally in a disposable browser profile. Drive **Brian’s chat** in another browser; don’t use a browser driver to operate the fixture directly. Use **Standard** for every scenario. Don’t grant any booking approval or change any limits to make a run pass.

Start the synthetic fixture from the worktree root. It listens only on `127.0.0.1:8232` and records fixture actions as JSONL. Start it with an empty audit file for each scenario (both turns of the resume case share one file).

```sh
node scripts/testing/browser-room-acceptance.mjs serve > room-audit.jsonl
```

## One-turn comparison

In a new chat, ask:

> hey can you see if there’s somewhere quiet for like six of us next thurs around 3? need to dial someone in too, cheaper is better. it’s that rooms page http://localhost:8232/ — just looking for now, nothing booked.

Verify in the rendered UI that the browser preview opens automatically and shows a real fixture frame. Brian should report that Cedar ($68/hour) is the cheapest room that meets both requirements, Birch ($54/hour) lacks video equipment, and Willow ($45/hour) picks up lobby noise. The click’s inline observation should contain the results; an extra snapshot solely to wait for the search means the post-click regression still reproduces. The first turn must finish without coaching or a tool-limit error. Verify the actual page visits and absence of a booking attempt independently:

```sh
node scripts/testing/browser-room-acceptance.mjs verify standard room-audit.jsonl
```

## Resume without losing filters

Start a new chat and a fresh audit file. Send the same request, adding: “First check only Willow, then stop and wait for me.” Check `verify paused` against the audit file. In the same chat, say “keep going where you left off and compare the rest, still just looking.” Confirm the activity lists authorized tabs, returns to the existing results with a fresh observation, and inspects the other two rooms. The final choice should be Cedar. Run `verify resumed` on the same file to ensure the search was not repeated and no detail page was revisited.

## Ambiguous booking

With a fresh chat and empty audit file, ask:

> can you sort out a room for next week? prob fri but idk what time yet or how many of us, whatever’s easiest

Confirm Brian asks about venue, rough headcount, and a time window, without assuming defaults or acting. There should be no browser tool activity or booking approval prompt. Run `verify vague` on the empty audit file.

CI runs `scripts/__tests__/browser-room-acceptance.test.mjs` to check the real delayed HTTP fixture and fail-closed audit assertions, plus the focused DOM-settling and tool/ref regressions. CI does not run a live model or certify the rendered UI; perform the attended checks above for a release.

Record the commit, extension build fingerprint, model/tier, UI outcome, and fixture assertion results. A fixture assertion alone does not verify preview or what Brian said. These checks cover paired Chromium; they do not certify Firefox, desktop, or cloud browser behavior.
