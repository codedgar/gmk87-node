#!/usr/bin/env node
/**
 * @fileoverview Preset loader for GMK87 keyboard configurations
 * Allows quick loading of predefined lighting configurations
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { configureLighting } from "./lib/device.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Loads presets from JSON file
 * @param {string} [presetsPath] - Path to presets file
 * @returns {Object} Presets object
 */
function loadPresets(presetsPath) {
  const defaultPath = path.join(__dirname, "../presets.json");
  const filePath = presetsPath || defaultPath;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Presets file not found: ${filePath}`);
  }

  const data = fs.readFileSync(filePath, "utf8");
  return JSON.parse(data);
}

/**
 * Lists available presets
 * @param {Object} presets - Presets object
 */
function listPresets(presets) {
  console.log("\n📋 Available Presets:\n");
  const entries = Object.entries(presets.presets);

  entries.forEach(([name, preset]) => {
    console.log(`  🎨 ${name}`);
    console.log(`     ${preset.description}\n`);
  });

  console.log(`Total: ${entries.length} presets\n`);
}

/**
 * Applies a preset configuration
 * @param {string} presetName - Name of preset to apply
 * @param {string} [presetsPath] - Optional custom presets file path
 * @returns {Promise<void>}
 */
async function applyPreset(presetName, presetsPath) {
  const presets = loadPresets(presetsPath);
  const preset = presets.presets[presetName];

  if (!preset) {
    throw new Error(
      `Preset "${presetName}" not found. Use --list to see available presets.`
    );
  }

  console.log(`\n🎨 Applying preset: ${presetName}`);
  console.log(`   ${preset.description}\n`);

  await configureLighting(preset.config);
}

/**
 * Parses command-line arguments
 * @param {string[]} argv - Process arguments
 * @returns {Object} Parsed arguments
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args.preset = arg;
      continue;
    }

    const eqIndex = arg.indexOf("=");
    let key, value;

    if (eqIndex !== -1) {
      key = arg.slice(2, eqIndex);
      value = arg.slice(eqIndex + 1);
    } else {
      key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }

    args[key] = value;
  }
  return args;
}

/**
 * Main CLI entry point
 */
async function main() {
  const args = parseArgs(process.argv);

  if (args.help || args.h) {
    console.log(`
GMK87 Preset Loader

Usage: node loadPreset.js [preset-name] [options]
   or: npm run preset [preset-name]

Options:
  --list, -l              List all available presets
  --file <path>           Use custom presets file
  --help, -h              Show this help message

Examples:
  node loadPreset.js gaming
  node loadPreset.js --list
  node loadPreset.js party --file ./my-presets.json
  npm run preset gaming
    `);
    return;
  }

  try {
    if (args.list || args.l) {
      const presets = loadPresets(args.file);
      listPresets(presets);
      return;
    }

    if (!args.preset) {
      console.error("❌ Error: Preset name required");
      console.log("Usage: node loadPreset.js [preset-name]");
      console.log("       Use --list to see available presets");
      process.exit(1);
    }

    await applyPreset(args.preset, args.file);
    console.log("✅ Preset applied successfully!\n");
  } catch (error) {
    console.error(`❌ Error: ${error.message}\n`);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { loadPresets, applyPreset, listPresets };