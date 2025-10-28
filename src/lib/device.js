/**
 * @fileoverview Low-level device communication library for GMK87 keyboard
 * Transport-agnostic (USB interrupt preferred, HID fallback) with verbose logging.
 *
 * Public API is preserved to avoid breaking timesync/configureLights/uploadImage:
 * - openDevice, drainDevice, checksum, send, trySend, readResponse, waitForReady,
 *   resetDeviceState, reviveDevice, buildImageFrames, sendFrames, initializeDevice,
 *   uploadImageToDevice
 */

import HID from "node-hid";
import usb from "usb";
import Jimp from "jimp";

/** USB IDs */
const VENDOR_ID = 0x320f;
const PRODUCT_ID = 0x5055;

/** HID report constants (kept for compatibility) */
const REPORT_ID = 0x04;

/** Frame & display constants */
const BYTES_PER_FRAME = 0x38;
const DISPLAY_WIDTH = 240;
const DISPLAY_HEIGHT = 135;

/** ---- Logging gate (as requested, right after DISPLAY_HEIGHT) ---- */
const LOG_LEVEL = (process?.env?.LOG_LEVEL || "debug").toLowerCase();
/** simple level gate */
const L = {
  error: (...a) => console.error(...a),
  warn: (...a) => (["warn", "info", "debug"].includes(LOG_LEVEL) ? console.warn(...a) : void 0),
  info: (...a) => (["info", "debug"].includes(LOG_LEVEL) ? console.log(...a) : void 0),
  debug: (...a) => (LOG_LEVEL === "debug" ? console.debug(...a) : void 0),
};

/** Tunable timings (shorter by default; overridable in functions via params) */
const timing = {
  drainIdleMs: 40, // quiescent period to stop draining
  drainHardLimitMs: 150, // never drain longer than this
  readResponseMs: 60, // per-response wait
  retryDelayMs: 8, // between trySend attempts
  reviveBaseBackoffMs: 120, // exponential-ish backoff base
};

/** A/B toggles */
const COMPAT_DEFAULT = false; // if true: force HID + legacy init + conservative waits
const PACKET_FORMAT_DEFAULT = "hid64"; // 'hid64' (default) | 'raw64'
/**
 * 'hid64' -> send the same 64B you already build (with REPORT_ID at buf[0]).
 * 'raw64' -> drop the reportId byte before writing (used only on interrupt path).
 */

/* -------------------------------------------------------
 * Utilities (unchanged signatures)
 * -----------------------------------------------------*/
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toRGB565(r, g, b) {
  const r5 = (r >> 3) & 0x1f;
  const g6 = (g >> 2) & 0x3f;
  const b5 = (b >> 3) & 0x1f;
  return (r5 << 11) | (g6 << 5) | b5;
}

function toHexNum(num) {
  if (num < 0 || num >= 100) throw new RangeError("toHexNum expects 0..99");
  const low = num % 10;
  const high = Math.floor(num / 10);
  return (high << 4) | low;
}

function checksum(buf) {
  // keep your checksum definition: sum bytes 3..63
  let sum = 0;
  for (let i = 3; i < 64; i++) sum = (sum + (buf[i] & 0xff)) & 0xffff;
  return sum;
}

/* -------------------------------------------------------
 * Transport Abstraction
 * -----------------------------------------------------*/
class BaseTransport {
  constructor(kind) {
    this.kind = kind; // 'interrupt' | 'hid'
  }
  async writeFrame(_buf) {
    throw new Error("Not implemented");
  }
  async readOnce(timeoutMs = timing.readResponseMs) {
    throw new Error("Not implemented");
  }
  async drain(quiescentMs = timing.drainIdleMs, hardLimitMs = timing.drainHardLimitMs) {
    const packets = [];
    const start = Date.now();
    let last = Date.now();
    while (Date.now() - start < hardLimitMs) {
      const pkt = await this.readOnce(quiescentMs);
      if (pkt) {
        packets.push(Buffer.from(pkt));
        last = Date.now();
      } else if (Date.now() - last >= quiescentMs) {
        break;
      }
    }
    return packets;
  }
  close() {}
}

/** Interrupt (node-usb) transport */
class InterruptTransport extends BaseTransport {
  constructor(device, iface, epOut, epIn, packetFormat) {
    super("interrupt");
    this.dev = device;
    this.iface = iface;
    this.epOut = epOut;
    this.epIn = epIn;
    this.packetFormat = packetFormat; // 'hid64' or 'raw64'
  }
  async writeFrame(buf) {
    // Optionally drop the reportId for 'raw64'
    let toSend = buf;
    if (this.packetFormat === "raw64") {
      // send bytes 0..63 minus reportId (shift left 1) – but *only* if caller built a hid-style frame
      // To avoid assumptions, we only drop 1 byte (reportId) if buf.length === 64 and buf[0] === REPORT_ID.
      if (buf.length === 64 && buf[0] === REPORT_ID) {
        toSend = Buffer.from(buf.slice(0, 0).toString()); // no-op safeguard
        toSend = Buffer.alloc(64);
        // Build a 64B out of your [0..63] minus reportId (left shift by one):
        // bytes: [chkLo=buf[1], chkHi=buf[2], cmd=buf[3], payload=buf[4..63]]
        toSend[0] = buf[1];
        toSend[1] = buf[2];
        toSend[2] = buf[3];
        buf.slice(4).copy(toSend, 3);
      }
    }
    L.debug(`[USB][TX] ${Buffer.from(toSend).toString("hex")}`);
    await new Promise((resolve, reject) => {
      this.epOut.transfer(toSend, (err) => (err ? reject(err) : resolve()));
    });
  }
  async readOnce(timeoutMs = timing.readResponseMs) {
    return new Promise((resolve) => {
      let timed = false;
      const to = setTimeout(() => {
        timed = true;
        resolve(null);
      }, timeoutMs);
      this.epIn.transfer(64, (err, data) => {
        if (timed) return;
        clearTimeout(to);
        if (err || !data) return resolve(null);
        L.debug(`[USB][RX] ${Buffer.from(data).toString("hex")}`);
        resolve(Buffer.from(data));
      });
    });
  }
  close() {
    try {
      this.iface?.release(true, () => {
        try {
          this.dev?.close();
        } catch {}
      });
    } catch {
      try {
        this.dev?.close();
      } catch {}
    }
  }
}

/** HID (node-hid) transport */
class HidTransport extends BaseTransport {
  constructor(hidDevice) {
    super("hid");
    this.h = hidDevice;
  }
  async writeFrame(buf) {
    L.debug(`[HID][TX] ${Buffer.from(buf).toString("hex")}`);
    this.h.write([...buf]);
  }
  async readOnce(timeoutMs = timing.readResponseMs) {
    return new Promise((resolve) => {
      let responded = false;
      const to = setTimeout(() => {
        if (!responded) {
          responded = true;
          this.h.removeAllListeners("data");
          resolve(null);
        }
      }, timeoutMs);
      this.h.once("data", (data) => {
        if (responded) return;
        responded = true;
        clearTimeout(to);
        L.debug(`[HID][RX] ${Buffer.from(data).toString("hex")}`);
        resolve(Buffer.from(data));
      });
    });
  }
  async drain(quiescentMs = timing.drainIdleMs, hardLimitMs = timing.drainHardLimitMs) {
    const packets = [];
    const start = Date.now();
    let last = Date.now();
    const onData = (data) => {
      packets.push(Buffer.from(data));
      last = Date.now();
      L.debug(`[HID][RX] ${Buffer.from(data).toString("hex")}`);
    };
    this.h.on("data", onData);
    while (Date.now() - start < hardLimitMs) {
      await delay(5);
      if (Date.now() - last >= quiescentMs) break;
    }
    this.h.removeListener("data", onData);
    return packets;
  }
  close() {
    try {
      this.h?.close();
    } catch {}
  }
}

/* -------------------------------------------------------
 * Discovery + creators
 * -----------------------------------------------------*/
function findDeviceInfo() {
  const devices = HID.devices();
  L.info(`[DISCOVER] HID scan found ${devices.length} devices`);
  const dev = devices.find((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
  if (dev) L.info(`[DISCOVER] GMK87 (HID) path: ${dev.path}`);
  return dev || null;
}

function createInterruptTransport(packetFormat = PACKET_FORMAT_DEFAULT) {
  // Find USB device first
  const dev = usb.getDeviceList().find(
    (d) => d.deviceDescriptor?.idVendor === VENDOR_ID && d.deviceDescriptor?.idProduct === PRODUCT_ID
  );
  if (!dev) throw new Error("USB device not found for interrupt transport");
  dev.open();
  // Look for interface that exposes OUT 0x05 and IN 0x83
  let chosen = null;
  for (const iface of dev.interfaces) {
    try {
      iface.claim();
    } catch (e) {
      // may already be claimed later; try anyway
    }
    const eps = iface.endpoints || [];
    const out05 = eps.find((e) => e.direction === "out" && (e.address & 0xff) === 0x05);
    const in83 = eps.find((e) => e.direction === "in" && (e.address & 0xff) === 0x83);
    if (out05 && in83) {
      chosen = { iface, out: out05, in: in83 };
      break;
    }
    try {
      iface.release(true, () => {});
    } catch {}
  }
  if (!chosen) {
    dev.close();
    throw new Error("Interrupt endpoints 0x05/0x83 not found");
  }
  L.info("[USB] Using interrupt endpoints OUT 0x05 / IN 0x83");
  // Start the IN endpoint
  chosen.in.startPoll?.();
  return new InterruptTransport(dev, chosen.iface, chosen.out, chosen.in, packetFormat);
}

function createHidTransport() {
  const info = findDeviceInfo();
  if (!info) throw new Error("GMK87 device (HID) not found");
  const handle =
    process.platform === "darwin" ? new HID.HID(VENDOR_ID, PRODUCT_ID) : new HID.HID(info.path);
  return new HidTransport(handle);
}

/** Factory that prefers interrupt unless compat flag forces HID */
function createTransport(options = {}) {
  const {
    prefer = "interrupt",
    compat = COMPAT_DEFAULT,
    packetFormat = PACKET_FORMAT_DEFAULT,
    allowHidFallback = true,
  } = options;

  if (compat) {
    L.info("[MODE] COMPAT=true → forcing HID transport with legacy init");
    return createHidTransport();
  }

  if (prefer === "interrupt") {
    try {
      return createInterruptTransport(packetFormat);
    } catch (e) {
      L.warn(`[USB] Interrupt transport failed: ${e.message}`);
      if (!allowHidFallback) throw e;
      L.info("[USB] Falling back to HID transport");
      return createHidTransport();
    }
  }
  return createHidTransport();
}

/** Dev helper: prints the USB topology/interfaces/endpoints */
function printUsbTopology() {
  const dev = usb.getDeviceList().find(
    (d) => d.deviceDescriptor?.idVendor === VENDOR_ID && d.deviceDescriptor?.idProduct === PRODUCT_ID
  );
  if (!dev) {
    console.log("No GMK87 usb device found");
    return;
  }
  dev.open();
  console.log("USB Configuration count:", dev.configDescriptor?.bNumInterfaces);
  dev.interfaces.forEach((iface, idx) => {
    console.log(`Interface #${idx}`);
    (iface.endpoints || []).forEach((ep) => {
      const dir = ep.direction.toUpperCase();
      console.log(
        `  EP addr=0x${(ep.address & 0xff).toString(16).padStart(2, "0")} dir=${dir} type=${ep.transferType}`
      );
    });
  });
  try {
    dev.close();
  } catch {}
}

/* -------------------------------------------------------
 * Public-facing wrappers (names/signatures preserved)
 * -----------------------------------------------------*/
function openDevice(retries = 1, options = {}) {
  const {
    prefer = "interrupt",
    compat = COMPAT_DEFAULT,
    packetFormat = PACKET_FORMAT_DEFAULT,
    allowHidFallback = true,
  } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      L.info(`[OPEN] Opening device (attempt ${attempt + 1})...`);
      const transport = createTransport({ prefer, compat, packetFormat, allowHidFallback });
      L.info(`[OPEN] Opened ${transport.kind.toUpperCase()} transport`);
      return transport;
    } catch (e) {
      L.warn(`[OPEN] Failed: ${e.message}`);
      if (attempt === retries) throw e;
      L.info(`[OPEN] Retrying in ${timing.retryDelayMs}ms...`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timing.retryDelayMs);
    }
  }
  throw new Error("Unable to open device");
}

async function drainDevice(transport, timeoutMs = timing.drainHardLimitMs) {
  L.info("[DRAIN] Draining pending data...");
  const packets = await transport.drain(timing.drainIdleMs, timeoutMs);
  L.info(`[DRAIN] ${packets.length} packets`);
  return packets.map((b) => b.toString("hex"));
}

async function readResponse(transport, timeoutMs = timing.readResponseMs) {
  return await transport.readOnce(timeoutMs);
}

/**
 * Builds a 64-byte frame based on your current HID-style format:
 * [0]=REPORT_ID, [1..2]=checksum, [3]=cmd, [4..63]=payload (60B)
 */
function buildCommandFrame(command, data60 = null) {
  if (data60 === null) data60 = Buffer.alloc(60, 0x00);
  if (!Buffer.isBuffer(data60) || data60.length !== 60) {
    throw new Error("Invalid data length: need exactly 60 bytes");
  }
  const buf = Buffer.alloc(64, 0x00);
  buf[0] = REPORT_ID;
  buf[3] = command;
  data60.copy(buf, 4);
  const chk = checksum(buf);
  buf[1] = chk & 0xff;
  buf[2] = (chk >> 8) & 0xff;
  return buf;
}

async function send(transport, command, data60 = null, waitForAck = true) {
  const buf = buildCommandFrame(command, data60);
  await transport.writeFrame(buf);
  if (!waitForAck) return true;

  const response = await readResponse(transport, timing.readResponseMs);
  if (!response) {
    L.warn(`[ACK] No response for CMD 0x${command.toString(16)}`);
    return false;
  }
  // Expect first 8 bytes match (as in your original logic)
  const expected = buf.slice(0, 8);
  const received = response.slice(0, 8);
  if (expected.equals(received)) {
    L.info(`[ACK] OK for CMD 0x${command.toString(16)}`);
    return true;
  }
  L.warn(`[ACK] Mismatch for CMD 0x${command.toString(16)}`);
  L.debug(`Expected: ${expected.toString("hex")}`);
  L.debug(`Received: ${received.toString("hex")}`);
  return false;
}

async function trySend(transport, cmd, payload = undefined, tries = 3) {
  for (let i = 0; i < tries; i++) {
    L.info(`[TRY] CMD 0x${cmd.toString(16)} (attempt ${i + 1}/${tries})`);
    try {
      const ok =
        payload === undefined
          ? await send(transport, cmd, null, true)
          : await send(transport, cmd, payload, true);
      if (ok) return true;
    } catch (e) {
      L.warn(`[TRY] Error: ${e.message}`);
    }
    await delay(timing.retryDelayMs);
  }
  L.error(`[TRY] Failed after ${tries} attempts (CMD 0x${cmd.toString(16)})`);
  return false;
}

async function waitForReady(transport, timeoutMs = 1000) {
  L.info("[READY] Waiting for device ready (CMD 0x23)...");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await readResponse(transport, timing.readResponseMs);
    if (resp && resp[3] === 0x23) {
      L.info(`[READY] Device ready after ${Date.now() - start}ms`);
      return true;
    }
    await delay(10);
  }
  L.warn("[READY] Timed out");
  return false;
}

async function resetDeviceState(transport) {
  L.info("[RESET] Resetting device state...");
  await trySend(transport, 0x00, undefined, 1); // reset/init
  await delay(20);
  await trySend(transport, 0x23, undefined, 1); // status
  const stale = await transport.drain(timing.drainIdleMs, 120);
  L.info(`[RESET] Cleared ${stale.length} stale packets`);
  await delay(50);
  L.info("[RESET] Complete");
}

async function reviveDevice(transport) {
  L.info("[REVIVE] Attempting to revive...");
  try {
    // soft "kick": send a no-op frame
    const kick = Buffer.alloc(64, 0x00);
    kick[0] = REPORT_ID;
    await transport.writeFrame(kick);
    await delay(60);
  } catch (err) {
    L.warn(`[REVIVE] Kick failed: ${err.message}`);
  }

  // Reopen using same preference as original transport
  const prefer = transport.kind === "interrupt" ? "interrupt" : "hid";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      transport.close();
    } catch {}
    await delay(timing.reviveBaseBackoffMs * attempt);
    try {
      const reopened = openDevice(0, { prefer }); // preserve same kind if possible
      const drained = await drainDevice(reopened, 120);
      L.info(`[REVIVE] Drained ${drained.length} after reopen`);
      const ok = await trySend(reopened, 0x01, undefined, 1);
      if (ok) {
        L.info(`[REVIVE] Success on attempt ${attempt}`);
        return reopened;
      }
    } catch (err) {
      L.warn(`[REVIVE] Attempt ${attempt} failed: ${err.message}`);
    }
  }
  L.error("[REVIVE] Failed after 4 attempts");
  return null;
}

/* -------------------------------------------------------
 * Image framing & upload (unchanged signatures)
 * -----------------------------------------------------*/
async function buildImageFrames(imagePath, imageIndex = 0) {
  L.info(`[IMG] Building frames from ${imagePath} for slot ${imageIndex}`);
  const img = await Jimp.read(imagePath);
  if (img.bitmap.width !== DISPLAY_WIDTH || img.bitmap.height !== DISPLAY_HEIGHT) {
    L.info(`[IMG] Resizing to ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}`);
    img.resize(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  }

  const frames = [];
  const command = Buffer.alloc(64, 0);
  let startOffset = 0x00;
  let bufIndex = 0x08;

  function transmit() {
    if (bufIndex === 0x08) return;
    command[0x04] = BYTES_PER_FRAME;
    command[0x05] = startOffset & 0xff;
    command[0x06] = (startOffset >> 8) & 0xff;
    command[0x07] = imageIndex;
    frames.push(Buffer.from(command.subarray(4, 64)));
    L.debug(`[IMG] Frame ${frames.length} @ offset ${startOffset}`);
    startOffset += BYTES_PER_FRAME;
    bufIndex = 0x08;
    command.fill(0, 0x08);
  }

  for (let y = 0; y < DISPLAY_HEIGHT; y++) {
    for (let x = 0; x < DISPLAY_WIDTH; x++) {
      const { r, g, b } = Jimp.intToRGBA(img.getPixelColor(x, y));
      const rgb565 = toRGB565(r, g, b);
      command[bufIndex++] = (rgb565 >> 8) & 0xff;
      command[bufIndex++] = rgb565 & 0xff;
      if (bufIndex >= 64) transmit();
    }
  }
  transmit();
  L.info(`[IMG] Total frames: ${frames.length}`);
  return frames;
}

async function sendFrames(transport, frames, label = "frames", opts = {}) {
  const { ackEvery = 1 } = opts; // keep per-frame ACK by default (device does send ACKs)
  L.info(`[SEND] ${frames.length} ${label} (ackEvery=${ackEvery})`);
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < frames.length; i++) {
    const payload = frames[i];
    const ok = await trySend(transport, 0x21, payload, 3);
    if (ok) sent++;
    else failed++;
    if (i % 256 === 0 && i > 0) L.info(`[SEND] Progress ${i}/${frames.length}, failed=${failed}`);

    // Optional micro-pacing if needed; can be tuned out after testing
    if (transport.kind === "interrupt") await delay(2);
  }

  L.info(`[SEND] Sent ${sent}/${frames.length} (failed=${failed})`);
  return { sent, failed };
}

/* -------------------------------------------------------
 * Init & pipeline (unchanged signatures)
 * -----------------------------------------------------*/
async function initializeDevice(transport, shownImage = 0) {
  const usingInterrupt = transport.kind === "interrupt";
  const initMode = usingInterrupt ? "lean" : "legacy";
  L.info(`[INIT] mode=${initMode} (${transport.kind})`);

  if (initMode === "lean") {
    // Minimal init: try simple handshake + status
    let ok = await trySend(transport, 0x01, undefined, 1);
    if (!ok) {
      L.warn("[INIT] No INIT ACK — reviving...");
      const revived = await reviveDevice(transport);
      if (!revived) throw new Error("Device could not be revived");
      transport = revived;
    }
    await delay(5);
    await trySend(transport, 0x23, undefined, 1); // status/ready
    await waitForReady(transport, 600);
  } else {
    // Legacy path (your previous sequence)
    let success = await trySend(transport, 0x01);
    if (!success) {
      L.warn("[INIT] No INIT ACK — reviving...");
      const revived = await reviveDevice(transport);
      if (!revived) throw new Error("Device could not be revived");
      transport = revived;
    }
    await delay(3);
    await trySend(transport, 0x01);
    await delay(2);
    await send(transport, 0x06, Buffer.alloc(60, 0x00));
    await delay(20);
    await trySend(transport, 0x02);
    await delay(15);
    await trySend(transport, 0x23);
    await waitForReady(transport, 800);
  }

  return transport;
}

async function uploadImageToDevice(imagePath, imageIndex = 0, options = {}) {
  const {
    showAfter = true,
    prefer = "interrupt",
    compat = COMPAT_DEFAULT,
    packetFormat = PACKET_FORMAT_DEFAULT,
    allowHidFallback = true,
  } = options;

  const shownImage = showAfter ? imageIndex + 1 : 0;
  let transport = openDevice(0, { prefer, compat, packetFormat, allowHidFallback });

  try {
    L.info("[PIPE] Starting upload pipeline...");
    const drained = await drainDevice(transport, 120);
    if (drained.length) L.info(`[PIPE] Drained ${drained.length}`);

    await resetDeviceState(transport);
    transport = await initializeDevice(transport, shownImage);

    const frames = await buildImageFrames(imagePath, imageIndex);
    await sendFrames(transport, frames, `slot${imageIndex}`, { ackEvery: 1 });

    await trySend(transport, 0x02); // finalize/end transfer
    L.info("[PIPE] Upload complete!");
    return true;
  } finally {
    try {
      transport?.close();
      L.info("[CLOSE] Transport closed");
    } catch {}
  }
}

/* -------------------------------------------------------
 * Exports (unchanged list)
 * -----------------------------------------------------*/
export {
  // IDs & constants
  VENDOR_ID,
  PRODUCT_ID,
  REPORT_ID,
  BYTES_PER_FRAME,
  DISPLAY_WIDTH,
  DISPLAY_HEIGHT,
  LOG_LEVEL,

  // utils
  delay,
  toRGB565,
  toHexNum,
  checksum,

  // discovery (name preserved)
  findDeviceInfo,

  // open/close/drain & comms (names/signatures preserved)
  openDevice,
  drainDevice,
  readResponse,
  send,
  trySend,
  waitForReady,
  resetDeviceState,
  reviveDevice,

  // image path
  buildImageFrames,
  sendFrames,

  // pipeline
  initializeDevice,
  uploadImageToDevice,

  // dev helper
  printUsbTopology,
};
