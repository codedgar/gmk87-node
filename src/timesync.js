/**
 * @fileoverview Time synchronization utility for GMK87 keyboard
 * Sends the current system time to the device's internal clock
 * and preserves current RGB configuration (via Feature Report 0x05)
 */

import { syncTime, readCurrentConfig } from "./lib/device.js";

async function main() {
  console.log("GMK87 Time Synchronization Utility");
  console.log("===================================");
  console.log();
  console.log("✨ This tool automatically reads your RGB settings");
  console.log("   and preserves them when syncing time!");
  console.log();

  const presetName = process.argv[2];
  const now = new Date();


  // auto mode
  console.log("Mode: Automatic RGB preservation");
  console.log("(Use 'node syncTime.js <preset>' to force a specific preset)\n");
  console.log(`Syncing time: ${now.toLocaleString()}`);
  console.log("Reading current RGB settings from keyboard...\n");

  try {
    // first read attempt
    let currentConfig = await readCurrentConfig();
    if (!currentConfig) {
      console.log("[TIME] Retrying RGB config read once...");
      await new Promise((r) => setTimeout(r, 300));
      currentConfig = await readCurrentConfig();
    }

    if (currentConfig) {
      console.log("✓ Current RGB settings read successfully!");
      console.table({
        effect: currentConfig.underglow.effect,
        brightness: currentConfig.underglow.brightness,
        speed: currentConfig.underglow.speed,
        r: currentConfig.underglow.hue.red,
        g: currentConfig.underglow.hue.green,
        b: currentConfig.underglow.hue.blue,
        hour: currentConfig.rtc.hour,
        min: currentConfig.rtc.min,
        sec: currentConfig.rtc.sec,
      });
    } else {
      console.warn("⚠ Could not read RGB config — will proceed without preserving.");
    }

    const success = await syncTime(now, {
      preserveRgb: true,
      rgbConfig: currentConfig || undefined,
    });

    if (success) {
      console.log("\n✓ Time synchronized successfully");
      if (currentConfig) console.log("✓ RGB settings were preserved");
      else console.log("⚠ RGB preservation skipped (read failed)");
    } else {
      console.error("\n✗ Time synchronization failed");
    }
  } catch (err) {
    handleError(err);
  }
}

function handleError(error) {
  console.error("\nError during time sync:");
  console.error(error.message);
  if (error.message.includes("Cannot preserve RGB")) {
    console.error("\nThe device didn't respond with RGB config.");
    console.error("You can:");
    console.error("  1. Try again (sometimes it needs a retry)");
    console.error("  2. Force a preset: node syncTime.js <preset>");
    console.error("  3. Accept reset: node syncTime.js (then confirm)");
  } else if (error.message.includes("GMK87 not found")) {
    console.error("\nTroubleshooting:");
    console.error("- Make sure the GMK87 keyboard is plugged in");
    console.error("- Check USB connection");
  } else if (error.message.includes("LIBUSB") || error.message.includes("permission")) {
    console.error("\nPermission issue detected:");
    console.error("- Try running with sudo: sudo node syncTime.js");
    console.error("- On Linux, you may need to set up udev rules");
  }
  process.exit(1);
}

// -------------------------------------------------------
// Entry Point
// -------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error("Unhandled error:", err);
    process.exit(1);
  });
}

// -------------------------------------------------------
// Exports
// -------------------------------------------------------
export { syncTime, RGB_PRESETS } from "./lib/device.js";
