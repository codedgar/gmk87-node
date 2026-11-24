/**
 * @fileoverview GMK87 diagnostics runner
 *
 * Produces a shareable JSON report of how a keyboard responds to the protocol.
 * Uses ONLY the existing protocol functions (no new commands or sequences) and
 * records per-command timing through the opt-in trace hook in device.js.
 *
 * Modes:
 *   - "read": enumerate, open/close, passive listen, read config twice. Writes nothing.
 *   - "full": everything in "read", then the selected write tests (lighting, time, image)
 *             followed by restoring the backed-up config.
 *
 * See DIAGNOSTICS.md for the rationale and capture baseline.
 */

import os from "os";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import HID from "node-hid";
import Jimp from "jimp";

import {
  VENDOR_ID,
  PRODUCT_ID,
  DISPLAY_WIDTH,
  DISPLAY_HEIGHT,
  delay,
  findDeviceInfo,
  openDevice,
  safeClose,
  readResponse,
  readConfigFromDevice,
  parseConfigBuffer,
  buildConfigBuffer,
  writeConfigToDevice,
  configureLighting,
  syncTime,
  setProtocolTrace,
} from "./device.js";
import { processAndSend } from "../sendImageMagick.js";

const REPORT_SCHEMA = "gmk87-diagnostics/1";

/** Abort a stage after this many consecutive command timeouts (each is up to 30 s) */
const MAX_CONSECUTIVE_TIMEOUTS = 2;

/** Max non-frame-data commands kept in the report (frame data is summarized) */
const MAX_TRACE_ENTRIES = 400;

/** Response latency measured in gmk87-sniffed-reports/*.pcapng (official app, working keyboard) */
const CAPTURE_BASELINE_MS = {
  "0x01": [1.4, 2.2],
  "0x02": [1.3, 3.7],
  "0x03": [1.3, 4.5],
  "0x05": [1.3, 2.5],
  "0x06": [2.4, 3.8],
  "0x21": [1.2, 5.4],
  "0x23": [262.1, 338.2],
};

/** Config bytes that hold the keyboard clock (ignored when comparing reads) */
const CLOCK_BYTES = [35, 36, 37, 38, 39, 40, 41];

const hex = (n, w = 2) => "0x" + n.toString(16).padStart(w, "0");

class DiagnosticAbort extends Error {}

function fromBCD(b) {
  const hi = b >> 4;
  const lo = b & 0x0f;
  if (hi > 9 || lo > 9) return null;
  return hi * 10 + lo;
}

/** Decodes the BCD clock in a parsed config into a local Date (null if invalid) */
function decodeKeyboardClock(t) {
  const parts = [t.year, t.month, t.date, t.hour, t.minute, t.second].map(fromBCD);
  if (parts.some((p) => p === null)) return null;
  const [y, mo, d, h, mi, s] = parts;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return new Date(2000 + y, mo - 1, d, h, mi, s);
}

/** Parsed config without the raw Buffer, safe to serialize */
function configForReport(buf) {
  const parsed = parseConfigBuffer(buf);
  delete parsed._raw;
  const clock = decodeKeyboardClock(parsed.time);
  return {
    hex: buf.toString("hex"),
    parsed,
    keyboardClock: clock ? clock.toISOString() : "invalid",
  };
}

function diffBytes(a, b, ignore = []) {
  const out = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (ignore.includes(i)) continue;
    if (a[i] !== b[i]) out.push({ byte: i, first: hex(a[i]), second: hex(b[i]) });
  }
  return out;
}

/** Replaces the user's home dir / username in free text so reports are safe to post */
function makeSanitizer() {
  const home = os.homedir();
  let user = "";
  try { user = os.userInfo().username; } catch {}
  return (s) => {
    let out = String(s);
    if (home) out = out.split(home).join("~");
    if (user && user.length > 2) out = out.split(user).join("<user>");
    return out;
  };
}

function getNodeHidVersion() {
  try {
    const require = createRequire(import.meta.url);
    return require("node-hid/package.json").version;
  } catch {
    return "unknown";
  }
}

/** Generates the two test pattern PNGs used by the image test */
async function writeTestPatterns(dir) {
  const bars = [0xffffffff, 0xffff00ff, 0x00ffffff, 0x00ff00ff, 0xff00ffff, 0xff0000ff, 0x0000ffff, 0x000000ff];
  const img0 = new Jimp(DISPLAY_WIDTH, DISPLAY_HEIGHT, 0x000000ff);
  const barW = DISPLAY_WIDTH / bars.length;
  img0.scan(0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT, function (x, y, idx) {
    this.bitmap.data.writeUInt32BE(bars[Math.min(bars.length - 1, Math.floor(x / barW))], idx);
  });

  const img1 = new Jimp(DISPLAY_WIDTH, DISPLAY_HEIGHT, 0x000000ff);
  img1.scan(0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT, function (x, y, idx) {
    const border = x < 4 || y < 4 || x >= DISPLAY_WIDTH - 4 || y >= DISPLAY_HEIGHT - 4;
    const v = Math.round((x / (DISPLAY_WIDTH - 1)) * 255);
    const d = this.bitmap.data;
    d[idx] = border ? 255 : v;
    d[idx + 1] = border ? 255 : Math.round((y / (DISPLAY_HEIGHT - 1)) * 255);
    d[idx + 2] = border ? 255 : 255 - v;
    d[idx + 3] = 255;
  });

  const p0 = path.join(dir, "gmk87-test-slot0.png");
  const p1 = path.join(dir, "gmk87-test-slot1.png");
  await img0.writeAsync(p0);
  await img1.writeAsync(p1);
  return [p0, p1];
}

/** Picks lighting test values that differ from the current config so the change is verifiable */
function pickLightingTest(cfg) {
  const ug = cfg.underglow;
  const hue = ug.hue.red === 0 && ug.hue.green === 255 && ug.hue.blue === 255
    ? { red: 255, green: 0, blue: 255 }
    : { red: 0, green: 255, blue: 255 };
  const changes = {
    underglow: { effect: ug.effect === 6 ? 4 : 6, hue },
    led: { mode: 3, color: cfg.led.color === 5 ? 3 : 5 },
  };
  if (ug.brightness === 0) changes.underglow.brightness = 5; // make it visible
  return changes;
}

/**
 * Runs diagnostics and returns a JSON-serializable report.
 * @param {Object} options
 * @param {"read"|"full"} [options.mode="read"]
 * @param {{lighting?:boolean,time?:boolean,image?:boolean}} [options.tests] - Write tests for "full"
 * @param {Object} [options.app] - App/runtime info to embed (version, electron, ...)
 * @param {Function} [onProgress] - Receives { type, ... } events for live UI
 * @returns {Promise<Object>} Report
 */
async function runDiagnostics({ mode = "read", tests = {}, app = {} } = {}, onProgress = () => {}) {
  const sanitize = makeSanitizer();
  const runStart = Date.now();
  const wantTests = mode === "full"
    ? { lighting: !!tests.lighting, time: !!tests.time, image: !!tests.image }
    : { lighting: false, time: false, image: false };

  const report = {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    mode,
    testsRequested: wantTests,
    app,
    system: {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      osVersion: typeof os.version === "function" ? os.version() : "unknown",
      node: process.versions.node,
      electron: process.versions.electron || null,
      nodeHid: getNodeHidVersion(),
      timezoneOffsetMin: new Date().getTimezoneOffset(),
    },
    hid: null,
    steps: [],
    config: {},
    commands: { trace: [], truncated: 0, frameData: null },
    captureBaselineMs: CAPTURE_BASELINE_MS,
    summary: null,
  };

  // ---- Protocol tracing ----
  let currentStep = null;
  let consecutiveTimeouts = 0;
  const frame = { count: 0, failed: 0, totalMs: 0, minMs: Infinity, maxMs: 0, firstFailurePos: null, discarded: 0 };

  setProtocolTrace((e) => {
    if (e.cmd === 0x21) {
      frame.count++;
      frame.discarded += e.discarded;
      if (e.ok) {
        frame.totalMs += e.ms;
        frame.minMs = Math.min(frame.minMs, e.ms);
        frame.maxMs = Math.max(frame.maxMs, e.ms);
      } else {
        frame.failed++;
        if (frame.firstFailurePos === null) frame.firstFailurePos = e.pos;
      }
      if (frame.count % 100 === 0) onProgress({ type: "frames", count: frame.count, failed: frame.failed });
    } else {
      const entry = {
        step: currentStep,
        cmd: hex(e.cmd),
        len: e.len,
        pos: e.pos,
        ms: e.ms,
        ok: e.ok,
        discarded: e.discarded,
        response: e.response ? e.response.slice(0, 12).toString("hex") : null,
      };
      if (report.commands.trace.length < MAX_TRACE_ENTRIES) report.commands.trace.push(entry);
      else report.commands.truncated++;
      onProgress({ type: "command", ...entry });
    }

    consecutiveTimeouts = e.ok ? 0 : consecutiveTimeouts + 1;
    if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
      consecutiveTimeouts = 0;
      throw new DiagnosticAbort(
        `${MAX_CONSECUTIVE_TIMEOUTS} consecutive commands timed out (last: ${hex(e.cmd)}); stopping this step`
      );
    }
  });

  /** Runs one step, records status/timing/details, never throws */
  async function step(id, name, fn) {
    currentStep = id;
    consecutiveTimeouts = 0;
    const traceStart = report.commands.trace.length;
    const rec = { id, name, status: "pass", ms: 0, details: {} };
    onProgress({ type: "step-start", id, name });
    const t0 = Date.now();
    try {
      const res = await fn(rec.details);
      if (res === "warn" || res === "fail" || res === "skip") rec.status = res;
    } catch (err) {
      rec.status = "fail";
      rec.error = sanitize(err && err.message ? err.message : String(err));
      if (err instanceof DiagnosticAbort) rec.aborted = true;
    }
    rec.ms = Date.now() - t0;
    const timedOut = report.commands.trace.slice(traceStart).filter((c) => !c.ok);
    if (timedOut.length) {
      rec.details.commandTimeouts = timedOut.length;
      if (rec.status === "pass") rec.status = "fail";
      if (!rec.error) {
        const cmds = [...new Set(timedOut.map((c) => c.cmd))].join(", ");
        rec.error = `No response to ${cmds} (waited ${Math.round(timedOut[0].ms / 1000)}s)`;
      }
    }
    report.steps.push(rec);
    onProgress({ type: "step-end", id, name, status: rec.status, ms: rec.ms, error: rec.error });
    currentStep = null;
    return rec;
  }

  function skip(id, name, reason) {
    const rec = { id, name, status: "skip", ms: 0, details: { reason } };
    report.steps.push(rec);
    onProgress({ type: "step-end", id, name, status: "skip", ms: 0, error: reason });
  }

  /** Opens, reads config via the normal function, closes. Returns raw Buffer or throws. */
  async function readConfigOnce(details) {
    const dev = openDevice();
    try {
      const before = report.commands.trace.length;
      const buf = await readConfigFromDevice(dev);
      const failed = report.commands.trace.slice(before).filter((c) => !c.ok);
      if (failed.length) {
        details.failedCommands = failed.map((c) => `${c.cmd}@${c.pos}`);
        throw new Error(`${failed.length} command(s) in the config read got no response`);
      }
      return buf;
    } finally {
      await safeClose(dev);
    }
  }

  let device = null;
  let backup = null; // raw config Buffer from the first successful read

  try {
    // ---- 1. HID enumeration ----
    const enumRec = await step("enumerate", "Find keyboard (USB HID)", async (d) => {
      const all = HID.devices();
      const vendor = all.filter((x) => x.vendorId === VENDOR_ID);
      const describe = (x) => ({
        vendorId: hex(x.vendorId, 4),
        productId: hex(x.productId, 4),
        interface: x.interface,
        usagePage: x.usagePage !== undefined ? hex(x.usagePage, 4) : null,
        usage: x.usage !== undefined ? hex(x.usage, 4) : null,
        release: x.release !== undefined ? hex(x.release, 4) : null,
        manufacturer: x.manufacturer || null,
        product: x.product || null,
        path: sanitize(x.path || ""),
      });
      const selected = findDeviceInfo();
      report.hid = {
        totalHidDevices: all.length,
        vendorInterfaces: vendor.map(describe),
        selected: selected ? describe(selected) : null,
      };
      d.interfacesFound = vendor.filter((x) => x.productId === PRODUCT_ID).length;
      d.otherProductIds = [...new Set(vendor.filter((x) => x.productId !== PRODUCT_ID).map((x) => hex(x.productId, 4)))];
      if (!selected) throw new Error(`No HID interface with VID ${hex(VENDOR_ID, 4)} / PID ${hex(PRODUCT_ID, 4)} found`);
      d.selectedInterface = selected.interface;
      if (selected.interface !== 3) {
        d.note = "Interface 3 (config) not found, used the first match";
        return "warn";
      }
    });

    if (enumRec.status === "fail") {
      for (const [id, name] of [["open", "Open connection"], ["config-read", "Read configuration"]]) {
        skip(id, name, "Keyboard not found");
      }
      return report;
    }

    // ---- 2. Open ----
    await step("open", "Open connection", async (d) => {
      const t = Date.now();
      device = openDevice();
      d.openMs = Date.now() - t;
    });

    // ---- 3. Passive listen (no commands sent) ----
    if (device) {
      await step("idle-listen", "Listen for idle traffic (1 s)", async (d) => {
        const got = [];
        const end = Date.now() + 1000;
        while (Date.now() < end) {
          const r = await readResponse(device, 100);
          if (r) got.push(r.slice(0, 16).toString("hex"));
        }
        d.reports = got.slice(0, 20);
        d.count = got.length;
        if (got.length) {
          d.note = "Keyboard sent data without a request";
          return "warn";
        }
      });
      await step("close", "Close connection", async () => {
        await safeClose(device);
        device = null;
      });
    } else {
      skip("idle-listen", "Listen for idle traffic (1 s)", "Could not open device");
    }

    // ---- 4. Config read #1 (open → read → close, same as Home page) ----
    let read2 = null;
    const r1 = await step("config-read", "Read configuration", async (d) => {
      backup = await readConfigOnce(d);
      report.config.initial = configForReport(backup);
      const clock = decodeKeyboardClock(parseConfigBuffer(backup).time);
      if (clock) d.clockDriftSec = Math.round((clock.getTime() - Date.now()) / 1000);
    });

    // ---- 5. Reopen + read #2, compare ----
    if (r1.status !== "fail") {
      await step("config-reread", "Read configuration again", async (d) => {
        read2 = await readConfigOnce(d);
        const diff = diffBytes(backup, read2, CLOCK_BYTES);
        d.differences = diff;
        if (diff.length) {
          d.note = "Two reads differ (clock ignored)";
          return "warn";
        }
      });

      await step("config-sanity", "Check configuration values", async (d) => {
        const c = parseConfigBuffer(backup);
        const issues = [];
        if (c.underglow.effect > 18) issues.push(`underglow.effect=${c.underglow.effect} (expected 0-18)`);
        if (c.underglow.brightness > 9) issues.push(`underglow.brightness=${c.underglow.brightness} (expected 0-9)`);
        if (c.underglow.speed > 9) issues.push(`underglow.speed=${c.underglow.speed} (expected 0-9)`);
        if (c.led.mode > 4) issues.push(`led.mode=${c.led.mode} (expected 0-4)`);
        if (c.led.color > 8) issues.push(`led.color=${c.led.color} (expected 0-8)`);
        if (c.showImage > 2) issues.push(`showImage=${c.showImage} (expected 0-2)`);
        if (c.image1Frames + c.image2Frames > 36) issues.push(`frames ${c.image1Frames}+${c.image2Frames} exceed 36`);
        if (!decodeKeyboardClock(c.time)) issues.push("keyboard clock is not a valid BCD date/time");
        if (backup.every((b) => b === 0)) issues.push("config is all zeros (read may have silently failed)");
        d.issues = issues;
        if (issues.length) return "warn";
      });
    } else {
      skip("config-reread", "Read configuration again", "First config read failed");
    }

    // ---- 6. Write tests (full mode only) ----
    if (mode !== "full") return report;

    const anyWrite = wantTests.lighting || wantTests.time || wantTests.image;
    const canWrite = r1.status !== "fail" && backup && !backup.every((b) => b === 0);
    if (!anyWrite) return report;

    if (!canWrite) {
      if (wantTests.lighting) skip("test-lighting", "Lighting test", "Skipped: no config backup");
      if (wantTests.time) skip("test-time", "Time sync test", "Skipped: no config backup");
      if (wantTests.image) skip("test-image", "Image upload test", "Skipped: no config backup");
      return report;
    }

    const original = parseConfigBuffer(backup);
    let imagesReplaced = false;

    if (wantTests.lighting) {
      await step("test-lighting", "Lighting test", async (d) => {
        const changes = pickLightingTest(original);
        d.applied = changes;
        await configureLighting(changes);
        await delay(1500); // let the user see it
        const after = parseConfigBuffer(await readConfigOnce(d));
        const mismatches = [];
        if (after.underglow.effect !== changes.underglow.effect) mismatches.push("underglow.effect");
        for (const k of ["red", "green", "blue"]) {
          if (after.underglow.hue[k] !== changes.underglow.hue[k]) mismatches.push(`underglow.hue.${k}`);
        }
        if (after.led.mode !== changes.led.mode) mismatches.push("led.mode");
        if (after.led.color !== changes.led.color) mismatches.push("led.color");
        d.readBackMismatches = mismatches;
        if (mismatches.length) throw new Error(`Read-back did not match: ${mismatches.join(", ")}`);
      });
    }

    if (wantTests.time) {
      await step("test-time", "Time sync test", async (d) => {
        await syncTime();
        const after = parseConfigBuffer(await readConfigOnce(d));
        const clock = decodeKeyboardClock(after.time);
        if (!clock) throw new Error("Keyboard clock is not valid after sync");
        d.keyboardClock = clock.toISOString();
        d.driftSec = Math.round((clock.getTime() - Date.now()) / 1000);
        if (Math.abs(d.driftSec) > 10) throw new Error(`Clock off by ${d.driftSec}s after sync`);
      });
    }

    if (wantTests.image) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gmk87-diag-"));
      try {
        await step("test-image", "Image upload test", async (d) => {
          const [p0, p1] = await writeTestPatterns(tmp);
          const t = Date.now();
          imagesReplaced = true; // upload session overwrites image memory even if it fails partway
          // Same call path as the Upload page (keyboard:uploadImage → api.uploadImage → processAndSend)
          await processAndSend(p0, 0, { slot0File: p0, slot1File: p1 });
          d.uploadMs = Date.now() - t;
          const ready = report.commands.trace.filter((c) => c.step === "test-image" && c.cmd === "0x23");
          d.readyAck = ready.map((c) => ({ ok: c.ok, ms: c.ms }));
          d.frameChunksSent = frame.count;
          const after = parseConfigBuffer(await readConfigOnce(d));
          d.framesAfter = { slot0: after.image1Frames, slot1: after.image2Frames, showImage: after.showImage };
          if (frame.failed) throw new Error(`${frame.failed} frame data chunk(s) got no response`);
        });
      } finally {
        try { fs.rmSync(tmp, { recursive: true }); } catch {}
      }
    }

    // ---- 7. Restore backed-up config ----
    await step("restore", "Restore original settings", async (d) => {
      const restoreChanges = { time: true };
      if (imagesReplaced) {
        // Original images are gone; keep the frame counts that match what's in memory now
        try {
          const now = parseConfigBuffer(await readConfigOnce({}));
          restoreChanges.image1Frames = now.image1Frames;
          restoreChanges.image2Frames = now.image2Frames;
        } catch {
          restoreChanges.image1Frames = 1;
          restoreChanges.image2Frames = 1;
        }
        d.note = "Images can't be restored; frame counts match the test upload";
      }
      const target = buildConfigBuffer(original, restoreChanges);
      const dev = openDevice();
      try {
        await writeConfigToDevice(dev, target);
      } finally {
        await safeClose(dev);
      }
      const after = await readConfigOnce(d);
      report.config.afterRestore = configForReport(after);
      const diff = diffBytes(target, after, CLOCK_BYTES);
      d.differences = diff;
      if (diff.length) throw new Error(`${diff.length} byte(s) differ from the backup after restore`);
    });

    return report;
  } finally {
    setProtocolTrace(null);
    if (device) await safeClose(device);

    if (frame.count) {
      const okCount = frame.count - frame.failed;
      report.commands.frameData = {
        count: frame.count,
        failed: frame.failed,
        minMs: okCount ? frame.minMs : null,
        avgMs: okCount ? Math.round((frame.totalMs / okCount) * 10) / 10 : null,
        maxMs: okCount ? frame.maxMs : null,
        firstFailurePos: frame.firstFailurePos,
        discardedResponses: frame.discarded,
      };
    }

    const count = (s) => report.steps.filter((x) => x.status === s).length;
    const failedSteps = report.steps.filter((x) => x.status === "fail");
    report.summary = {
      result: failedSteps.length ? "fail" : count("warn") ? "warn" : "pass",
      passed: count("pass"),
      warnings: count("warn"),
      failed: failedSteps.length,
      skipped: count("skip"),
      failedSteps: failedSteps.map((s) => s.id),
      durationMs: Date.now() - runStart,
    };
  }
}

export { runDiagnostics, REPORT_SCHEMA };
