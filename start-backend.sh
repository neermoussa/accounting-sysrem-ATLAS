#!/bin/sh
cd "$(dirname "$0")/backend" && PUPPETEER_SKIP_DOWNLOAD=1 npm install && node server.js
