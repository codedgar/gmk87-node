#!/usr/bin/env node
/**
 * Test to verify that image upload preserves lighting/LED settings
 *
 * Test procedure:
 * 1. Set specific lighting (e.g., breathing blue underglow, purple LED)
 * 2. Read config to verify settings
 * 3. Upload an image
 * 4. Read config again to verify lighting/LED were preserved
 */

import {
  openDevice,
  readConfigFromDevice,
  parseConfigBuffer,
  configureLighting,
  uploadImageToDevice,
  delay,
} from "./src/lib/device.js";

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

async function test() {
  console.log(`${colors.bright}${colors.cyan}`);
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║                                                           ║");
  console.log("║     Image Upload Preservation Test                       ║");
  console.log("║                                                           ║");
  console.log("║  Verifies image upload preserves lighting/LED settings   ║");
  console.log("║                                                           ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  console.log(colors.reset);
  console.log("");

  let device;
  try {
    // ============================================================
    // STEP 1: Set unique lighting configuration
    // ============================================================
    console.log(`${colors.bright}STEP 1: Setting unique lighting configuration${colors.reset}`);
    console.log("  Setting underglow to BREATHING (5), brightness 8, speed 4, BLUE color");
    console.log("  Setting LED to FIXED (3), color PURPLE (6)\n");

    device = openDevice();

    await configureLighting({
      underglow: {
        effect: 0x05, // BREATHING
        brightness: 8,
        speed: 4,
        rainbow: 0,
        hue: {
          red: 0x00,
          green: 0x00,
          blue: 0xff, // Blue
        },
      },
      led: {
        mode: 0x03, // FIXED
        color: 0x06, // PURPLE
      },
    }, device);

    console.log(`${colors.green}✓ Lighting configured${colors.reset}\n`);
    await delay(1000);

    // ============================================================
    // STEP 2: Verify lighting settings before upload
    // ============================================================
    console.log(`${colors.bright}STEP 2: Verifying lighting before image upload${colors.reset}`);
    const beforeConfig = parseConfigBuffer(await readConfigFromDevice(device));

    console.log(`  Underglow: effect=${beforeConfig.underglow.effect}, brightness=${beforeConfig.underglow.brightness}, speed=${beforeConfig.underglow.speed}`);
    console.log(`  LED: mode=${beforeConfig.led.mode}, color=${beforeConfig.led.color}`);
    console.log(`  Image slots: slot0=${beforeConfig.image1Frames}, slot1=${beforeConfig.image2Frames}\n`);

    if (beforeConfig.underglow.effect !== 5 || beforeConfig.underglow.brightness !== 8) {
      throw new Error("❌ Lighting configuration didn't stick before upload test");
    }

    // Keep device open for upload!
    // device.close();
    // await delay(500);

    // ============================================================
    // STEP 3: Upload test image
    // ============================================================
    console.log(`${colors.bright}STEP 3: Uploading test image to slot 0${colors.reset}`);
    console.log("  Using small test image...\n");
    console.log(`${colors.yellow}NOTE: Closing device temporarily for upload (image upload opens its own connection)${colors.reset}\n`);

    device.close();
    await delay(2000); // Give device time to recover

    // Use a small test image from node_modules
    const testImage = "./node_modules/pixelmatch/test/fixtures/1a.png";
    await uploadImageToDevice(testImage, 0, { showAfter: true });

    console.log(`${colors.green}✓ Image uploaded${colors.reset}\n`);
    await delay(1000);

    // ============================================================
    // STEP 4: Verify lighting settings AFTER upload
    // ============================================================
    console.log(`${colors.bright}STEP 4: Verifying lighting AFTER image upload${colors.reset}`);

    device = openDevice();
    const afterConfig = parseConfigBuffer(await readConfigFromDevice(device));

    console.log(`  Underglow: effect=${afterConfig.underglow.effect}, brightness=${afterConfig.underglow.brightness}, speed=${afterConfig.underglow.speed}`);
    console.log(`  LED: mode=${afterConfig.led.mode}, color=${afterConfig.led.color}`);
    console.log(`  Image slots: slot0=${afterConfig.image1Frames}, slot1=${afterConfig.image2Frames}\n`);

    // ============================================================
    // STEP 5: Verify preservation
    // ============================================================
    console.log(`${colors.bright}STEP 5: Checking preservation${colors.reset}\n`);

    let success = true;

    // Check underglow preserved
    if (afterConfig.underglow.effect === beforeConfig.underglow.effect &&
        afterConfig.underglow.brightness === beforeConfig.underglow.brightness &&
        afterConfig.underglow.speed === beforeConfig.underglow.speed) {
      console.log(`${colors.green}✅ PASS: Underglow settings preserved!${colors.reset}`);
    } else {
      console.log(`${colors.red}❌ FAIL: Underglow was overwritten${colors.reset}`);
      console.log(`   Expected: effect=${beforeConfig.underglow.effect}, brightness=${beforeConfig.underglow.brightness}, speed=${beforeConfig.underglow.speed}`);
      console.log(`   Got: effect=${afterConfig.underglow.effect}, brightness=${afterConfig.underglow.brightness}, speed=${afterConfig.underglow.speed}`);
      success = false;
    }

    // Check LED preserved
    if (afterConfig.led.mode === beforeConfig.led.mode &&
        afterConfig.led.color === beforeConfig.led.color) {
      console.log(`${colors.green}✅ PASS: LED settings preserved!${colors.reset}`);
    } else {
      console.log(`${colors.red}❌ FAIL: LED was overwritten${colors.reset}`);
      console.log(`   Expected: mode=${beforeConfig.led.mode}, color=${beforeConfig.led.color}`);
      console.log(`   Got: mode=${afterConfig.led.mode}, color=${afterConfig.led.color}`);
      success = false;
    }

    // Check image slot 0 was updated
    if (afterConfig.image1Frames > 0) {
      console.log(`${colors.green}✅ PASS: Image slot 0 updated (${afterConfig.image1Frames} frames)${colors.reset}`);
    } else {
      console.log(`${colors.yellow}⚠️  WARNING: Image slot 0 has 0 frames${colors.reset}`);
    }

    // Check image slot 1 was preserved (if it had frames before)
    if (beforeConfig.image2Frames === afterConfig.image2Frames) {
      console.log(`${colors.green}✅ PASS: Image slot 1 frame count preserved (${afterConfig.image2Frames} frames)${colors.reset}`);
    } else {
      console.log(`${colors.yellow}⚠️  WARNING: Image slot 1 frame count changed${colors.reset}`);
      console.log(`   Before: ${beforeConfig.image2Frames} frames`);
      console.log(`   After: ${afterConfig.image2Frames} frames`);
    }

    console.log("");
    if (success) {
      console.log(`${colors.bright}${colors.green}`);
      console.log("╔═══════════════════════════════════════════════════════════╗");
      console.log("║                                                           ║");
      console.log("║               ✅ TEST PASSED! ✅                         ║");
      console.log("║                                                           ║");
      console.log("║  Image upload preserved lighting and LED settings!       ║");
      console.log("║                                                           ║");
      console.log("╚═══════════════════════════════════════════════════════════╝");
      console.log(colors.reset);
    } else {
      console.log(`${colors.bright}${colors.red}`);
      console.log("╔═══════════════════════════════════════════════════════════╗");
      console.log("║                                                           ║");
      console.log("║               ❌ TEST FAILED ❌                          ║");
      console.log("║                                                           ║");
      console.log("║  Image upload overwrote settings!                        ║");
      console.log("║                                                           ║");
      console.log("╚═══════════════════════════════════════════════════════════╝");
      console.log(colors.reset);
      process.exit(1);
    }

  } catch (error) {
    console.error(`\n${colors.red}❌ Test failed with error:${colors.reset}`);
    console.error(error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    if (device) {
      try {
        device.close();
      } catch {}
    }
  }
}

console.log("Starting test in 2 seconds...\n");
await delay(2000);
test();
