#!/bin/bash
CONFIG_PATH="/usr/src/app/quartz.config.ts"
DEFAULT_CONFIG="/usr/src/app/quartz.config.ts.default"

# Copy default config if it doesn't exist yet (-s checks if file exists and is not empty)
if [ ! -s "$CONFIG_PATH" ]; then
    cp "$DEFAULT_CONFIG" "$CONFIG_PATH"
fi

# Start application
exec npx quartz build --serve
