#!/bin/sh
# Compiles the frontmost-app helper the widget spawns for its follow-Claude mode.
set -e
cd "$(dirname "$0")/.."
mkdir -p build
swiftc -O -o build/front helper/front.swift
echo "built build/front"
