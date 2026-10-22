#!/usr/bin/env node
// Turns on EnableCookieEncryption in the local development Electron binary
// (node_modules), so cookies are encrypted at rest during local runs.
// Run before any real-cookie work. Reinstalling Electron resets it.
// Usage: node scripts/enable-dev-fuses.mjs [--check]
import { FuseState, FuseV1Options, flipFuses, getCurrentFuseWire } from '@electron/fuses';
import { createRequire } from 'node:module';
import { DEV_FUSES } from './fuse-config.mjs';

const electronPath = createRequire(import.meta.url)('electron');
const state = async () => (await getCurrentFuseWire(electronPath))[FuseV1Options.EnableCookieEncryption] === FuseState.ENABLE;

if (!process.argv.includes('--check')) await flipFuses(electronPath, DEV_FUSES);
console.log(`EnableCookieEncryption: ${(await state()) ? 'ON' : 'OFF'} (${electronPath})`);
