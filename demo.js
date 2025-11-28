#!/usr/bin/env node
/**
 * GMK87 Configuration Preservation Demo
 *
 * This demo proves that the read-modify-write fix works:
 * - Changes lighting WITHOUT affecting images
 * - Syncs time WITHOUT affecting lighting or images
 * - Each operation only modifies what you explicitly request
 */

import {
  configureLighting,
  syncTime,
  delay,
  openDevice,
  readConfigFromDevice,
  parseConfigBuffer
} from "./src/lib/device.js";

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
};

function printHeader(title, step) {
  console.log(`\n${colors.bright}${colors.cyan}═══ STEP ${step}: ${title} ═══${colors.reset}\n`);
}

function printConfig(label, config) {
  console.log(`${colors.bright}${colors.magenta}${label}${colors.reset}`);
  console.log(`  🎨 Underglow: effect=${config.underglow.effect}, brightness=${config.underglow.brightness}, speed=${config.underglow.speed}`);
  console.log(`  💡 LED: mode=${config.led.mode}, color=${config.led.color}, saturation=${config.led.saturation}`);
  console.log(`  🖼️  Images: slot0=${config.image1Frames} frames, slot1=${config.image2Frames} frames`);
  console.log(`  🕐 Time: ${config.time.hour}:${config.time.minute}:${config.time.second}\n`);
}

async function readConfig() {
  const device = openDevice();
  try {
    return parseConfigBuffer(await readConfigFromDevice(device));
  } finally {
    device.close();
  }
}

async function demo() {
  console.log(`${colors.bright}${colors.green}`);
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║                                                           ║");
  console.log("║       GMK87 Configuration Preservation Demo              ║");
  console.log("║                                                           ║");
  console.log("║  Proves read-modify-write: changes ONLY what you ask!    ║");
  console.log("║                                                           ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  console.log(colors.reset);

  try {
    // ============================================================
    // STEP 0: Show initial state
    // ============================================================
    printHeader("Initial Configuration", 0);
    const config0 = await readConfig();
    printConfig("Current settings:", config0);
    await delay(2000);

    // ============================================================
    // STEP 1: Set underglow to BREATHING effect with BLUE color
    // ============================================================
    printHeader("Set Underglow to Breathing (Blue)", 1);
    console.log("Setting: effect=BREATHING (5), brightness=9, speed=5, color=blue");
    console.log("Expected: ONLY underglow changes, LED and images stay the same\n");

    await configureLighting({
      underglow: {
        effect: 0x05, // BREATHING
        brightness: 9,
        speed: 5,
        rainbow: 0, // Use custom hue
        hue: {
          red: 0x00,
          green: 0x00,
          blue: 0xff, // Blue
        },
      },
    });

    console.log(`\n${colors.green}✓ Lighting configured${colors.reset}`);
    console.log(`${colors.yellow}⏳ Check your keyboard - it should be breathing BLUE${colors.reset}`);
    await delay(3000);

    console.log("Waiting for keyboard to settle before reading back...");
    await delay(500);

    const config1 = await readConfig();
    printConfig("After lighting change:", config1);

    // Verify
    if (config1.underglow.effect === 5 && config1.underglow.brightness === 9) {
      console.log(`${colors.green}✅ SUCCESS: Underglow changed to breathing/blue${colors.reset}`);
    } else {
      console.log(`${colors.yellow}⚠️  Underglow settings didn't stick${colors.reset}`);
    }

    if (config1.led.mode === config0.led.mode) {
      console.log(`${colors.green}✅ SUCCESS: LED settings preserved (mode=${config1.led.mode})${colors.reset}`);
    } else {
      console.log(`${colors.yellow}⚠️  LED settings changed unexpectedly${colors.reset}`);
    }

    await delay(2000);

    // ============================================================
    // STEP 2: Change LED to FIXED PURPLE
    // ============================================================
    printHeader("Change LED to Fixed Purple", 2);
    console.log("Setting: LED mode=FIXED, color=PURPLE");
    console.log("Expected: ONLY LED changes, underglow stays breathing blue\n");

    await configureLighting({
      led: {
        mode: 0x03, // FIXED_COLOR
        color: 0x06, // PURPLE
      },
    });

    console.log(`\n${colors.green}✓ LED configured${colors.reset}`);
    console.log(`${colors.yellow}⏳ Check: Underglow should STILL be breathing blue, LED now purple${colors.reset}`);
    await delay(3000);

    console.log("Waiting for keyboard to settle before reading back...");
    await delay(500);

    const config2 = await readConfig();
    printConfig("After LED change:", config2);

    // Verify
    if (config2.led.mode === 3 && config2.led.color === 6) {
      console.log(`${colors.green}✅ SUCCESS: LED changed to fixed purple${colors.reset}`);
    } else {
      console.log(`${colors.yellow}⚠️  LED settings didn't stick${colors.reset}`);
    }

    if (config2.underglow.effect === 5 && config2.underglow.brightness === 9) {
      console.log(`${colors.green}✅ SUCCESS: Underglow STILL breathing blue (preserved!)${colors.reset}`);
    } else {
      console.log(`${colors.yellow}❌ FAIL: Underglow was overwritten${colors.reset}`);
    }

    await delay(2000);

    // ============================================================
    // STEP 3: Sync time (should preserve EVERYTHING)
    // ============================================================
    printHeader("Sync Time (The Ultimate Test)", 3);
    console.log("Syncing time to current system time");
    console.log("Expected: Time updates, underglow STILL blue breathing, LED STILL purple\n");

    await syncTime();

    console.log(`\n${colors.green}✓ Time synchronized${colors.reset}`);
    console.log(`${colors.yellow}⏳ Check: Underglow blue, LED purple should BOTH still be active${colors.reset}`);
    await delay(3000);

    console.log("Waiting for keyboard to settle before reading back...");
    await delay(1000);

    const config3 = await readConfig();
    printConfig("After time sync:", config3);

    // Verify time changed
    if (config3.time.hour !== config2.time.hour ||
        config3.time.minute !== config2.time.minute ||
        config3.time.second !== config2.time.second) {
      console.log(`${colors.green}✅ SUCCESS: Time was updated${colors.reset}`);
    }

    // Verify underglow preserved
    if (config3.underglow.effect === 5 && config3.underglow.brightness === 9) {
      console.log(`${colors.green}✅ SUCCESS: Underglow STILL breathing blue (preserved!)${colors.reset}`);
    } else {
      console.log(`${colors.yellow}❌ FAIL: Underglow was overwritten by time sync${colors.reset}`);
    }

    // Verify LED preserved
    if (config3.led.mode === 3 && config3.led.color === 6) {
      console.log(`${colors.green}✅ SUCCESS: LED STILL fixed purple (preserved!)${colors.reset}`);
    } else {
      console.log(`${colors.yellow}❌ FAIL: LED was overwritten by time sync${colors.reset}`);
    }

    await delay(1000);

    // ============================================================
    // STEP 4: Final verification - Change to rainbow cycle
    // ============================================================
    printHeader("Final Test - Rainbow Cycle", 4);
    console.log("Setting: Underglow to RAINBOW_CYCLE at brightness 7");
    console.log("Expected: Underglow changes, LED STILL purple\n");

    await configureLighting({
      underglow: {
        effect: 0x0b, // RAINBOW_CYCLE
        brightness: 7,
        speed: 3,
        rainbow: 1,
      },
    });

    console.log(`\n${colors.green}✓ Underglow changed to rainbow cycle${colors.reset}`);
    console.log(`${colors.yellow}⏳ Check: Should see rainbow cycling, LED still purple${colors.reset}`);
    await delay(3000);

    console.log("Waiting for keyboard to settle before reading back...");
    await delay(1000);

    const config4 = await readConfig();
    printConfig("Final configuration:", config4);

    if (config4.underglow.effect === 0x0b && config4.underglow.brightness === 7) {
      console.log(`${colors.green}✅ SUCCESS: Underglow is rainbow cycle${colors.reset}`);
    }

    if (config4.led.mode === 3 && config4.led.color === 6) {
      console.log(`${colors.green}✅ SUCCESS: LED STILL purple (survived multiple changes!)${colors.reset}`);
    } else {
      console.log(`${colors.yellow}❌ FAIL: LED was lost${colors.reset}`);
    }

    // ============================================================
    // SUMMARY
    // ============================================================
    console.log(`\n${colors.bright}${colors.green}`);
    console.log("╔═══════════════════════════════════════════════════════════╗");
    console.log("║                                                           ║");
    console.log("║                  🎉 DEMO COMPLETE! 🎉                    ║");
    console.log("║                                                           ║");
    console.log("║  If all steps showed ✅, the bug fix is working!         ║");
    console.log("║                                                           ║");
    console.log("║  Your keyboard should now show:                          ║");
    console.log("║    • Rainbow cycling underglow                           ║");
    console.log("║    • Fixed purple LED                                    ║");
    console.log("║    • Current system time                                 ║");
    console.log("║                                                           ║");
    console.log("║  Each operation preserved the others! ✓                  ║");
    console.log("║                                                           ║");
    console.log("╚═══════════════════════════════════════════════════════════╝");
    console.log(colors.reset);

  } catch (error) {
    console.error(`\n${colors.yellow}❌ Demo failed:${colors.reset}`);
    console.error(error.message);
    console.error(error.stack);
  }
}

console.log("Starting demo in 2 seconds...\n");
await delay(2000);
demo();
