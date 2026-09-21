#!/bin/zsh
# Runs through the framework's Python.app binary so macOS shows the Bluetooth
# permission prompt instead of killing a bare python process (TCC crash).
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PYTHONPATH="$ROOT:$ROOT/whoop-reader/.venv/lib/python3.12/site-packages"
exec "/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python" -m whoopble.cli "$@"
