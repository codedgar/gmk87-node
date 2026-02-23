/**
 * @fileoverview Direct image upload utility for GMK87 keyboard
 * Uploads pre-formatted BMP images to both device slots without ImageMagick dependency
 * Expects images to already be in 240x135 pixel format
 */

import {
  openDevice,
  drainDevice,
  buildRawImageData,
  sendFrameData,
  sendWithPosition,
  delay,
} from "./lib/device.js";

// Import OLD protocol functions for config
import {
  initializeDevicePreservingLights,
} from "./lib/device-legacy.js";

/**
 * Main upload function - uploads two images to device slots 0 and 1
 * NOW USES READ-MODIFY-WRITE: Preserves existing lighting and LED settings during upload
 * Performs full device initialization and uploads both images sequentially
 * Uses hardcoded image paths: "nyan.bmp" for slot 0, "encoded-rgb555.bmp" for slot 1
 * @returns {Promise<void>} Resolves when both uploads complete successfully
 * @throws {Error} If device initialization fails or upload encounters errors
 */
async function main() {
  let device = openDevice();

  console.log("Clearing device buffer...");
  const stale = await drainDevice(device, 500);
  if (stale.length > 0) {
    console.log(`  Drained ${stale.length} stale messages`);
  }

  await delay(200); // Let device settle

  console.log("Starting image upload...");

  // Build raw image data (matches Python's encode_frame - 32KB padded per image)
  console.log("\n=== Building raw image data ===");
  const imageData0 = await buildRawImageData("nyan.bmp");
  const imageData1 = await buildRawImageData("encoded-rgb555.bmp");
  console.log(`Image 0: ${imageData0.length} bytes`);
  console.log(`Image 1: ${imageData1.length} bytes`);

  // CONCATENATE both images like Python does (lines 428-432 in reference.py)
  const concatenatedData = Buffer.concat([imageData0, imageData1]);
  console.log(`Total concatenated: ${concatenatedData.length} bytes\n`);

  // Initialize device using OLD protocol WITH lighting preservation
  console.log("=== Initializing device with OLD protocol (preserving lights) ===");
  device = await initializeDevicePreservingLights(device, 1); // shownImage=1 (show slot 0)

  console.log("Waiting for device to be ready...");
  await delay(1000);

  // Upload BOTH images in ONE session
  // Note: initializeDevicePreservingLights already sent 0x23 (READY) to start the upload session
  console.log("\n=== Uploading both images ===");
  await sendFrameData(device, concatenatedData, "both slots");

  console.log("\n=== Upload Commit ===");
  const response = await sendWithPosition(device, 0x02, Buffer.alloc(0), 0);
  if (!response) console.warn("Upload COMMIT may not have been acknowledged");

  console.log("\n✓ Upload complete!");
  device.close();
}

// -------------------------------------------------------
// Entry Point
// -------------------------------------------------------

main().catch((e) => console.error(e));