/**
 * @fileoverview Low-level device communication library for GMK87 keyboard
 * Handles HID protocol, device detection, connection management, command sending,
 * frame building, and complete upload pipelines
 */

import HID from "node-hid";
import Jimp from "jimp";

/** @constant {number} USB Vendor ID for GMK87 keyboard */
const VENDOR_ID = 0x320f;

/** @constant {number} USB Product ID for GMK87 keyboard */
const PRODUCT_ID = 0x5055;

/** @constant {number} HID Report ID used for all communications */
const REPORT_ID = 0x04;

/** @constant {number} Number of data bytes per frame packet */
const BYTES_PER_FRAME = 0x38;

/** @constant {number} Target display width in pixels */
const DISPLAY_WIDTH = 240;

/** @constant {number} Target display height in pixels */
const DISPLAY_HEIGHT = 135;

// -------------------------------------------------------
// Common Utilities
// -------------------------------------------------------

/**
 * Creates a promise that resolves after a specified delay
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>} Promise that resolves after the delay
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Converts RGB color values to RGB565 format (16-bit color)
 * RGB565 uses 5 bits for red, 6 bits for green, and 5 bits for blue
 * @param {number} r - Red component (0-255)
 * @param {number} g - Green component (0-255)
 * @param {number} b - Blue component (0-255)
 * @returns {number} 16-bit RGB565 color value
 */
function toRGB565(r, g, b) {
  const r5 = (r >> 3) & 0x1f;
  const g6 = (g >> 2) & 0x3f;
  const b5 = (b >> 3) & 0x1f;
  return (r5 << 11) | (g6 << 5) | b5;
}

/**
 * Converts a decimal number (0-99) to BCD (Binary-Coded Decimal) format
 * Used for encoding time/date values in device protocol
 * @param {number} num - Number to convert (0-99)
 * @returns {number} BCD-encoded value
 * @throws {RangeError} If num is outside the range 0-99
 * @example
 * toHexNum(42) // returns 0x42 (66 in decimal)
 * toHexNum(99) // returns 0x99 (153 in decimal)
 */
function toHexNum(num) {
  if (num < 0 || num >= 100) throw new RangeError("toHexNum expects 0..99");
  const low = num % 10;
  const high = Math.floor(num / 10);
  return (high << 4) | low;
}

// -------------------------------------------------------
// Device Detection & Connection
// -------------------------------------------------------

/**
 * Searches for GMK87 device in the system's HID device list
 * @returns {Object|undefined} HID device info object if found, undefined otherwise
 */
function findDeviceInfo() {
  const devices = HID.devices();
  return devices.find(
    (d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID
  );
}

/**
 * Opens a connection to the GMK87 device with retry logic
 * @param {number} [retries=2] - Number of retry attempts if opening fails
 * @returns {HID.HID} Connected HID device object
 * @throws {Error} If device not found or fails to open after all retries
 */
function openDevice(retries = 2) {
  const info = findDeviceInfo();
  if (!info) {
    throw new Error("GMK87 device not found (VID: 0x320f, PID: 0x5055)");
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (process.platform === "darwin") {
        return new HID.HID(VENDOR_ID, PRODUCT_ID);
      } else {
        return new HID.HID(info.path);
      }
    } catch (e) {
      if (attempt === retries) {
        throw new Error(
          `Failed to open HID device after ${retries + 1} attempts: ${e.message}`
        );
      }
      const waitMs = 10;
      const start = Date.now();
      while (Date.now() - start < waitMs) {}
    }
  }
}

/**
 * Drains/clears any pending data from the device buffer
 * This clears old/stale responses before starting fresh communication
 * @param {HID.HID} device - Connected HID device
 * @param {number} [timeoutMs=200] - Maximum time to wait for data to drain
 * @returns {Promise<string[]>} Array of hex strings representing drained data
 */
async function drainDevice(device, timeoutMs = 200) {
  return new Promise((resolve) => {
    const drained = [];
    let lastDataTime = Date.now();

    const checkDone = setInterval(() => {
      if (Date.now() - lastDataTime > 100) {
        clearInterval(checkDone);
        device.removeAllListeners("data");
        resolve(drained);
      }
    }, 50);

    device.on("data", (data) => {
      lastDataTime = Date.now();
      drained.push(Buffer.from(data).toString("hex"));
    });

    setTimeout(() => {
      clearInterval(checkDone);
      device.removeAllListeners("data");
      resolve(drained);
    }, timeoutMs);
  });
}

// -------------------------------------------------------
// Low-level Protocol Functions
// -------------------------------------------------------

/**
 * Calculates a 16-bit checksum for the device protocol
 * Sums bytes from position 3 to 63 in the buffer
 * @param {Buffer} buf - 64-byte buffer to calculate checksum for
 * @returns {number} 16-bit checksum value
 */
function checksum(buf) {
  let sum = 0;
  for (let i = 3; i < 64; i++) {
    sum = (sum + (buf[i] & 0xff)) & 0xffff;
  }
  return sum;
}

/**
 * Reads a single response from the device with timeout
 * @param {HID.HID} device - Connected HID device
 * @param {number} [timeoutMs=150] - Maximum time to wait for response
 * @returns {Promise<Buffer|null>} Response buffer or null if timeout
 */
async function readResponse(device, timeoutMs = 150) {
  return new Promise((resolve) => {
    let responded = false;
    const timeout = setTimeout(() => {
      if (!responded) {
        responded = true;
        device.removeAllListeners("data");
        resolve(null);
      }
    }, timeoutMs);

    device.once("data", (data) => {
      if (!responded) {
        responded = true;
        clearTimeout(timeout);
        resolve(Buffer.from(data));
      }
    });
  });
}

/**
 * Sends a command to the device and optionally waits for acknowledgment
 * @param {HID.HID} device - Connected HID device
 * @param {number} command - Command byte to send
 * @param {Buffer|null} [data60=null] - 60-byte data payload (will be zero-filled if null)
 * @param {boolean} [waitForAck=true] - Whether to wait for and verify acknowledgment
 * @returns {Promise<boolean>} True if successful, false if ACK missing or mismatched
 * @throws {Error} If data60 is provided but not exactly 60 bytes
 */
async function send(device, command, data60 = null, waitForAck = true) {
  if (data60 === null) {
    data60 = Buffer.alloc(60, 0x00);
  }

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

  device.write([...buf]);

  if (!waitForAck) {
    return true;
  }

  const response = await readResponse(device, 150);

  if (!response) {
    console.warn(
      `  ⚠ No ACK for cmd 0x${command.toString(16).padStart(2, "0")}`
    );
    return false;
  }

  const expectedAck = buf.slice(0, 8);
  const receivedAck = response.slice(0, 8);

  if (expectedAck.equals(receivedAck)) {
    return true;
  } else {
    console.warn(
      `  ✗ ACK mismatch for cmd 0x${command.toString(16).padStart(2, "0")}`
    );
    console.warn(`    Expected: ${expectedAck.toString("hex")}`);
    console.warn(`    Received: ${receivedAck.toString("hex")}`);
    return false;
  }
}

/**
 * Attempts to send a command with automatic retry logic
 * @param {HID.HID} device - Connected HID device
 * @param {number} cmd - Command byte to send
 * @param {Buffer} [payload] - Optional 60-byte data payload
 * @param {number} [tries=3] - Number of attempts before giving up
 * @returns {Promise<boolean>} True if any attempt succeeded, false if all failed
 * @throws {Error} If the last attempt throws an exception
 */
async function trySend(device, cmd, payload = undefined, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const success =
        payload === undefined
          ? await send(device, cmd)
          : await send(device, cmd, payload);

      if (success) return true;

      if (i < tries - 1) await delay(10);
    } catch (e) {
      if (i === tries - 1) throw e;
      await delay(10);
    }
  }

  console.error(
    `Failed to send cmd 0x${cmd.toString(16).padStart(2, "0")} after ${tries} attempts`
  );
  return false;
}

// -------------------------------------------------------
// Wait-until-ready logic
// -------------------------------------------------------

/**
 * Waits for the device to report ready status (command 0x23)
 * Polls the device until a ready response is received or timeout occurs
 * @param {HID.HID} device - Connected HID device
 * @param {number} [timeoutMs=1000] - Maximum time to wait for ready signal
 * @returns {Promise<boolean>} True if device reported ready, false if timeout
 */
async function waitForReady(device, timeoutMs = 1000) {
  console.log("Waiting for device to report ready (0x23)...");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await readResponse(device, 100);
    if (resp && resp.length >= 4 && resp[3] === 0x23) {
      console.log(`✓ Device reported ready after ${Date.now() - start} ms`);
      return true;
    }
    await delay(10);
  }
  console.warn("⚠ Timed out waiting for ready (0x23) response");
  return false;
}

// -------------------------------------------------------
// Configuration Command
// -------------------------------------------------------

/**
 * Sends a configuration frame to the device with display and timing settings
 * Includes current date/time, frame duration, and image configuration
 * @param {HID.HID} device - Connected HID device
 * @param {number} [shownImage=0] - Which image slot to display (0 or 1)
 * @param {number} [image0NumOfFrames=1] - Number of frames in image slot 0
 * @param {number} [image1NumOfFrames=1] - Number of frames in image slot 1
 * @returns {Promise<boolean>} True if command acknowledged successfully
 */
async function sendConfigFrame(
  device,
  shownImage = 0,
  image0NumOfFrames = 1,
  image1NumOfFrames = 1
) {
  const now = new Date();

  const frameDurationMs = 1000;
  const frameDurationLsb = frameDurationMs & 0xff;
  const frameDurationMsb = (frameDurationMs >> 8) & 0xff;

  const command = Buffer.alloc(64, 0x00);

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
  command[0x29] = shownImage;
  command[0x2a] = image0NumOfFrames;
  command[0x2b] = toHexNum(now.getSeconds());
  command[0x2c] = toHexNum(now.getMinutes());
  command[0x2d] = toHexNum(now.getHours());
  command[0x2e] = now.getDay();
  command[0x2f] = toHexNum(now.getDate());
  command[0x30] = toHexNum(now.getMonth() + 1);
  command[0x31] = toHexNum(now.getFullYear() % 100);
  command[0x33] = frameDurationLsb;
  command[0x34] = frameDurationMsb;
  command[0x36] = image1NumOfFrames;

  return await send(device, 0x06, command.subarray(4));
}

/**
 * Fully resets the GMK87's state machine before initialization
 * Flushes any pending responses, sends dummy commands to clear state,
 * and waits for the device buffer to be quiet
 * @param {HID.HID} device - Connected HID device
 * @returns {Promise<void>}
 */
async function resetDeviceState(device) {
  console.log("Resetting device state...");
  // Try to wake/clear with 0x00
  await trySend(device, 0x00, undefined, 1);
  await delay(50);

  // Send a Ready signal to flush any leftover 0x23 acks
  await trySend(device, 0x23, undefined, 1);

  // Drain anything that comes back
  const stale = await drainDevice(device, 500);
  if (stale.length) {
    console.log(`  Cleared ${stale.length} residual messages`);
  } else {
    console.log("  No residual messages in device buffer");
  }

  // Let the MCU breathe a bit before INIT
  await delay(200);
  console.log("Device state reset complete.");
}

/**
 * Attempts to revive a non-responsive HID endpoint without power-cycling
 * Sends a zero-length packet and reopens the device up to 6 times with
 * incremental backoff. After 3 failures, adds extended cooldown before
 * attempting the final 3 tries
 * @param {HID.HID} device - The potentially unresponsive HID device
 * @returns {Promise<HID.HID|null>} Revived device object or null if all attempts failed
 */
async function reviveDevice(device) {
  console.log("Attempting soft HID revive...");

  // Zero-length "kick" to flush endpoint
  try {
    const kick = Buffer.alloc(64, 0x00);
    kick[0] = REPORT_ID;
    device.write([...kick]);
    await delay(150);
  } catch {
    // ignore write errors
  }

  let reopened;
  for (let attempt = 1; attempt <= 6; attempt++) {
    // After 3 failed tries, longer cooldown before the last 3
    if (attempt === 4) {
      console.log("  Extended cooldown before final recovery phase...");
      await delay(2000); // 2-second cooldown
    }

    const backoff = attempt * 100; // incremental backoff 100–600 ms
    try {
      if (reopened) {
        try {
          reopened.close();
        } catch {}
      }
      device.close();
    } catch {}

    await delay(150);

    try {
      reopened = openDevice();
      console.log(`  Reopen attempt ${attempt}: OK`);

      await drainDevice(reopened, 300);

      const ok = await trySend(reopened, 0x01);
      if (ok) {
        console.log(`✓ Device revived successfully on attempt ${attempt}.`);
        return reopened;
      } else {
        console.warn(`  No ACK on INIT during attempt ${attempt}.`);
      }
    } catch (err) {
      console.warn(`  Reopen attempt ${attempt} failed: ${err.message}`);
    }

    console.log(`  Waiting ${backoff} ms before next attempt...`);
    await delay(backoff);
  }

  console.error(
    "✗ Soft HID revive failed after 6 attempts — physical replug may be required."
  );
  return null;
}

// -------------------------------------------------------
// Frame Building & Transmission (NEW CONSOLIDATED FUNCTIONS)
// -------------------------------------------------------

/**
 * Builds frame data from an image file for transmission to the device
 * Loads the image, resizes it to 240x135, converts pixels to RGB565 format,
 * and chunks them into 64-byte frames for the HID protocol
 * @param {string} imagePath - Path to the image file to load
 * @param {number} [imageIndex=0] - Target image slot on device (0 or 1)
 * @returns {Promise<Buffer[]>} Array of 60-byte frame buffers ready for transmission
 * @throws {Error} If image cannot be loaded or processed
 */
async function buildImageFrames(imagePath, imageIndex = 0) {
  console.log(`Loading image: ${imagePath} for slot ${imageIndex}`);
  const img = await Jimp.read(imagePath);

  if (img.bitmap.width !== DISPLAY_WIDTH || img.bitmap.height !== DISPLAY_HEIGHT) {
    console.log(`Resizing image to ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}...`);
    img.resize(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  }

  const frames = [];
  const command = Buffer.alloc(64, 0);
  let startOffset = 0x00;
  let bufIndex = 0x08;

  /**
   * Internal helper: transmits accumulated pixel data as a frame
   * @private
   */
  function transmit() {
    if (bufIndex === 0x08) return;

    command[0x04] = BYTES_PER_FRAME;
    command[0x05] = startOffset & 0xff;
    command[0x06] = (startOffset >> 8) & 0xff;
    command[0x07] = imageIndex;

    frames.push(Buffer.from(command.subarray(4, 64)));

    startOffset += BYTES_PER_FRAME;
    bufIndex = 0x08;
    command.fill(0, 0x08);
  }

  // Convert each pixel to RGB565 and pack into frames
  for (let y = 0; y < DISPLAY_HEIGHT; y++) {
    for (let x = 0; x < DISPLAY_WIDTH; x++) {
      const { r, g, b } = Jimp.intToRGBA(img.getPixelColor(x, y));
      const rgb565 = toRGB565(r, g, b);

      command[bufIndex++] = (rgb565 >> 8) & 0xff;
      command[bufIndex++] = rgb565 & 0xff;

      if (bufIndex >= 64) {
        transmit();
      }
    }
  }

  transmit(); // Flush any remaining data

  console.log(`Total frames generated: ${frames.length}`);
  return frames;
}

/**
 * Transmits an array of frames to the device with progress reporting and error handling
 * Sends frames using command 0x21 with automatic retry and ACK verification
 * @param {HID.HID} device - Connected HID device
 * @param {Buffer[]} frames - Array of frame buffers to send
 * @param {string} [label="frames"] - Label for progress messages
 * @returns {Promise<{sent: number, failed: number}>} Statistics about transmission success
 * @throws {Error} If more than 10 frames fail to receive acknowledgment
 */
async function sendFrames(device, frames, label = "frames") {
  console.log(`Sending ${frames.length} ${label}...`);
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < frames.length; i++) {
    const success = await trySend(device, 0x21, frames[i], 3);

    if (success) {
      sent++;
    } else {
      failed++;
      if (failed > 10) {
        throw new Error(`Too many failed ACKs (${failed}), aborting upload`);
      }
    }

    // Progress reporting every 256 frames
    if (i % 256 === 0 && i > 0) {
      console.log(`  Progress: ${i}/${frames.length} (${failed} failed ACKs)`);
    }
  }

  console.log(`  Sent ${sent}/${frames.length} ${label} (${failed} failed ACKs)`);

  if (failed > 0) {
    console.warn(`  ⚠ Warning: ${failed} frames may not have been acknowledged`);
  }

  return { sent, failed };
}

// -------------------------------------------------------
// High-Level Initialization & Upload Pipeline (NEW)
// -------------------------------------------------------

/**
 * Performs the complete device initialization sequence
 * Executes the handshake protocol, sends configuration, and waits for ready signal
 * Includes automatic device revival if initial handshake fails
 * @param {HID.HID} device - Connected HID device
 * @param {number} [shownImage=0] - Which image slot to display after upload (0=none, 1=slot0, 2=slot1)
 * @returns {Promise<HID.HID>} The device handle (may be a revived instance)
 * @throws {Error} If initialization fails or device doesn't respond
 */
async function initializeDevice(device, shownImage = 0) {
  console.log("Initializing device with ACK handshake...");

  let success = await trySend(device, 0x01);
  if (!success) {
    console.warn("No INIT ACK — trying soft revive...");
    const revived = await reviveDevice(device);
    if (!revived) throw new Error("Device could not be revived.");
    device = revived;
  }
  await delay(3);

  success = await trySend(device, 0x01);
  if (!success) throw new Error("Device not responding to 2nd INIT!");
  await delay(2);

  success = await sendConfigFrame(device, shownImage, 1, 1);
  if (!success) throw new Error("Device not responding to CONFIG!");
  await delay(25);

  success = await trySend(device, 0x02);
  if (!success) throw new Error("Device not responding to COMMIT!");
  await delay(18);

  success = await trySend(device, 0x23);
  if (!success) throw new Error("Device not responding to 0x23 command!");

  await waitForReady(device);

  return device; // Return potentially revived device
}

/**
 * Complete pipeline to upload an image to the GMK87 device
 * Handles device connection, initialization, frame building, transmission, and cleanup
 * @param {string} imagePath - Path to the image file to upload
 * @param {number} [imageIndex=0] - Target slot on device (0 or 1)
 * @param {Object} [options={}] - Upload options
 * @param {boolean} [options.showAfter=true] - Whether to display the image after upload
 * @returns {Promise<boolean>} True if upload completed successfully
 * @throws {Error} If device connection fails or upload encounters errors
 */
async function uploadImageToDevice(imagePath, imageIndex = 0, options = {}) {
  const { showAfter = true } = options;
  const shownImage = showAfter ? imageIndex + 1 : 0;

  let device = openDevice();

  try {
    console.log("Clearing device buffer...");
    const stale = await drainDevice(device);
    if (stale.length > 0) {
      console.log(`  Drained ${stale.length} stale messages`);
    }

    await resetDeviceState(device);

    device = await initializeDevice(device, shownImage);

    console.log(`Building frames for slot ${imageIndex}...`);
    const frames = await buildImageFrames(imagePath, imageIndex);

    console.log(`Uploading ${frames.length} frames...`);
    await sendFrames(device, frames, `slot ${imageIndex}`);

    const success = await trySend(device, 0x02);
    if (!success) {
      console.warn("Final COMMIT may not have been acknowledged");
    }

    console.log("✓ Upload complete!");
    return true;
  } finally {
    try {
      if (device) device.close();
    } catch {}
  }
}

// -------------------------------------------------------
// Exports
// -------------------------------------------------------

export {
  // Constants
  VENDOR_ID,
  PRODUCT_ID,
  REPORT_ID,
  BYTES_PER_FRAME,
  DISPLAY_WIDTH,
  DISPLAY_HEIGHT,
  // Utilities
  delay,
  toRGB565,
  toHexNum,
  // Device Connection
  findDeviceInfo,
  openDevice,
  drainDevice,
  // Protocol Functions
  checksum,
  send,
  trySend,
  readResponse,
  waitForReady,
  // Configuration
  sendConfigFrame,
  resetDeviceState,
  reviveDevice,
  // Frame Building & Transmission (NEW)
  buildImageFrames,
  sendFrames,
  // High-Level Pipeline (NEW)
  initializeDevice,
  uploadImageToDevice,
};