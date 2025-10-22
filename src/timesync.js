// src/timesync.js
import {
  findDeviceInfo,
  openDevice,
  sendConfigFrame,
} from "./lib/device.js";

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

  sendConfigFrame(device);

  device.close();
}

// Check if this is the main module being run directly
const isMain =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Re-export for backward compatibility
export { sendConfigFrame } from "./lib/device.js";