/**
 * @fileoverview Direct image upload utility for GMK87 keyboard
 * Uploads pre-formatted BMP images to both device slots without ImageMagick dependency
 * Expects images to already be in 240x135 pixel format
 */

import {
  openDevice,
  drainDevice,
  resetDeviceState,
  reviveDevice,
  initializeDevice,
  buildImageFrames,
  sendFrames,
  trySend,
  delay,
} from "./lib/device.js";

/**
 * Main upload function - uploads two images to device slots 0 and 1
 * Performs full device initialization and uploads both images sequentially
 * Uses hardcoded image paths: "nyan.bmp" for slot 0, "encoded-rgb555.bmp" for slot 1
 * @returns {Promise<void>} Resolves when both uploads complete successfully
 * @throws {Error} If device initialization fails or upload encounters errors
 */
async function main() {
  let device = openDevice();

  console.log("Clearing device buffer...");
  const stale = await drainDevice(device);
  if (stale.length > 0) {
    console.log(`  Drained ${stale.length} stale messages`);
  }

  await resetDeviceState(device);

  console.log("Starting image upload with ACK verification...");

  // Initialize device (shownImage=2 means show slot 1 after upload)
  device = await initializeDevice(device, 2);

  // Upload first image to slot 0
  console.log("\n=== Uploading Image to slot 0 ===");
  const frames0 = await buildImageFrames("nyan.bmp", 0);
  await sendFrames(device, frames0, "Image slot 0");

  await delay(100);

  // Upload second image to slot 1
  console.log("\n=== Uploading Image to slot 1 ===");
  const frames1 = await buildImageFrames("encoded-rgb555.bmp", 1);
  await sendFrames(device, frames1, "Image slot 1");

  // Final commit
  const success = await trySend(device, 0x02);
  if (!success) console.warn("Final COMMIT may not have been acknowledged");

  console.log("\n✓ Upload complete!");
  device.close();
}

// -------------------------------------------------------
// Entry Point
// -------------------------------------------------------

main().catch((e) => console.error(e));