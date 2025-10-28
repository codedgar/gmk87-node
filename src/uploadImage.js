import {
  openDevice,
  resetDeviceState,
  initializeDevice,
  buildImageFrames,
  sendFrames,
  trySend,
  delay,
  releaseAndReattach, // <-- use this
} from "./lib/device.js";

async function main() {
  const device = openDevice();

  console.log("Clearing device state...");
  await resetDeviceState(device);

  console.log("Starting image upload with ACK verification...");
  await initializeDevice(device, 2);

  console.log("\n=== Uploading Image to slot 0 ===");
  const frames0 = await buildImageFrames("nyan.bmp", 0);
  await sendFrames(device, frames0);

  await delay(100);

  console.log("\n=== Uploading Image to slot 1 ===");
  const frames1 = await buildImageFrames("encoded-rgb555.bmp", 1);
  await sendFrames(device, frames1);

  // Final commit (device may not ACK this; that’s OK)
  const ok = await trySend(device, 0x02);
  if (!ok) console.warn("Final COMMIT may not have been acknowledged");

  console.log("\n✓ Upload complete!");

  // IMPORTANT: use the safe teardown to avoid segfault + unlock keyboard
  await releaseAndReattach(device);
}

main().catch((e) => console.error(e));
