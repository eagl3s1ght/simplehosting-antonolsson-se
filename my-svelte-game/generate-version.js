#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read version from package.json
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')
);

const version = packageJson.version || '0.0.1';
const buildTime = new Date().toISOString();

// Create version.json
const versionData = {
  version,
  buildTime
};

// Write to static folder (for SvelteKit static adapter)
const staticPath = path.join(__dirname, 'static', 'version.json');
fs.writeFileSync(staticPath, JSON.stringify(versionData, null, 2));

console.log(`✓ Generated version.json: v${version} (${buildTime})`);
