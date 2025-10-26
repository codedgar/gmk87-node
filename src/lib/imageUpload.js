/**
 * @fileoverview Image upload functionality for GMK87
 * Handles image processing, frame building, and transmission with image-specific ACKs
 */

import Jimp from "jimp";
import {
  DISPLAY_WIDTH,
  DISPLAY_HEIGHT,
  BYTES_PER_FRAME,
  REPORT_ID,
  toRGB565,
  checksum,
  delay,
  toHexNum,
} from "./protocol.js";
import { openDevice, drainDevice } from "./deviceConnection.js";
import { readResponse, trySend, waitForImageAck } from "./communication.js";

// -------------------------------------------------------
// Image-Specific Communication
// -------------------------------------------------------

/**
 * Sends an image frame to the device and waits for image upload ACK
 * @param {HID.HID} device - Connected HID device
 * @param {number} command - Command byte to send
 * @param {Buffer} data60 - 60-byte data payload
 * @param {number} [frameIndex] - Frame index for logging
 * @returns {Promise<boolean>} True if successful, false if ACK missing or mismatched
 */
async function sendImageFrame(device, command, data60, frameIndex = null) {
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

  return await waitForImageAck(device, buf, frameIndex);
}

/**
 * Attempts to send an image frame with automatic retry logic
 * @param {HID.HID} device - Connected HID device
 * @param {number} cmd - Command byte to send
 * @param {Buffer} payload - 60-byte data payload
 * @param {number} [tries=3] - Number of attempts before giving up
 * @param {number} [frameIndex] - Frame index for logging
 * @returns {Promise<boolean>} True if any attempt succeeded, false if all failed
 */
async function trySendImageFrame(device, cmd, payload, tries = 3, frameIndex = null) {
  for (let i = 0; i < tries; i++) {
    try {
      const success = await sendImageFrame(device, cmd, payload, frameIndex);
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
// Device State Management for Image Upload
// -------------------------------------------------------

/**
 * Fully resets the GMK87's state machine before initialization
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
 * Attempts to revive a non-responsive HID endpoint
 * @param {HID.HID} device - The potentially unresponsive HID device
 * @returns {Promise<HID.HID|null>} Revived device object or null if all attempts failed
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

/**
 * Waits for the device to report ready status (command 0x23)
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

/**
 * Sends a configuration frame to the device
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

  command[0x04] = 0x29;
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

  const data60 = command.subarray(4);
  
  const buf = Buffer.alloc(64, 0x00);
  buf[0] = REPORT_ID;
  buf[3] = 0x06;
  data60.copy(buf, 4);

  const chk = checksum(buf);
  buf[1] = chk & 0xff;
  buf[2] = (chk >> 8) & 0xff;

  device.write([...buf]);

  const response = await readResponse(device, 150);
  if (!response) {
    console.warn("  ⚠ No ACK for config frame");
    return false;
  }

  const expectedAck = buf.slice(0, 8);
  const receivedAck = response.slice(0, 8);

  if (expectedAck.equals(receivedAck)) {
    return true;
  } else {
    console.warn("  ✗ ACK mismatch for config frame");
    return false;
  }
}

/**
 * Performs the complete device initialization sequence
 * @param {HID.HID} device - Connected HID device
 * @param {number} [shownImage=0] - Which image slot to display after upload
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

  return device;
}

// -------------------------------------------------------
// Frame Building & Transmission
// -------------------------------------------------------

/**
 * Builds frame data from an image file for transmission to the device
 * @param {string} imagePath - Path to the image file to load
 * @param {number} [imageIndex=0] - Target image slot on device (0 or 1)
 * @returns {Promise<Buffer[]>} Array of 60-byte frame buffers ready for transmission
 * @throws {Error} If image cannot be loaded or processed
 */
export async function buildImageFrames(imagePath, imageIndex = 0) {
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

  transmit();

  console.log(`Total frames generated: ${frames.length}`);
  return frames;
}

/**
 * Transmits an array of frames to the device with image-specific ACKs
 * @param {HID.HID} device - Connected HID device
 * @param {Buffer[]} frames - Array of frame buffers to send
 * @param {string} [label="frames"] - Label for progress messages
 * @returns {Promise<{sent: number, failed: number}>} Statistics about transmission success
 * @throws {Error} If more than 10 frames fail to receive acknowledgment
 */
export async function sendFrames(device, frames, label = "frames") {
  console.log(`Sending ${frames.length} ${label}...`);
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < frames.length; i++) {
    const success = await trySendImageFrame(device, 0x21, frames[i], 3, i);

    if (success) {
      sent++;
    } else {
      failed++;
      if (failed > 10) {
        throw new Error(`Too many failed ACKs (${failed}), aborting upload`);
      }
    }

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
// High-Level Image Upload Pipeline
// -------------------------------------------------------

/**
 * Complete pipeline to upload an image to the GMK87 device
 * @param {string} imagePath - Path to the image file to upload
 * @param {number} [imageIndex=0] - Target slot on device (0 or 1)
 * @param {Object} [options={}] - Upload options
 * @param {boolean} [options.showAfter=true] - Whether to display the image after upload
 * @returns {Promise<boolean>} True if upload completed successfully
 * @throws {Error} If device connection fails or upload encounters errors
 */
export async function uploadImageToDevice(imagePath, imageIndex = 0, options = {}) {
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

/**
 * Performs the complete device initialization sequence (exported for external use)
 * @param {HID.HID} device - Connected HID device
 * @param {number} [shownImage=0] - Which image slot to display after upload
 * @returns {Promise<HID.HID>} The device handle (may be a revived instance)
 */
export { initializeDevice };