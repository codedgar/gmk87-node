/**
 * @fileoverview Communication layer for GMK87
 * Handles sending commands, receiving responses, and ACK verification
 */

import { REPORT_ID, checksum, delay } from "./protocol.js";

// -------------------------------------------------------
// Low-level Protocol Functions
// -------------------------------------------------------

/**
 * Reads a single response from the device with timeout
 * @param {HID.HID} device - Connected HID device
 * @param {number} [timeoutMs=150] - Maximum time to wait for response
 * @returns {Promise<Buffer|null>} Response buffer or null if timeout
 */
export async function readResponse(device, timeoutMs = 150) {
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
 * This is the base send function used during initialization
 * @param {HID.HID} device - Connected HID device
 * @param {number} command - Command byte to send
 * @param {Buffer|null} [data60=null] - 60-byte data payload (will be zero-filled if null)
 * @param {boolean} [waitForAck=true] - Whether to wait for and verify acknowledgment
 * @returns {Promise<boolean>} True if successful, false if ACK missing or mismatched
 * @throws {Error} If data60 is provided but not exactly 60 bytes
 */
export async function send(device, command, data60 = null, waitForAck = true) {
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

  return await waitForInitAck(device, buf, command);
}

/**
 * Waits for and verifies initialization ACK
 * Used during device initialization and configuration
 * @param {HID.HID} device - Connected HID device
 * @param {Buffer} sentBuffer - The buffer that was sent
 * @param {number} command - Command byte for logging
 * @returns {Promise<boolean>} True if ACK matches, false otherwise
 */
export async function waitForInitAck(device, sentBuffer, command) {
  const response = await readResponse(device, 150);

  if (!response) {
    console.warn(
      `  ⚠ No ACK for cmd 0x${command.toString(16).padStart(2, "0")}`
    );
    return false;
  }

  const expectedAck = sentBuffer.slice(0, 8);
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
 * Waits for and verifies image upload ACK
 * Used specifically during image frame transmission
 * @param {HID.HID} device - Connected HID device
 * @param {Buffer} sentBuffer - The buffer that was sent
 * @param {number} [frameIndex] - Optional frame index for logging
 * @returns {Promise<boolean>} True if ACK matches, false otherwise
 */
export async function waitForImageAck(device, sentBuffer, frameIndex = null) {
  const response = await readResponse(device, 150);

  if (!response) {
    const msg = frameIndex !== null 
      ? `  ⚠ No ACK for image frame ${frameIndex}`
      : "  ⚠ No ACK for image frame";
    console.warn(msg);
    return false;
  }

  const expectedAck = sentBuffer.slice(0, 8);
  const receivedAck = response.slice(0, 8);

  if (expectedAck.equals(receivedAck)) {
    return true;
  } else {
    const msg = frameIndex !== null
      ? `  ✗ ACK mismatch for image frame ${frameIndex}`
      : "  ✗ ACK mismatch for image frame";
    console.warn(msg);
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
export async function trySend(device, cmd, payload = undefined, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const success = await send(device, cmd, payload, true);
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
 * Waits for device ready state by polling with 0x01 command
 * @param {HID.HID} device - Connected HID device
 * @param {number} [maxRetries=3] - Maximum number of polling attempts
 * @param {number} [delayMs=200] - Delay between polling attempts
 * @returns {Promise<boolean>} True if device becomes ready, false otherwise
 */
export async function waitForReady(device, maxRetries = 3, delayMs = 200) {
  for (let i = 0; i < maxRetries; i++) {
    const success = await send(device, 0x01, null, true);
    if (success) {
      return true;
    }
    if (i < maxRetries - 1) {
      await delay(delayMs);
    }
  }
  return false;
}

/**
 * Sends a configuration frame with specific sequence handling
 * @param {HID.HID} device - Connected HID device
 * @param {number} cmd - Command byte
 * @param {number} seq - Sequence number
 * @param {Buffer} data - Data payload
 * @returns {Promise<boolean>} True if successful
 */
export async function sendConfigFrame(device, cmd, seq, data) {
  const payload = Buffer.alloc(60, 0x00);
  payload[0] = seq;
  data.copy(payload, 1);
  return await send(device, cmd, payload, true);
}