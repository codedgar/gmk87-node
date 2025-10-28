// src/diagnostic.js
/**
 * Minimal end-to-end diagnostic:
 * - Opens interrupt transport
 * - Performs INIT (0x01) and READY (0x23)
 * - Uploads a tiny slice (first 4 frames) to validate per-frame ACKs
 *
 * Run: node src/diagnostic.js ./nyan.bmp
 */

import {
  openDevice,
  resetDeviceState,
  initializeDevice,
  buildImageFrames,
  sendFrames,
  trySend,
} from "./lib/device.js";

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.error("Usage: node src/diagnostic.js <imagePath>");
    process.exit(1);
  }

  const transport = openDevice();
  try {
    await resetDeviceState(transport);
    await initializeDevice(transport);

    const frames = await buildImageFrames(imagePath, 0);
    // send just a handful to verify ACKs / status parsing
    const test = frames.slice(0, 4);
    await sendFrames(transport, test);

    // signal end-of-transfer
    await trySend(transport, 0x02, undefined, 2);
    console.log("[DIAG] OK");
  } finally {
    transport.close();
  }
}

main().catch((e) => {
  console.error("[DIAG] Failed:", e);
  process.exit(1);
});
