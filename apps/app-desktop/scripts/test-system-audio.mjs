// Opt-in real-device qualification. Package this script, the compiled capture
// policy, and an IIFE audio-mixer bundle named captureModule in renderer.js.
// No backend, account, uploads, transcription, or saved audio. Results are JSON.
// [COMP:app-desktop/system-audio]
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, desktopCapturer, screen } from "electron";
import { resolveDisplayCapture, screenCaptureDisabledFeatures } from "../dist/system-audio-policy.js";

// Use --capture-probe-stock-screen only for the failing-backend A/B control.
if (!process.argv.includes("--capture-probe-stock-screen")) {
  const features = screenCaptureDisabledFeatures(process.platform, release(), process.versions.electron);
  if (features.length) {
    const existing = app.commandLine.getSwitchValue("disable-features").split(",").filter(Boolean);
    app.commandLine.appendSwitch("disable-features", [...new Set([...existing, ...features])].join(","));
  }
}

const directory = dirname(fileURLToPath(import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "brian-capture-runtime-"));
app.setPath("userData", join(temporary, "profile"));
const outputArg = process.argv.find((value) => value.startsWith("--capture-probe-output="));
const output = outputArg?.slice("--capture-probe-output=".length) ?? join(temporary, "result.json");
const results = [];
const captureScreen = process.argv.includes("--capture-probe-screen");
let enumerations = 0;
let win;

app.whenReady().then(async () => {
  try {
    const bundle = readFileSync(join(directory, "renderer.js"), "utf8");
    const html = join(temporary, "capture.html");
    writeFileSync(html, '<!doctype html><title>Capture verification</title><h1>Use Brian capture verification</h1><p>Local audio test. No recording is uploaded.</p>');
    win = new BrowserWindow({ width: 720, height: 480, show: true,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "media"));
    win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      if (!request.frame || request.frame !== win.webContents.mainFrame) { callback({}); return; }
      void resolveDisplayCapture({
        intent: captureScreen ? { kind: "legacy", sourceId: null } : { kind: "audio", includeSystemAudio: true }, frame: request.frame,
        primaryDisplayId: screen.getPrimaryDisplay().id,
        getSources: async (types) => { enumerations++; return desktopCapturer.getSources({ types, thumbnailSize: { width: 0, height: 0 } }); },
      }).then(callback).catch(() => callback({}));
    });
    await win.loadFile(html);
    await win.webContents.executeJavaScript(bundle);
    for (const minimized of [false, false, true]) {
      if (minimized) win.minimize(); else win.show();
      const result = await win.webContents.executeJavaScript(`(async () => {
        let capture, toneContext, tone;
        try {
          toneContext = new AudioContext(); await toneContext.resume();
          tone = toneContext.createOscillator(); tone.frequency.value = 880;
          const gain = toneContext.createGain(); gain.gain.value = 0.02;
          tone.connect(gain).connect(toneContext.destination); tone.start();
          const started = performance.now();
          capture = await captureModule.acquireCaptureAudio({ includeSystemAudio: true, captureScreen: ${captureScreen} });
          const startupMs = Math.round(performance.now() - started);
          let videoFrames = 0;
          if (${captureScreen}) {
            const video = document.createElement('video');
            video.muted = true; video.srcObject = capture.recordingStream;
            document.body.append(video); await video.play();
            await Promise.race([
              new Promise(resolve => {
                const next = () => video.requestVideoFrameCallback(() => {
                  videoFrames++; if (videoFrames >= 2) resolve(); else next();
                }); next();
              }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('No live screen frames')), 3000)),
            ]);
            video.pause(); video.srcObject = null; video.remove();
          }
          const analyser = capture.audioContext.createAnalyser();
          const system = capture.audioContext.createMediaStreamSource(capture.systemStream);
          system.connect(analyser);
          const samples = new Float32Array(analyser.fftSize);
          const chunks = [];
          const recorder = new MediaRecorder(new MediaStream(capture.recordingStream.getAudioTracks()), { mimeType: 'audio/webm;codecs=opus' });
          recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
          const stopped = new Promise((resolve, reject) => {
            recorder.onstop = resolve; recorder.onerror = reject;
          });
          recorder.start(100);
          await new Promise(resolve => setTimeout(resolve, 800));
          analyser.getFloatTimeDomainData(samples);
          const systemRms = Math.sqrt(samples.reduce((sum, n) => sum + n*n, 0) / samples.length);
          recorder.stop(); await stopped;
          const blob = new Blob(chunks, { type: recorder.mimeType });
          const decoded = await capture.audioContext.decodeAudioData(await blob.arrayBuffer());
          return { startupMs, videoFrames, systemRms, bytes: blob.size, decodedDuration: decoded.duration,
            audioTracks: capture.recordingStream.getAudioTracks().length,
            videoTracks: capture.recordingStream.getVideoTracks().length,
            includesSystemAudio: capture.includesSystemAudio };
        } finally {
          for (const stream of capture?.inputStreams ?? []) for (const track of stream.getTracks()) track.stop();
          for (const track of capture?.recordingStream.getTracks() ?? []) track.stop();
          if (capture?.audioContext) await capture.audioContext.close();
          if (tone) tone.stop(); if (toneContext) await toneContext.close();
        }
      })()`, true);
      assert.equal(result.includesSystemAudio, true);
      assert.equal(result.audioTracks, 1);
      assert.equal(result.videoTracks, captureScreen ? 1 : 0);
      if (captureScreen) assert(result.videoFrames >= 2, "Screen capture must deliver actual video frames");
      assert(result.startupMs < 5000, `Slow capture startup: ${result.startupMs}ms`);
      assert(result.bytes > 100 && result.decodedDuration > 0.3, "Recording must decode");
      assert(result.systemRms > 0.00001, "Real computer playback must reach the system lane");
      results.push({ minimized, ...result });
    }
    assert.equal(enumerations, captureScreen ? results.length : 0, "Capture must enumerate only its required sources");
    writeFileSync(output, JSON.stringify({ ok: true, electron: process.versions.electron, captureScreen, results, enumerations }, null, 2));
    app.exit(0);
  } catch (error) {
    writeFileSync(output, JSON.stringify({ ok: false, error: error?.stack ?? String(error), results }, null, 2));
    app.exit(1);
  }
});
setTimeout(() => {
  writeFileSync(output, JSON.stringify({ ok: false, error: "Capture qualification timed out", results }, null, 2));
  app.exit(1);
}, 45_000).unref();
