#!/usr/bin/env node
/**
 * Test script to verify read/write functionality using Python protocol
 */

import {
  openDevice,
  readConfigFromDevice,
  parseConfigBuffer,
  buildConfigBuffer,
  writeConfigToDevice
} from "./src/lib/device.js";

async function test() {
  console.log("==== GMK87 Read/Write Protocol Test ====\n");

  let device;
  try {
    // Step 1: Open device
    console.log("1. Opening device...");
    device = openDevice();
    console.log("✓ Device opened\n");

    // Step 2: Read current config
    console.log("2. Reading current configuration...");
    const configBuffer = await readConfigFromDevice(device);
    const config = parseConfigBuffer(configBuffer);

    console.log("\nCurrent Configuration:");
    console.log("  Underglow:");
    console.log(`    Effect: ${config.underglow.effect}`);
    console.log(`    Brightness: ${config.underglow.brightness}`);
    console.log(`    Speed: ${config.underglow.speed}`);
    console.log(`    Rainbow: ${config.underglow.rainbow}`);
    console.log("  LED:");
    console.log(`    Mode: ${config.led.mode}`);
    console.log(`    Color: ${config.led.color}`);
    console.log("  Images:");
    console.log(`    Show: ${config.showImage}`);
    console.log(`    Slot 0 frames: ${config.image1Frames}`);
    console.log(`    Slot 1 frames: ${config.image2Frames}`);
    console.log("");

    // Step 3: Modify only underglow effect
    console.log("3. Changing underglow to rainbow cycle (effect 0x0b)...");
    const changes = {
      underglow: {
        effect: 0x0b, // Rainbow cycle
        brightness: 7,
      }
    };

    const newConfig = buildConfigBuffer(config, changes);
    console.log("✓ Built new config (preserving other settings)\n");

    // Step 4: Write back
    console.log("4. Writing new configuration...");
    await writeConfigToDevice(device, newConfig);
    console.log("✓ Configuration written\n");

    // Step 5: Read back to verify
    console.log("5. Reading back to verify...");
    const verifyBuffer = await readConfigFromDevice(device);
    const verifyConfig = parseConfigBuffer(verifyBuffer);

    console.log("\nVerification:");
    console.log(`  Underglow effect: ${verifyConfig.underglow.effect} (expected: 11)`);
    console.log(`  Underglow brightness: ${verifyConfig.underglow.brightness} (expected: 7)`);
    console.log(`  Image slots preserved: slot0=${verifyConfig.image1Frames}, slot1=${verifyConfig.image2Frames}`);
    console.log(`  LED settings preserved: mode=${verifyConfig.led.mode}`);

    if (verifyConfig.underglow.effect === 0x0b && verifyConfig.underglow.brightness === 7) {
      console.log("\n✅ SUCCESS! Read/write working correctly!");
      console.log("Check your keyboard - it should show rainbow cycling lights");
    } else {
      console.log("\n⚠️  Configuration didn't stick - values don't match");
    }

  } catch (error) {
    console.error("\n❌ Test failed:");
    console.error(error.message);
    console.error(error.stack);
  } finally {
    if (device) {
      try {
        device.close();
        console.log("\nDevice closed");
      } catch {}
    }
  }
}

test();
