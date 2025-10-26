/**
 * @fileoverview Usage examples for GMK87 lighting configuration
 * Demonstrates various ways to control the keyboard's RGB and LED features
 */

import {
  configureLighting,
  syncTime,
  uploadImageToDevice,
  getKeyboardInfo,
} from "./lib/device.js";
import {
  UNDERGLOW_EFFECTS,
  LED_MODES,
  LED_COLORS,
} from "./configureLights.js";

/**
 * Example 1: Basic underglow configuration
 * Sets a simple breathing effect with custom color
 */
async function example1_basicUnderglow() {
  console.log("\n=== Example 1: Basic Underglow ===");

  await configureLighting({
    underglow: {
      effect: UNDERGLOW_EFFECTS.BREATHING,
      brightness: 7,
      speed: 4,
      hue: {
        red: 255,
        green: 100,
        blue: 0, // Orange color
      },
    },
  });

  console.log("✅ Orange breathing effect applied");
}

/**
 * Example 2: Rainbow effect
 * Uses built-in rainbow mode with fast animation
 */
async function example2_rainbowEffect() {
  console.log("\n=== Example 2: Rainbow Effect ===");

  await configureLighting({
    underglow: {
      effect: UNDERGLOW_EFFECTS.RAINBOW_CYCLE,
      brightness: 9,
      speed: 2,
      rainbow: 1, // Enable rainbow mode
    },
  });

  console.log("✅ Rainbow cycle effect applied");
}

/**
 * Example 3: LED indicator configuration
 * Sets the big LED to fixed blue color
 */
async function example3_ledIndicator() {
  console.log("\n=== Example 3: LED Indicator ===");

  await configureLighting({
    led: {
      mode: LED_MODES.FIXED_COLOR,
      saturation: 7,
      color: LED_COLORS.BLUE,
    },
  });

  console.log("✅ Blue LED indicator set");
}

/**
 * Example 4: Complete configuration
 * Sets up everything at once
 */
async function example4_completeSetup() {
  console.log("\n=== Example 4: Complete Setup ===");

  await configureLighting({
    underglow: {
      effect: UNDERGLOW_EFFECTS.WAVE_FROM_CENTER,
      brightness: 6,
      speed: 4,
      orientation: 1,
      rainbow: 0,
      hue: {
        red: 128,
        green: 0,
        blue: 255, // Purple
      },
    },
    led: {
      mode: LED_MODES.FIXED_COLOR,
      saturation: 6,
      rainbow: 0,
      color: LED_COLORS.PURPLE,
    },
    winlock: 1, // Lock Windows key
    showImage: 0, // Show time
  });

  console.log("✅ Complete purple-themed setup applied");
}

/**
 * Example 5: Gaming profile
 * Aggressive red theme with fast effects
 */
async function example5_gamingProfile() {
  console.log("\n=== Example 5: Gaming Profile ===");

  await configureLighting({
    underglow: {
      effect: UNDERGLOW_EFFECTS.GLOW_PRESSED_KEY,
      brightness: 9,
      speed: 0, // Fastest
      hue: {
        red: 255,
        green: 0,
        blue: 0,
      },
    },
    led: {
      mode: LED_MODES.BLINKING_ONE_COLOR,
      saturation: 9,
      color: LED_COLORS.RED,
    },
    winlock: 1, // Important for gaming!
  });

  console.log("✅ Gaming profile applied (red theme, Windows key locked)");
}

/**
 * Example 6: Minimal/Productivity mode
 * Low distraction setup
 */
async function example6_productivityMode() {
  console.log("\n=== Example 6: Productivity Mode ===");

  await configureLighting({
    underglow: {
      effect: UNDERGLOW_EFFECTS.FULL_ONE_COLOR,
      brightness: 3,
      hue: {
        red: 255,
        green: 255,
        blue: 255, // White
      },
    },
    led: {
      mode: LED_MODES.FIXED_COLOR,
      saturation: 3,
      color: LED_COLORS.WHITE,
    },
    winlock: 0,
  });

  console.log("✅ Productivity mode applied (subtle white lighting)");
}

/**
 * Example 7: Turn everything off
 * Minimal power consumption
 */
async function example7_allOff() {
  console.log("\n=== Example 7: All Off ===");

  await configureLighting({
    underglow: {
      effect: UNDERGLOW_EFFECTS.OFF,
      brightness: 0,
    },
    led: {
      color: LED_COLORS.OFF,
      saturation: 0,
    },
  });

  console.log("✅ All lighting disabled");
}

/**
 * Example 8: Waterfall effect with custom colors
 */
async function example8_waterfallCustom() {
  console.log("\n=== Example 8: Custom Waterfall ===");

  await configureLighting({
    underglow: {
      effect: UNDERGLOW_EFFECTS.WATERFALL,
      brightness: 8,
      speed: 3,
      orientation: 0, // Left to right
      hue: {
        red: 0,
        green: 255,
        blue: 128, // Cyan-green
      },
    },
  });

  console.log("✅ Cyan-green waterfall effect applied");
}

/**
 * Example 9: Time sync with lighting
 * Syncs time and applies lighting in one go
 */
async function example9_timeSyncWithLighting() {
  console.log("\n=== Example 9: Time Sync + Lighting ===");

  // First sync time
  await syncTime();

  // Then apply lighting
  await configureLighting({
    underglow: {
      effect: UNDERGLOW_EFFECTS.SLOW_RAINBOW_FROM_CENTER,
      brightness: 5,
      speed: 5,
    },
    showImage: 0, // Ensure time is displayed
  });

  console.log("✅ Time synced and lighting configured");
}

/**
 * Example 10: Upload image and configure display
 * Uploads custom image and sets up lighting
 */
async function example10_imageWithLighting(imagePath) {
  console.log("\n=== Example 10: Image Upload + Lighting ===");

  if (!imagePath) {
    console.log("⚠️  Skipping - no image path provided");
    return;
  }

  // Upload image to slot 0
  await uploadImageToDevice(imagePath, 0, { showAfter: false });

  // Configure to show the image with matching lighting
  await configureLighting({
    underglow: {
      effect: UNDERGLOW_EFFECTS.FULL_CYCLING_COLORS,
      brightness: 6,
      speed: 5,
    },
    led: {
      mode: LED_MODES.PULSE_RAINBOW,
      saturation: 7,
      rainbow: 1,
    },
    showImage: 1, // Show image in slot 0
  });

  console.log("✅ Image uploaded and display configured");
}

/**
 * Example 11: Get keyboard info
 * Retrieves and displays keyboard information
 */
async function example11_getInfo() {
  console.log("\n=== Example 11: Keyboard Info ===");

  const info = await getKeyboardInfo();
  console.log("Keyboard Information:");
  console.log(`  Manufacturer: ${info.manufacturer}`);
  console.log(`  Product: ${info.product}`);
  console.log(`  Vendor ID: 0x${info.vendorId.toString(16).toUpperCase()}`);
  console.log(`  Product ID: 0x${info.productId.toString(16).toUpperCase()}`);
}

/**
 * Example 12: Animated sequence
 * Cycles through different effects
 */
async function example12_animatedSequence() {
  console.log("\n=== Example 12: Animated Sequence ===");
  console.log("Cycling through effects every 3 seconds...\n");

  const effects = [
    { name: "Breathing", effect: UNDERGLOW_EFFECTS.BREATHING },
    { name: "Waterfall", effect: UNDERGLOW_EFFECTS.WATERFALL },
    { name: "Wave", effect: UNDERGLOW_EFFECTS.WAVE_FROM_CENTER },
    { name: "Raining", effect: UNDERGLOW_EFFECTS.RAINING },
    { name: "Rainbow Cycle", effect: UNDERGLOW_EFFECTS.RAINBOW_CYCLE },
  ];

  for (const { name, effect } of effects) {
    console.log(`Applying: ${name}`);
    await configureLighting({
      underglow: {
        effect,
        brightness: 7,
        speed: 3,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  console.log("✅ Sequence complete");
}

/**
 * Main function to run all examples
 */
async function main() {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║  GMK87 Lighting Configuration Examples ║");
  console.log("╚════════════════════════════════════════╝");

  try {
    // Run examples
    await example11_getInfo();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await example1_basicUnderglow();
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await example2_rainbowEffect();
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await example3_ledIndicator();
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await example4_completeSetup();
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await example5_gamingProfile();
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await example6_productivityMode();
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await example8_waterfallCustom();
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Uncomment to run animated sequence (takes 15 seconds)
    // await example12_animatedSequence();

    // Clean up - return to a nice default
    await example4_completeSetup();

    console.log("\n✅ All examples completed successfully!\n");
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

// Export for use in other scripts
export {
  example1_basicUnderglow,
  example2_rainbowEffect,
  example3_ledIndicator,
  example4_completeSetup,
  example5_gamingProfile,
  example6_productivityMode,
  example7_allOff,
  example8_waterfallCustom,
  example9_timeSyncWithLighting,
  example10_imageWithLighting,
  example11_getInfo,
  example12_animatedSequence,
};