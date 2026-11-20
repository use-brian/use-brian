// Offline artifact checks; does not launch browsers or contact any service.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docs = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shotsDir = resolve(docs, "screenshots");
function filesIn(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? filesIn(path) : [path];
  });
}
let links = 0;
for (const file of filesIn(docs).filter(path => /\.(md|html)$/.test(path))) {
  const text = readFileSync(file, "utf8");
  const refs = file.endsWith(".md")
    ? [...text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)].map(match => match[1])
    : [...text.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => match[1]);
  for (const ref of refs) {
    if (/^(?:https?:|mailto:|data:|#)/.test(ref)) continue;
    const [target, fragment] = ref.split("#");
    const absolute = resolve(dirname(file), decodeURIComponent(target));
    assert.ok(existsSync(absolute), `${file}: missing link ${ref}`);
    const line = /^L(\d+)(?:-L(\d+))?$/.exec(fragment ?? "");
    if (line && statSync(absolute).isFile()) {
      const count = readFileSync(absolute, "utf8").split("\n").length;
      assert.ok(Number(line[1]) <= count && Number(line[2] ?? line[1]) <= count, `${ref}: line anchor out of range`);
    }
    links++;
  }
}
const manifest = JSON.parse(readFileSync(resolve(shotsDir, "manifest.json"), "utf8"));
assert.match(manifest.sourceRevision, /^[a-f0-9]{40}$/);
assert.ok(Number.isFinite(Date.parse(manifest.capturedAt)));
assert.equal(manifest.screenshots.length, 16);
assert.equal(new Set(manifest.screenshots.map(shot => shot.file)).size, 16);
assert.equal(readdirSync(shotsDir).filter(name => name.endsWith(".png")).length, 16);
for (const shot of manifest.screenshots) {
  const png = readFileSync(resolve(shotsDir, shot.file));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${shot.file}: PNG signature`);
  assert.equal(png.readUInt32BE(16), shot.width, `${shot.file}: pixel width must match DPR 1 viewport`);
  assert.ok(png.readUInt32BE(20) >= shot.height, `${shot.file}: full-page image height`);
  if (shot.sha256) assert.equal(createHash("sha256").update(png).digest("hex"), shot.sha256);
  assert.deepEqual(shot.pageErrors, [], `${shot.file}: uncaught browser errors`);
  assert.equal(shot.measurements.horizontalOverflow, false, `${shot.file}: unexpected overflow`);
  if (shot.kind === "isolated-production-components") {
    assert.match(shot.url, /surface=/);
    assert.equal(shot.measurements.root.ring.toLowerCase(), shot.mode === "dark" ? "#a3a3a3" : "#737373");
  }
  if (shot.surface === "renderers") {
    const appButton = shot.measurements.elements.find(element => element.tag === "BUTTON" && element.label === "Save changes");
    assert.equal(appButton?.height, 32, "App Button utilities present");
    assert.equal(appButton?.background, shot.mode === "dark" ? "rgb(212, 212, 212)" : "rgb(55, 53, 47)");
  }
  if (shot.surface === "controls") {
    const action = shot.measurements.elements.find(element => element.label === "Default action");
    const icon = shot.measurements.elements.find(element => element.label === "Add item");
    assert.equal(action?.height, shot.width < 640 ? 44 : 32);
    assert.equal(icon?.width, 32);
    assert.equal(icon?.height, 32);
  }
}
const afterDir = resolve(shotsDir, "after");
const after = JSON.parse(readFileSync(resolve(afterDir, "manifest.json"), "utf8"));
assert.match(after.sourceRevision, /^[a-f0-9]{40}$/);
assert.match(after.worktree, /Uncommitted|Clean/);
assert.ok(Number.isFinite(Date.parse(after.capturedAt)));
assert.equal(after.screenshots.length, 32);
assert.equal(new Set(after.screenshots.map(shot => shot.file)).size, 32);
assert.equal(readdirSync(afterDir).filter(name => name.endsWith(".png")).length, 32);
assert.ok(after.sourceFiles.length > 10, "Captured source hashes must identify the audited fixes");
for (const source of after.sourceFiles) {
  const actual = createHash("sha256").update(readFileSync(resolve(docs, "../..", source.file))).digest("hex");
  assert.equal(actual, source.sha256, `${source.file}: product source changed after capture; regenerate after evidence`);
}
for (const shot of after.screenshots) {
  const png = readFileSync(resolve(afterDir, shot.file));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), shot.width);
  assert.ok(png.readUInt32BE(20) >= shot.height);
  assert.equal(createHash("sha256").update(png).digest("hex"), shot.sha256);
  assert.deepEqual(shot.pageErrors, []);
  assert.equal(shot.measurements.horizontalOverflow, false);
  assert.ok(shot.measurements.scrollOwners.every(owner => owner.reachedBottom));
  for (const dialog of shot.measurements.dialogs) {
    assert.equal(dialog.horizontalOverflow, false);
    assert.ok(dialog.left >= -1 && dialog.top >= -1 && dialog.right <= shot.width + 1 && dialog.bottom <= shot.height + 1);
  }
  if (shot.surface === "renderers") {
    const actions = shot.measurements.elements.filter(element => element.tag === "BUTTON" && element.label === "Save changes");
    assert.equal(actions.length, 2);
    assert.equal(actions[0].background, actions[1].background);
    assert.equal(actions[0].background, shot.mode === "dark" ? "rgb(212, 212, 212)" : "rgb(55, 53, 47)");
  }
  if (shot.surface === "emoji") assert.equal(shot.measurements.pickerBackground, "rgb(21, 22, 23)");
  if (shot.surface === "controls") {
    const touch = shot.width < 768 || shot.coarse;
    for (const label of ["Default action", "Add item", "Example choice"]) {
      const control = shot.measurements.elements.find(element => element.label === label);
      assert.equal(control.height, touch ? 44 : 32);
      if (label === "Add item") assert.equal(control.width, touch ? 44 : 32);
    }
    for (const label of ["Example checkbox", "Example switch"]) {
      const control = shot.measurements.elements.find(element => element.label === label);
      if (touch) {
        assert.deepEqual(control.pseudoTarget, { width: "44px", height: "44px" });
        assert.deepEqual(control.reservedArea, { width: 44, height: 44 });
      }
      assert.equal(control.width, label === "Example checkbox" ? 16 : 36);
      assert.equal(control.height, label === "Example checkbox" ? 16 : 20);
    }
    assert.equal(shot.measurements.coarsePointer, Boolean(shot.coarse));
  }
  if (shot.kind === "production-route-body-synthetic-data") {
    assert.ok(shot.measurements.fixtureRequests.length > 0);
    // The production picker-preferences store attempts a background PATCH on
    // startup. The synthetic transport logs and rejects every non-GET before
    // forwarding to the fixture; this is an attempt, not an executed mutation.
    assert.ok(shot.measurements.fixtureRequests.every(request => request.startsWith("GET ") || /^PATCH \/api\/workspaces\/fictional-workspace\/picker-preferences$/.test(request)));
    assert.ok(readFileSync(resolve(docs, "preview/page-transport.tsx"), "utf8").includes('if (method !== "GET") throw new Error'));
  }
}
console.log(`Verified ${links} local documentation links/line references, 16 before + 32 after PNGs, captured source hashes, and recorded browser/style/target/scroll checks.`);
