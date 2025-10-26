/**
 * @fileoverview Device connection and management for GMK87
 * Handles device detection, opening/closing connections, and buffer draining
 */

import HID from "node-hid";
import { VENDOR_ID, PRODUCT_ID } from "./protocol.js";

// -------------------------------------------------------
// Device Detection & Connection
// -------------------------------------------------------

/**
 * Searches for GMK87 device in the system's HID device list
 * @returns {Object|undefined} HID device info object if found, undefined otherwise
 */
export function findDeviceInfo() {
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
export function openDevice(retries = 2) {
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
export async function drainDevice(device, timeoutMs = 200) {
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

/**
 * Gets keyboard device information
 * @returns {Object} Device information object
 */
export function getKeyboardInfo() {
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