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
        device.removeAllListeners('data');
        resolve(drained);
      }
    }, 50);
    
    device.on('data', (data) => {
      lastDataTime = Date.now();
      drained.push(Buffer.from(data).toString('hex'));
    });
    
    setTimeout(() => {
      clearInterval(checkDone);
      device.removeAllListeners('data');
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
        device.removeAllListeners('data');
        resolve(null);
      }
    }, timeoutMs);

    device.once('data', (data) => {
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
    console.warn(`  ⚠ No ACK for cmd 0x${command.toString(16).padStart(2, '0')}`);
    return false;
  }

  const expectedAck = buf.slice(0, 8);
  const receivedAck = response.slice(0, 8);
  
  if (expectedAck.equals(receivedAck)) {
    return true;
  } else {
    console.warn(`  ✗ ACK mismatch for cmd 0x${command.toString(16).padStart(2, '0')}`);
    console.warn(`    Expected: ${expectedAck.toString('hex')}`);
    console.warn(`    Received: ${receivedAck.toString('hex')}`);
    return false;
  }
}

async function trySend(device, cmd, payload = undefined, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      let success;
      if (payload === undefined) {
        success = await send(device, cmd);
      } else {
        success = await send(device, cmd, payload);
      }
      
      if (success) {
        return true;
      }
      
      if (i < tries - 1) {
        await delay(10);
      }
    } catch (e) {
      if (i === tries - 1) throw e;
      await delay(10);
    }
  }
  
  console.error(`Failed to send cmd 0x${cmd.toString(16).padStart(2, '0')} after ${tries} attempts`);
  return false;
}

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
};