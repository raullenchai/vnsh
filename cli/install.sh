#!/bin/bash
#
# vnsh CLI Installer
#
# Usage:
#   curl -sL https://vnsh.dev/i | sh
#

set -e

# Configuration
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
VNSH_HOST="${VNSH_HOST:-https://vnsh.dev}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}Installing vnsh CLI...${NC}"

# Check for required tools
if ! command -v openssl &> /dev/null; then
  echo -e "${RED}Error: openssl is required but not installed${NC}"
  exit 1
fi

if ! command -v curl &> /dev/null; then
  echo -e "${RED}Error: curl is required but not installed${NC}"
  exit 1
fi

# Create install directory if needed
if [ ! -d "$INSTALL_DIR" ]; then
  echo "Creating $INSTALL_DIR..."
  sudo mkdir -p "$INSTALL_DIR"
fi

# Check write permissions
if [ ! -w "$INSTALL_DIR" ]; then
  echo "Requires sudo to install to $INSTALL_DIR"
  SUDO="sudo"
else
  SUDO=""
fi

# Download and install
SCRIPT_URL="${VNSH_HOST}/cli/vn"
INSTALL_PATH="${INSTALL_DIR}/vn"

echo "Downloading vn..."

# For local development, copy the script directly
if [ -f "./vn" ]; then
  echo "Using local vn script..."
  $SUDO cp ./vn "$INSTALL_PATH"
else
  # Download from server
  $SUDO curl -sL "$SCRIPT_URL" -o "$INSTALL_PATH"
fi

$SUDO chmod +x "$INSTALL_PATH"

# Verify installation
if command -v vn &> /dev/null; then
  echo ""
  echo -e "${GREEN}✓ vnsh CLI installed successfully${NC}"
  echo ""
  echo "Usage:"
  echo "  vn <file>           Encrypt and upload a file"
  echo "  echo 'text' | vn    Encrypt and upload from stdin"
  echo "  vn --help           Show help"
  echo ""
else
  echo ""
  echo -e "${GREEN}✓ Installed to ${INSTALL_PATH}${NC}"
  echo ""
  echo "Make sure $INSTALL_DIR is in your PATH, then run:"
  echo "  vn --help"
  echo ""
fi
