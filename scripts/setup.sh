#!/bin/bash
"""
Setup and verification script for Qdrant with OpenAI embeddings

This script helps set up and verify the Qdrant MCP configuration
for the KinDash project.
"""

echo "🚀 Qdrant OpenAI Setup for KinDash"
echo "========================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check Python
echo -e "\n1️⃣  Checking Python installation..."
if command -v python3 &> /dev/null; then
    echo -e "${GREEN}✓ Python3 found: $(python3 --version)${NC}"
else
    echo -e "${RED}✗ Python3 not found. Please install Python 3.8+${NC}"
    exit 1
fi

# Check required Python packages
echo -e "\n2️⃣  Checking Python packages..."
packages=("openai" "qdrant-client")
missing_packages=()

for package in "${packages[@]}"; do
    if python3 -c "import $package" 2>/dev/null; then
        echo -e "${GREEN}✓ $package is installed${NC}"
    else
        echo -e "${RED}✗ $package is not installed${NC}"
        missing_packages+=($package)
    fi
done

if [ ${#missing_packages[@]} -gt 0 ]; then
    echo -e "\n${YELLOW}Installing missing packages...${NC}"
    pip install "${missing_packages[@]}"
fi

# Check OpenAI API key
echo -e "\n3️⃣  Checking OpenAI API key..."
if [ -z "$OPENAI_API_KEY" ]; then
    echo -e "${RED}✗ OPENAI_API_KEY not set${NC}"
    echo -e "${YELLOW}Please set it with: export OPENAI_API_KEY='your-key-here'${NC}"
    echo -e "${YELLOW}Add it to your ~/.bashrc or ~/.zshrc to persist${NC}"
else
    echo -e "${GREEN}✓ OPENAI_API_KEY is set${NC}"
fi

# Check Qdrant
echo -e "\n4️⃣  Checking Qdrant server..."
QDRANT_URL=${QDRANT_URL:-"http://localhost:6333"}
if curl -s "$QDRANT_URL/collections" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Qdrant is running at $QDRANT_URL${NC}"
    
    # Check collection
    COLLECTION_NAME=${COLLECTION_NAME:-"familymanager-codebase-openai"}
    if curl -s "$QDRANT_URL/collections/$COLLECTION_NAME" | grep -q "result"; then
        echo -e "${GREEN}✓ Collection '$COLLECTION_NAME' exists${NC}"
        
        # Get collection info
        points_count=$(curl -s "$QDRANT_URL/collections/$COLLECTION_NAME" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data['result']['points_count'])" 2>/dev/null || echo "0")
        echo -e "  Points in collection: $points_count"
    else
        echo -e "${YELLOW}⚠ Collection '$COLLECTION_NAME' does not exist (will be created on first index)${NC}"
    fi
else
    echo -e "${RED}✗ Qdrant is not running at $QDRANT_URL${NC}"
    echo -e "${YELLOW}Start Qdrant with: docker run -p 6333:6333 qdrant/qdrant${NC}"
fi

# Check MCP configuration
echo -e "\n5️⃣  Checking MCP configuration..."
if [ -f "$HOME/.claude.json" ]; then
    if grep -q "mcp-qdrant-openai-wrapper.py" "$HOME/.claude.json"; then
        echo -e "${GREEN}✓ MCP configuration found in ~/.claude.json${NC}"
    else
        echo -e "${YELLOW}⚠ MCP configuration not found in ~/.claude.json${NC}"
        echo -e "${YELLOW}The qdrant server should be configured to use:${NC}"
        echo -e "  Command: python3"
        echo -e "  Args: [\"/home/tony/GitHub/KinDash-Main/scripts/mcp-qdrant-openai-wrapper.py\"]"
    fi
else
    echo -e "${RED}✗ ~/.claude.json not found${NC}"
fi

# Check if scripts exist
echo -e "\n6️⃣  Checking scripts..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/mcp-qdrant-openai-wrapper.py" ]; then
    echo -e "${GREEN}✓ MCP wrapper script exists${NC}"
else
    echo -e "${RED}✗ MCP wrapper script not found${NC}"
fi

if [ -f "$SCRIPT_DIR/qdrant-openai-indexer.py" ]; then
    echo -e "${GREEN}✓ Indexer script exists${NC}"
else
    echo -e "${RED}✗ Indexer script not found${NC}"
fi

# Summary
echo -e "\n📋 Summary"
echo "=========="

if [ -n "$OPENAI_API_KEY" ] && curl -s "$QDRANT_URL/collections" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ System is ready!${NC}"
    echo -e "\nTo index your codebase:"
    echo -e "  ${YELLOW}python3 $SCRIPT_DIR/qdrant-openai-indexer.py .${NC}"
    echo -e "\nTo use in Claude Code:"
    echo -e "  1. Restart Claude Code to load the MCP server"
    echo -e "  2. Use the 'search' tool to find code semantically"
else
    echo -e "${RED}❌ System is not ready. Please fix the issues above.${NC}"
fi

echo -e "\n🔗 Resources:"
echo "  - OpenAI API Keys: https://platform.openai.com/api-keys"
echo "  - Qdrant Docker: docker run -p 6333:6333 qdrant/qdrant"
echo "  - Documentation: docs/qdrant-openai-setup.md"