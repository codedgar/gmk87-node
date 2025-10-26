/**
 * @fileoverview Color and lighting control for GMK87
 * Handles LED configuration, underglow settings, and lighting frames
 */

import { REPORT_ID, checksum, delay, toHexNum } from "./protocol.js";
import { openDevice, drainDevice } from "./deviceConnection.js";
import { readResponse, trySend } from "./communication.js";

// -------------------------------------------------------
// Device State Management for Lighting
// -------------------------------------------------------

/**
 * Resets device state before lighting configuration
 * @param {HID.HID} device - Connected HID device
 * @returns {Promise<void>}
 */
async function resetDeviceState(device) {
  console.log("Resetting device state...");
  
  await trySend(device, 0x00, undefined, 1);
  await delay(50);

  await trySend(device, 0x23, undefined, 1);

  const stale = await drainDevice(device, 500);
  if (stale.length) {
    console.log(`  Cleared ${stale.length} residual messages`);
  } else {
    console.log("  No residual messages in device buffer");
  }

  await delay(200);
  console.log("Device state reset complete.");
}

/**
 * Attempts to revive a non-responsive device
 * @param {HID.HID} device - The potentially unresponsive HID device
 * @returns {Promise<HID.HID|null>} Revived device object or null
 */
async function reviveDevice(device) {
  console.log("Attempting soft HID revive...");

  try {
    const kick = Buffer.alloc(64, 0x00);
    kick[0] = REPORT_ID;
    device.write([...kick]);
    await delay(150);
  } catch {}

  let reopened;
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (attempt === 4) {
      console.log("  Extended cooldown before final recovery phase...");
      await delay(2000);
    }

    const backoff = attempt * 100;
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
// Lighting Frame Building
// -------------------------------------------------------

/**
 * Builds a complete lighting configuration frame
 * @param {Object} config - Configuration object with lighting settings
 * @param {Date} [now=new Date()] - Date object for time sync
 * @returns {Buffer} Complete 64-byte lighting frame ready to send
 */
export function buildLightingFrame(config, now = new Date()) {
  const buf = Buffer.alloc(64, 0x00);
  buf[0] = REPORT_ID;
  buf[3] = 0x30;

  // Keyboard backlight configuration (bytes 0x01-0x08 = 1-8)
  if (config.keyboard) {
    const kb = config.keyboard;
    if (kb.effect !== undefined) buf[1] = kb.effect;
    if (kb.brightness !== undefined) buf[2] = kb.brightness;
    if (kb.speed !== undefined) buf[3] = kb.speed;
    if (kb.orientation !== undefined) buf[4] = kb.orientation;
    if (kb.rainbow !== undefined) buf[5] = kb.rainbow;
    if (kb.hue) {
      if (kb.hue.red !== undefined) buf[6] = kb.hue.red;
      if (kb.hue.green !== undefined) buf[7] = kb.hue.green;
      if (kb.hue.blue !== undefined) buf[8] = kb.hue.blue;
    }
  }

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

  // Windows key lock (0x1d = 29)
  if (config.winlock !== undefined) {
    buf[29] = config.winlock;
  }

  // Big LED configuration (0x24-0x28 = 36-40)
  if (config.led) {
    const led = config.led;
    if (led.mode !== undefined) buf[36] = led.mode;
    if (led.saturation !== undefined) buf[37] = led.saturation;
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
  buf[46] = toHexNum(now.getDay());
  buf[47] = toHexNum(now.getDate());
  buf[48] = toHexNum(now.getMonth() + 1);
  buf[49] = toHexNum(now.getFullYear() % 100);

  // Calculate and set checksum (bytes 0x01-0x02 = 1-2)
  const chk = checksum(buf);
  buf[1] = chk & 0xff;
  buf[2] = (chk >> 8) & 0xff;

  return buf;
}

// -------------------------------------------------------
// Lighting Frame Transmission
// -------------------------------------------------------

/**
 * Sends a lighting configuration frame with acknowledgment checking
 * @param {HID.HID} device - Connected HID device
 * @param {Buffer} frameData - Complete 64-byte lighting frame
 * @param {boolean} [waitForAck=true] - Whether to wait for acknowledgment
 * @returns {Promise<boolean>} True if acknowledged, false otherwise
 */
export async function sendLightingFrame(device, frameData, waitForAck = true) {
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
export async function trySendLightingFrame(device, frameData, tries = 3) {
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

// -------------------------------------------------------
// High-Level Lighting Configuration
// -------------------------------------------------------

/**
 * Complete pipeline to configure lighting on the GMK87 device
 * @param {Object} config - Lighting configuration object
 * @returns {Promise<boolean>} True if configuration was successfully applied
 * @throws {Error} If device connection fails or configuration cannot be applied
 */
export async function configureLighting(config) {
  let device = openDevice();

  try {
    console.log("Clearing device buffer...");
    const stale = await drainDevice(device);
    if (stale.length > 0) {
      console.log(`  Drained ${stale.length} stale messages`);
    }

    await resetDeviceState(device);

    let success = await trySend(device, 0x01, undefined, 1);
    if (!success) {
      console.log("Device not responding, attempting revival...");
      const revived = await reviveDevice(device);
      if (!revived) {
        throw new Error("Device could not be revived.");
      }
      device = revived;
    }

    console.log("Building lighting configuration frame...");
    const frame = buildLightingFrame(config);

    console.log("Sending lighting configuration with acknowledgment checking...");
    success = await trySendLightingFrame(device, frame, 3);

    if (!success) {
      console.warn("⚠ Lighting configuration may not have been acknowledged by device");
      return false;
    }

    console.log("✓ Lighting configuration applied successfully!");
    await delay(100);
    return true;
  } finally {
    try {
      if (device) device.close();
    } catch {}
  }
}

/**
 * Syncs time to the keyboard
 * @param {Date} [date=new Date()] - Date object to sync
 * @returns {Promise<boolean>} True if time sync was successful
 */
export async function syncTime(date = new Date()) {
  return await configureLighting({});
}