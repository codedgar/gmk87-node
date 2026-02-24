#!/bin/bash
# Post-install: copy udev rule so the keyboard is accessible without root
RULES_SRC="/opt/GMK87 Configurator/50-gmk87.rules"
RULES_DST="/etc/udev/rules.d/50-gmk87.rules"

if [ -f "$RULES_SRC" ]; then
  cp "$RULES_SRC" "$RULES_DST"
  udevadm control --reload-rules 2>/dev/null || true
  udevadm trigger 2>/dev/null || true
fi
