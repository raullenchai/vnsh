#!/bin/bash
#
# Opaque CLI Installer
#
# Usage:
#   curl -sL https://opaque.dev/install | bash
#

set -e

# Configuration
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
OPAQUE_HOST="${OPAQUE_HOST:-https://opaque.dev}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}Installing Opaque CLI...${NC}"

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
SCRIPT_URL="${OPAQUE_HOST}/cli/oq"
INSTALL_PATH="${INSTALL_DIR}/oq"

echo "Downloading oq..."

# For local development, copy the script directly
if [ -f "./oq" ]; then
  echo "Using local oq script..."
  $SUDO cp ./oq "$INSTALL_PATH"
else
  # Download from server
  $SUDO curl -sL "$SCRIPT_URL" -o "$INSTALL_PATH"
fi

$SUDO chmod +x "$INSTALL_PATH"

# Verify installation
if command -v oq &> /dev/null; then
  echo ""
  echo -e "${GREEN}✓ Opaque CLI installed successfully${NC}"
  echo ""
  echo "Usage:"
  echo "  oq <file>           Encrypt and upload a file"
  echo "  echo 'text' | oq    Encrypt and upload from stdin"
  echo "  oq --help           Show help"
  echo ""
else
  echo ""
  echo -e "${GREEN}✓ Installed to ${INSTALL_PATH}${NC}"
  echo ""
  echo "Make sure $INSTALL_DIR is in your PATH, then run:"
  echo "  oq --help"
  echo ""
fi
