import { openDevice, readConfigFromDevice, parseConfigBuffer, delay } from "./src/lib/device.js";

async function test() {
  const device = openDevice();
  await delay(1000);

  console.log("Reading current configuration...");
  const configBuffer = await readConfigFromDevice(device);
  const config = parseConfigBuffer(configBuffer);

  console.log("\n=== Current Device Configuration ===");
  console.log(`showImage: ${config.showImage} (0=slot0, 1=slot1, other=clock?)`);
  console.log(`image1Frames (slot 0): ${config.image1Frames}`);
  console.log(`image2Frames (slot 1): ${config.image2Frames}`);
  console.log(`frameDuration: ${config.frameDuration}ms`);
  console.log(`\nRaw config buffer (48 bytes):`);
  console.log(configBuffer.toString('hex'));

  const byte33 = configBuffer[33];
  const byte34 = configBuffer[34];
  const byte46 = configBuffer[46];

  console.log(`\nByte 33 (showImage): 0x${byte33.toString(16).padStart(2, '0')} = ${byte33}`);
  console.log(`Byte 34 (image1Frames): 0x${byte34.toString(16).padStart(2, '0')} = ${byte34}`);
  console.log(`Byte 46 (image2Frames): 0x${byte46.toString(16).padStart(2, '0')} = ${byte46}`);

  device.close();
}

test().catch(console.error);
