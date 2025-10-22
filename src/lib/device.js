// src/lib/device.js
import HID from "node-hid";

const VENDOR_ID = 0x320f;
const PRODUCT_ID = 0x5055;
const REPORT_ID = 0x04;

// -------------------------------------------------------
// Common Utilities
// -------------------------------------------------------

/**
 * Delay helper for async operations
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convert RGB to RGB565 format
 * @param {number} r - Red (0-255)
 * @param {number} g - Green (0-255)
 * @param {number} b - Blue (0-255)
 * @returns {number} RGB565 value
 */
function toRGB565(r, g, b) {
  const r5 = (r >> 3) & 0x1f;
  const g6 = (g >> 2) & 0x3f;
  const b5 = (b >> 3) & 0x1f;
  return (r5 << 11) | (g6 << 5) | b5;
}

/**
 * Convert decimal number to BCD hex format (for time values)
 * @param {number} num - Number 0-99
 * @returns {number} BCD encoded value
 */
function toHexNum(num) {
  if (num < 0 || num >= 100) throw new RangeError("toHexNum expects 0..99");
  const low = num % 10;
  const high = Math.floor(num / 10);
  return (high << 4) | low; // e.g., 34 -> 0x34
}

// -------------------------------------------------------
// Device Detection & Connection
// -------------------------------------------------------

/**
 * Find the GMK87 device info
 * @returns {object|undefined} Device info object or undefined if not found
 */
function findDeviceInfo() {
  const devices = HID.devices();
  return devices.find(
    (d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID
  );
}

/**
 * Open connection to the GMK87 device
 * @param {number} retries - Number of retry attempts (default: 2)
 * @returns {HID.HID} Connected device object
 * @throws {Error} If device not found or connection fails
 */
function openDevice(retries = 2) {
  const info = findDeviceInfo();
  if (!info) {
    throw new Error("GMK87 device not found (VID: 0x320f, PID: 0x5055)");
  }

  // Try to open the device with retry logic
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (process.platform === "darwin") {
        // On macOS, opening by vid/pid is often more reliable
        return new HID.HID(VENDOR_ID, PRODUCT_ID);
      } else {
        // On Windows/Linux, prefer opening by path
        return new HID.HID(info.path);
      }
    } catch (e) {
      if (attempt === retries) {
        throw new Error(
          `Failed to open HID device after ${retries + 1} attempts: ${e.message}`
        );
      }
      // Brief pause before retry
      const waitMs = 10;
      const start = Date.now();
      while (Date.now() - start < waitMs) {
        /* busy wait */
      }
    }
  }
}

// -------------------------------------------------------
// Low-level Protocol Functions
// -------------------------------------------------------

/**
 * Calculate checksum for the command buffer
 * @param {Buffer} buf - 64-byte buffer
 * @returns {number} 16-bit checksum
 */
function checksum(buf) {
  let sum = 0;
  for (let i = 3; i < 64; i++) {
    sum = (sum + (buf[i] & 0xff)) & 0xffff;
  }
  return sum;
}

/**
 * Send a command to the device
 * @param {HID.HID} device - Connected device
 * @param {number} command - Command byte
 * @param {Buffer|null} data60 - 60-byte payload buffer (optional)
 */
function send(device, command, data60 = null) {
  if (data60 === null) {
    data60 = Buffer.alloc(60, 0x00);
  }

  if (!Buffer.isBuffer(data60) || data60.length !== 60) {
    throw new Error("Invalid data length: need exactly 60 bytes");
  }

  const buf = Buffer.alloc(64, 0x00);
  buf[0] = REPORT_ID; // report id
  buf[3] = command; // command id
  data60.copy(buf, 4); // payload

  const chk = checksum(buf);
  buf[1] = chk & 0xff; // checksum LSB
  buf[2] = (chk >> 8) & 0xff; // checksum MSB

  device.write([...buf]);
}

/**
 * Robust wrapper around send() with retry logic
 * @param {HID.HID} device - Connected device
 * @param {number} cmd - Command byte
 * @param {Buffer|undefined} payload - Optional 60-byte payload
 * @param {number} tries - Number of retry attempts (default: 3)
 */
async function trySend(device, cmd, payload = undefined, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      if (payload === undefined) {
        send(device, cmd);
      } else {
        send(device, cmd, payload);
      }
      return;
    } catch (e) {
      if (i === tries - 1) throw e;
      await delay(4);
    }
  }
}

/**
 * Send configuration frame with time sync and display settings
 * @param {HID.HID} device - Connected device
 * @param {number} shownImage - Which image to show: 0=time, 1=slot0, 2=slot1
 * @param {number} image0NumOfFrames - Number of frames in slot 0 (default: 1)
 * @param {number} image1NumOfFrames - Number of frames in slot 1 (default: 1)
 */
function sendConfigFrame(
  device,
  shownImage = 0,
  image0NumOfFrames = 1,
  image1NumOfFrames = 1
) {
  const now = new Date();

  const frameDurationMs = 1000; // 1000 ms
  const frameDurationLsb = frameDurationMs & 0xff;
  const frameDurationMsb = (frameDurationMs >> 8) & 0xff;

  const command = Buffer.alloc(64, 0x00);

  // Mirror C# implementation offsets
  command[0x04] = 0x30;
  command[0x09] = 0x08;
  command[0x0a] = 0x08;
  command[0x0b] = 0x01;
  command[0x0e] = 0x18;
  command[0x0f] = 0xff;
  command[0x11] = 0x0d;
  command[0x1c] = 0xff;
  command[0x25] = 0x09;
  command[0x26] = 0x02;
  command[0x28] = 0x01;
  command[0x29] = shownImage; // show image 0(time)/1/2
  command[0x2a] = image0NumOfFrames;
  command[0x2b] = toHexNum(now.getSeconds());
  command[0x2c] = toHexNum(now.getMinutes());
  command[0x2d] = toHexNum(now.getHours());
  command[0x2e] = now.getDay(); // 0=Sunday..6=Saturday
  command[0x2f] = toHexNum(now.getDate());
  command[0x30] = toHexNum(now.getMonth() + 1);
  command[0x31] = toHexNum(now.getFullYear() % 100);
  command[0x33] = frameDurationLsb;
  command[0x34] = frameDurationMsb;
  command[0x36] = image1NumOfFrames;

  send(device, 0x06, command.subarray(4));
}

// -------------------------------------------------------
// Exports
// -------------------------------------------------------

export {
  // Constants
  VENDOR_ID,
  PRODUCT_ID,
  REPORT_ID,
  // Utilities
  delay,
  toRGB565,
  toHexNum,
  // Device management
  findDeviceInfo,
  openDevice,
  // Protocol functions
  checksum,
  send,
  trySend,
  sendConfigFrame,
};