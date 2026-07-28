#!/bin/zsh
set -e
cd "$(dirname "$0")"

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required. Get it at https://brew.sh"
  exit 1
fi

if [ ! -x /opt/homebrew/bin/whisper-server ]; then
  echo "Installing whisper-cpp..."
  brew install whisper-cpp
fi

MODEL_DIR="$HOME/Library/Application Support/Yap/models"
MODEL="$MODEL_DIR/ggml-large-v3-turbo-q5_0.bin"
if [ ! -f "$MODEL" ]; then
  mkdir -p "$MODEL_DIR"
  echo "Downloading model (574 MB, one time)..."
  curl -L --progress-bar -o "$MODEL" \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
fi

echo "Building..."
./build.sh
ditto build/Yap.app /Applications/Yap.app
open /Applications/Yap.app

echo ""
echo "Yap is running. Grant Microphone and Accessibility when macOS asks."
echo "Then hold right cmd and talk."
