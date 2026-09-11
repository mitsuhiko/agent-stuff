#!/bin/bash
# Locate Ghidra installation and analyzeHeadless script
# Searches common installation paths and outputs the path to analyzeHeadless

set -e

# Common locations to search for Ghidra
SEARCH_PATHS=(
    # Homebrew on Apple Silicon
    "/opt/homebrew/Caskroom/ghidra"
    # Homebrew on Intel
    "/usr/local/Caskroom/ghidra"
    # Manual installation locations
    "/opt/ghidra"
    "/usr/local/ghidra"
    "$HOME/ghidra"
    "$HOME/Applications/ghidra"
    "/Applications/ghidra"
    # Linux common paths
    "/usr/share/ghidra"
    "/usr/local/share/ghidra"
    "/snap/bin"
)

# Check GHIDRA_HOME environment variable first
if [[ -n "$GHIDRA_HOME" ]]; then
    HEADLESS="$GHIDRA_HOME/support/analyzeHeadless"
    if [[ -x "$HEADLESS" ]]; then
        echo "$HEADLESS"
        exit 0
    fi
fi

# Check with command
if command -v ghidra.analyzeHeadless >/dev/null 2>&1; then
    command -v ghidra.analyzeHeadless
    exit 0
fi

# Search through common paths
for base_path in "${SEARCH_PATHS[@]}"; do
    if [[ -d "$base_path" ]]; then
        # Find analyzeHeadless in the directory tree (handles versioned paths)
        HEADLESS=$(find "$base_path" \( -name "analyzeHeadless" -o -name "ghidra.analyzeHeadless" \) -executable 2>/dev/null | head -n 1)
        if [[ -n "$HEADLESS" && -x "$HEADLESS" ]]; then
            echo "$HEADLESS"
            exit 0
        fi
    fi
done

# Try to find it anywhere on the system as a last resort
HEADLESS=$(find /opt /usr/local /Applications "$HOME" \( -name "analyzeHeadless" -o -name "ghidra.analyzeHeadless" \) -xtype f 2>/dev/null | head -n 1)
if [[ -n "$HEADLESS" && -x "$HEADLESS" ]]; then
    echo "$HEADLESS"
    exit 0
fi

echo "ERROR: Could not find Ghidra's analyzeHeadless script." >&2
echo "Please set GHIDRA_HOME environment variable or install Ghidra." >&2
exit 1
