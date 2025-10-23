// src/lib/device.js
import HID from "node-hid";

const VENDOR_ID = 0x320f;
const PRODUCT_ID = 0x5055;
const REPORT_ID = 0x04;

// -------------------------------------------------------
// Common Utilities
// -------------------------------------------------------

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

// -------------------------------------------------------
// Device Detection & Connection
// -------------------------------------------------------

function findDeviceInfo() {
  const devices = HID.devices();
  return devices.find(
    (d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID
  );
}

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
 * Drain/clear any pending data from device buffer
 * This clears old/stale responses before starting fresh
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

function checksum(buf) {
  let sum = 0;
  for (let i = 3; i < 64; i++) {
    sum = (sum + (buf[i] & 0xff)) & 0xffff;
  }
  return sum;
}

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
// Wait-until-ready logic (NEW)
// -------------------------------------------------------

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
 * Fully resets the GMK87's state machine before INIT.
 * Flushes any pending responses, sends a dummy 0x00 and 0x23,
 * waits for quiet for up to 500 ms.
 */
export async function resetDeviceState(device) {
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
 * Try to revive a non-responsive HID endpoint without power-cycling.
 * Sends a zero-length packet and reopens the device up to 6 times.
 * After 3 failures, waits longer before doing the remaining 3 attempts.
 */
export async function reviveDevice(device) {
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
// Exports
// -------------------------------------------------------

export {
  VENDOR_ID,
  PRODUCT_ID,
  REPORT_ID,
  delay,
  toRGB565,
  toHexNum,
  findDeviceInfo,
  openDevice,
  drainDevice,
  checksum,
  send,
  trySend,
  sendConfigFrame,
  readResponse,
  waitForReady, // new export
};
