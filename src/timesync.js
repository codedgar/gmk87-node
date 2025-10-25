/**
 * @fileoverview Time synchronization utility for GMK87 keyboard
 * Sends the current system time to the device's internal clock
 * Useful for keeping the keyboard's RTC (Real-Time Clock) synchronized
 */

import {
  findDeviceInfo,
  openDevice,
  sendConfigFrame,
} from "./lib/device.js";

/**
 * Main time synchronization function
 * Detects the GMK87 device, opens a connection, sends the current time,
 * and closes the connection
 * @returns {Promise<void>} Resolves when time sync is complete
 * @throws {Error} If device is not found or connection fails
 */
async function main() {
  const info = findDeviceInfo();
  if (!info) {
    console.log("No device with PID 0x5055 found.");
    process.exit(1);
  }
  console.log(
    `Device Found: ${info.product || "(unknown name)"} | VID: ${info.vendorId.toString(16)} PID: ${info.productId.toString(16)}`
  );

  let device;
  try {
    device = openDevice();
  } catch (e) {
    console.error("Failed to open HID device:", e.message);
    console.error("Try running with sudo or check permissions.");
    process.exit(1);
  }

  console.log("Sending time synchronization frame...");
  await sendConfigFrame(device);
  console.log("✓ Time synchronized successfully");

  device.close();
}

// -------------------------------------------------------
// Entry Point
// -------------------------------------------------------

/**
 * Check if this script is being run directly (not imported as a module)
 * If so, execute the main function
 */
const isMain =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// -------------------------------------------------------
// Exports
// -------------------------------------------------------

// Re-export for backward compatibility
export { sendConfigFrame } from "./lib/device.js";