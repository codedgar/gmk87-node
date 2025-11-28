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
// Python-Compatible Protocol Functions
// -------------------------------------------------------

/**
 * Sends a command using the Python/USB protocol format (with length and position metadata)
 * This matches the reference.py implementation exactly
 * @param {HID.HID} device - Connected HID device
 * @param {number} commandId - Command byte (1-255)
 * @param {Buffer} data - Data payload (max 56 bytes)
 * @param {number} [pos=0] - Position offset (24-bit)
 * @returns {Promise<Buffer|null>} Response data from byte 4 onwards, or null if failed
 */
async function sendWithPosition(device, commandId, data, pos = 0) {
  if (commandId < 1 || commandId > 0xff) {
    throw new Error("Command ID must be between 1 and 255");
  }
  if (data.length > 56) {
    throw new Error("Data payload cannot exceed 56 bytes");
  }

  // Add delay before command 2 (like Python does)
  if (commandId === 2) {
    await delay(100);
  }

  const buffer = Buffer.alloc(64, 0x00);
  buffer[0] = 0x04;               // Report ID
  buffer[3] = commandId;          // Command
  buffer[4] = data.length;        // Data length
  buffer[5] = pos & 0xff;         // Position LSB
  buffer[6] = (pos >> 8) & 0xff;  // Position mid byte
  buffer[7] = (pos >> 16) & 0xff; // Position MSB

  // Copy data starting at byte 8
  data.copy(buffer, 8);

  // Calculate checksum of bytes 3-63
  const chk = checksum(buffer);
  buffer[1] = chk & 0xff;
  buffer[2] = (chk >> 8) & 0xff;

  device.write([...buffer]);

  // Wait for response
  const response = await readResponse(device, 150);
  if (!response) {
    return null;
  }

  // Check if response header matches (bytes 0-2: report ID + checksum)
  if (response[0] === buffer[0] &&
      response[1] === buffer[1] &&
      response[2] === buffer[2]) {
    // Return data from byte 4 onwards (like Python does)
    return response.slice(4);
  }

  return null;
}

/**
 * Reads the current configuration from the device using Python protocol
 * @param {HID.HID} device - Connected HID device
 * @returns {Promise<Buffer>} 48-byte configuration buffer
 * @throws {Error} If reading fails
 */
async function readConfigFromDevice(device) {
  console.log("Reading configuration using Python protocol...");

  // Step 1: Init command
  await sendWithPosition(device, 0x01, Buffer.alloc(0), 0);

  // Step 2: Send command 0x03 (prepare read) - 9 times for 4-byte chunks
  for (let i = 0; i < 9; i++) {
    await sendWithPosition(device, 0x03, Buffer.alloc(4, 0x00), i * 4);
  }
  // Final prep for byte 36
  await sendWithPosition(device, 0x03, Buffer.alloc(1, 0x00), 36);

  // Step 3: Commit
  await sendWithPosition(device, 0x02, Buffer.alloc(0), 0);

  // Step 4: Read configuration in 12 chunks of 4 bytes using command 0x05
  const configBuffer = Buffer.alloc(48, 0x00);

  for (let i = 0; i < 12; i++) {
    const position = i * 4;
    const chunk = await sendWithPosition(device, 0x05, Buffer.alloc(4, 0x00), position);

    if (chunk && chunk.length >= 4) {
      // Chunk contains response data (already sliced from byte 4)
      chunk.slice(0, 4).copy(configBuffer, position);
    } else {
      console.warn(`Failed to read config chunk ${i} at position ${position}`);
    }
  }

  console.log(`✓ Configuration read (48 bytes): ${configBuffer.toString('hex')}`);
  return configBuffer;
}

/**
 * Parses 48-byte config buffer into structured object
 * @param {Buffer} configBuffer - 48-byte configuration
 * @returns {Object} Parsed configuration
 */
function parseConfigBuffer(configBuffer) {
  return {
    underglow: {
      effect: configBuffer[1],
      brightness: configBuffer[2],
      speed: configBuffer[3],
      orientation: configBuffer[4],
      rainbow: configBuffer[5],
      hue: {
        red: configBuffer[6],
        green: configBuffer[7],
        blue: configBuffer[8],
      },
    },
    winlock: configBuffer[21],
    led: {
      mode: configBuffer[28],
      saturation: configBuffer[29],
      rainbow: configBuffer[31],
      color: configBuffer[32],
    },
    showImage: configBuffer[33],
    image1Frames: configBuffer[34],
    time: {
      second: configBuffer[35],
      minute: configBuffer[36],
      hour: configBuffer[37],
      dayOfWeek: configBuffer[38],
      date: configBuffer[39],
      month: configBuffer[40],
      year: configBuffer[41],
    },
    frameDuration: configBuffer[43] | (configBuffer[44] << 8),
    image2Frames: configBuffer[46],
    _raw: configBuffer,
  };
}

/**
 * Builds 48-byte config buffer from existing config + changes
 * @param {Object} existingConfig - Current config (from parseConfigBuffer)
 * @param {Object} changes - Changes to apply
 * @returns {Buffer} Updated 48-byte configuration buffer
 */
function buildConfigBuffer(existingConfig, changes) {
  const buffer = Buffer.from(existingConfig._raw);

  // Apply underglow changes
  if (changes.underglow) {
    if (changes.underglow.effect !== undefined) buffer[1] = changes.underglow.effect;
    if (changes.underglow.brightness !== undefined) buffer[2] = changes.underglow.brightness;
    if (changes.underglow.speed !== undefined) buffer[3] = changes.underglow.speed;
    if (changes.underglow.orientation !== undefined) buffer[4] = changes.underglow.orientation;
    if (changes.underglow.rainbow !== undefined) buffer[5] = changes.underglow.rainbow;
    if (changes.underglow.hue) {
      if (changes.underglow.hue.red !== undefined) buffer[6] = changes.underglow.hue.red;
      if (changes.underglow.hue.green !== undefined) buffer[7] = changes.underglow.hue.green;
      if (changes.underglow.hue.blue !== undefined) buffer[8] = changes.underglow.hue.blue;
    }
  }

  // Apply other changes
  if (changes.winlock !== undefined) buffer[21] = changes.winlock;

  if (changes.led) {
    if (changes.led.mode !== undefined) buffer[28] = changes.led.mode;
    if (changes.led.saturation !== undefined) buffer[29] = changes.led.saturation;
    if (changes.led.rainbow !== undefined) buffer[31] = changes.led.rainbow;
    if (changes.led.color !== undefined) buffer[32] = changes.led.color;
  }

  if (changes.showImage !== undefined) buffer[33] = changes.showImage;
  if (changes.image1Frames !== undefined) buffer[34] = changes.image1Frames;
  if (changes.image2Frames !== undefined) buffer[46] = changes.image2Frames;

  // Update time if requested
  if (changes.time) {
    const now = new Date();
    buffer[35] = toHexNum(now.getSeconds());
    buffer[36] = toHexNum(now.getMinutes());
    buffer[37] = toHexNum(now.getHours());
    buffer[38] = now.getDay();
    buffer[39] = toHexNum(now.getDate());
    buffer[40] = toHexNum(now.getMonth() + 1);
    buffer[41] = toHexNum(now.getFullYear() % 100);
  }

  if (changes.frameDuration !== undefined) {
    buffer[43] = changes.frameDuration & 0xff;
    buffer[44] = (changes.frameDuration >> 8) & 0xff;
  }

  return buffer;
}

/**
 * Writes config buffer to device using Python protocol
 * @param {HID.HID} device - Connected HID device
 * @param {Buffer} configBuffer - 48-byte configuration to write
 * @returns {Promise<boolean>} True if successful
 */
async function writeConfigToDevice(device, configBuffer) {
  console.log("Writing configuration using Python protocol...");

  // Step 1: Init
  await sendWithPosition(device, 0x01, Buffer.alloc(0), 0);

  // Step 2: Write config using command 0x06
  await sendWithPosition(device, 0x06, configBuffer, 0);

  // Step 3: Commit
  await sendWithPosition(device, 0x02, Buffer.alloc(0), 0);

  console.log("✓ Configuration written successfully");
  return true;
}

// -------------------------------------------------------
// Wait-until-ready logic
// -------------------------------------------------------

/**
 * Waits for the device to report ready status (command 0x23)
 * PASSIVELY LISTENS for device to send 0x23 response (not active pinging)
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

  command[0x04] = 0x29; // 0x29 = display/time only, 0x30 = full config including RGB
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

// -------------------------------------------------------
// Step 1: Reset Device State
// -------------------------------------------------------

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

// -------------------------------------------------------
// Step 2: Revive Device (if needed)
// -------------------------------------------------------

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
// Frame Building & Transmission
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
// Step 3: Initialize Device
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

// -------------------------------------------------------
// High-Level Image Upload Pipeline
// -------------------------------------------------------

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
    // -------------------------------------------------------
    // Step 1: Drain device buffer
    // -------------------------------------------------------
    console.log("Clearing device buffer...");
    const stale = await drainDevice(device);
    if (stale.length > 0) {
      console.log(`  Drained ${stale.length} stale messages`);
    }

    // -------------------------------------------------------
    // Step 2: Reset device state
    // -------------------------------------------------------
    await resetDeviceState(device);

    // -------------------------------------------------------
    // Step 3: Initialize device (includes revive if needed)
    // -------------------------------------------------------
    device = await initializeDevice(device, shownImage);

    // -------------------------------------------------------
    // Step 4: Build and send image frames
    // -------------------------------------------------------
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
// Lighting Configuration Functions
// -------------------------------------------------------

/**
 * Builds a lighting configuration frame
 * Creates a 64-byte configuration packet with RGB settings, LED modes, and time sync
 * @param {Object} config - Lighting configuration object
 * @param {Object} [config.underglow] - Underglow RGB configuration
 * @param {number} [config.underglow.effect] - Effect mode (0-18)
 * @param {number} [config.underglow.brightness] - Brightness (0-9)
 * @param {number} [config.underglow.speed] - Animation speed (0-9)
 * @param {number} [config.underglow.orientation] - Direction (0=L-R, 1=R-L)
 * @param {number} [config.underglow.rainbow] - Rainbow mode (0=off, 1=on)
 * @param {Object} [config.underglow.hue] - RGB color values
 * @param {Object} [config.led] - Big LED configuration
 * @param {number} [config.led.mode] - LED mode (0-4)
 * @param {number} [config.led.saturation] - Saturation (0-9)
 * @param {number} [config.led.rainbow] - Rainbow mode (0=off, 1=on)
 * @param {number} [config.led.color] - Color preset (0-8)
 * @param {number} [config.winlock] - Windows key lock (0=off, 1=on)
 * @param {number} [config.showImage] - Display mode (0=time, 1=image1, 2=image2)
 * @param {number} [config.image1Frames] - Frame count for image 1
 * @param {number} [config.image2Frames] - Frame count for image 2
 * @returns {Buffer} 64-byte configuration frame
 */
function buildLightingFrame(config) {
  const now = new Date();
  const buf = Buffer.alloc(64, 0x00);

  // Header
  buf[0] = REPORT_ID; // 0x04
  buf[3] = 0x06; // Config command
  buf[4] = 0x30; // Full configuration frame (0x30 includes RGB, 0x29 is display/time only)

  // Underglow configuration (bytes 0x09-0x10 = 9-16)
  if (config.underglow) {
    const ug = config.underglow;
    if (ug.effect !== undefined) buf[9] = ug.effect;
    if (ug.brightness !== undefined) buf[10] = ug.brightness;
    if (ug.speed !== undefined) buf[11] = ug.speed;
    if (ug.orientation !== undefined) buf[12] = ug.orientation;
    if (ug.rainbow !== undefined) buf[13] = ug.rainbow;
    if (ug.hue) {
      if (ug.hue.red !== undefined) buf[14] = ug.hue.red;
      if (ug.hue.green !== undefined) buf[15] = ug.hue.green;
      if (ug.hue.blue !== undefined) buf[16] = ug.hue.blue;
    }
  }

  // Unknown/reserved bytes (0x11-0x1c = 17-28)
  // These remain 0x00

  // Windows key lock (0x1d = 29)
  if (config.winlock !== undefined) {
    buf[29] = config.winlock;
  }

  // Unknown/reserved bytes (0x1e-0x23 = 30-35)
  // These remain 0x00

  // Big LED configuration (0x24-0x28 = 36-40)
  if (config.led) {
    const led = config.led;
    if (led.mode !== undefined) buf[36] = led.mode;
    if (led.saturation !== undefined) buf[37] = led.saturation;
    // buf[38] = 0x00; // Unknown
    if (led.rainbow !== undefined) buf[39] = led.rainbow;
    if (led.color !== undefined) buf[40] = led.color;
  }

  // Image display selection (0x29 = 41)
  if (config.showImage !== undefined) {
    buf[41] = config.showImage;
  }

  // Image frame counts (0x2a = 42, 0x36 = 54)
  if (config.image1Frames !== undefined) {
    buf[42] = config.image1Frames;
  }
  if (config.image2Frames !== undefined) {
    buf[54] = config.image2Frames;
  }

  // Time and date (0x2b-0x31 = 43-49)
  buf[43] = toHexNum(now.getSeconds());
  buf[44] = toHexNum(now.getMinutes());
  buf[45] = toHexNum(now.getHours());
  buf[46] = toHexNum(now.getDay()); // 0=Sunday
  buf[47] = toHexNum(now.getDate());
  buf[48] = toHexNum(now.getMonth() + 1); // Month is 0-indexed
  buf[49] = toHexNum(now.getFullYear() % 100);

  // Calculate and set checksum (bytes 0x01-0x02 = 1-2)
  const chk = checksum(buf);
  buf[1] = chk & 0xff; // LSB
  buf[2] = (chk >> 8) & 0xff; // MSB

  return buf;
}

/**
 * Sends a lighting configuration frame with acknowledgment checking
 * @param {HID.HID} device - Connected HID device
 * @param {Buffer} frameData - Complete 64-byte lighting frame
 * @param {boolean} [waitForAck=true] - Whether to wait for acknowledgment
 * @returns {Promise<boolean>} True if acknowledged, false otherwise
 */
async function sendLightingFrame(device, frameData, waitForAck = true) {
  if (!Buffer.isBuffer(frameData) || frameData.length !== 64) {
    throw new Error("Lighting frame must be exactly 64 bytes");
  }

  device.write([...frameData]);

  if (!waitForAck) {
    return true;
  }

  const response = await readResponse(device, 150);

  if (!response) {
    console.warn("  ⚠ No ACK for lighting config frame");
    return false;
  }

  // For lighting config frames, we check first 8 bytes as acknowledgment
  const expectedAck = frameData.slice(0, 8);
  const receivedAck = response.slice(0, 8);

  if (expectedAck.equals(receivedAck)) {
    return true;
  } else {
    console.warn("  ✗ ACK mismatch for lighting config frame");
    console.warn(`    Expected: ${expectedAck.toString("hex")}`);
    console.warn(`    Received: ${receivedAck.toString("hex")}`);
    return false;
  }
}

/**
 * Attempts to send a lighting config frame with automatic retry logic
 * @param {HID.HID} device - Connected HID device
 * @param {Buffer} frameData - Complete 64-byte frame to send
 * @param {number} [tries=3] - Number of attempts before giving up
 * @returns {Promise<boolean>} True if any attempt succeeded, false if all failed
 */
async function trySendLightingFrame(device, frameData, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const success = await sendLightingFrame(device, frameData, true);
      if (success) return true;

      if (i < tries - 1) await delay(10);
    } catch (e) {
      if (i === tries - 1) throw e;
      await delay(10);
    }
  }

  return false;
}

/**
 * Complete pipeline to configure lighting on the GMK87 device
 * NOW USES READ-MODIFY-WRITE: Reads current config, modifies only requested fields, writes back
 * @param {Object} changes - Lighting configuration changes to apply
 * @returns {Promise<boolean>} True if configuration was successfully applied
 * @throws {Error} If device connection fails or configuration cannot be applied
 */
async function configureLighting(changes) {
  let device = openDevice();

  try {
    console.log("Reading current configuration...");
    const currentConfig = parseConfigBuffer(await readConfigFromDevice(device));

    console.log("Current settings:");
    console.log(`  Underglow: effect=${currentConfig.underglow.effect}, brightness=${currentConfig.underglow.brightness}`);
    console.log(`  LED: mode=${currentConfig.led.mode}, color=${currentConfig.led.color}`);
    console.log(`  Images: slot0=${currentConfig.image1Frames}, slot1=${currentConfig.image2Frames}`);

    console.log("\nApplying changes (preserving other settings)...");
    const newConfig = buildConfigBuffer(currentConfig, changes);

    await writeConfigToDevice(device, newConfig);

    console.log("✓ Lighting configuration applied successfully!");
    return true;
  } finally {
    try {
      if (device) device.close();
    } catch {}
  }
}

/**
 * Syncs time to the keyboard
 * NOW USES READ-MODIFY-WRITE: Preserves all other settings
 * @param {Date} [date=new Date()] - Date object to sync
 * @returns {Promise<boolean>} True if time sync was successful
 */
async function syncTime(date = new Date()) {
  return await configureLighting({ time: true });
}

/**
 * Gets keyboard device information
 * @returns {Object} Device information object
 */
function getKeyboardInfo() {
  const device = openDevice();
  try {
    return {
      manufacturer: device.getManufacturerString?.() || "Unknown",
      product: device.getProductString?.() || "GMK87",
      vendorId: VENDOR_ID,
      productId: PRODUCT_ID,
    };
  } finally {
    device.close();
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
  sendConfigFrame,
  // Python-Compatible Protocol (NEW)
  sendWithPosition,
  readConfigFromDevice,
  parseConfigBuffer,
  buildConfigBuffer,
  writeConfigToDevice,
  // Device State Management
  resetDeviceState,
  reviveDevice,
  // Frame Building & Transmission
  buildImageFrames,
  sendFrames,
  // High-Level Pipelines
  initializeDevice,
  uploadImageToDevice,
  buildLightingFrame,
  sendLightingFrame,
  trySendLightingFrame,
  configureLighting,
  syncTime,
  getKeyboardInfo,
};