<p align="center">
  <img src="assets/logo.svg" width="150" alt="Yap logo">
</p>

# Yap

Tap right ⌘, talk, tap again. Your words land wherever your cursor is, near instantly, because everything runs on your Mac.

I was using a paid dictation app and ran out of minutes. So I built this: the same thing with most features stripped away. It runs Whisper large-v3-turbo locally through [whisper.cpp](https://github.com/ggml-org/whisper.cpp). No account, no cloud, no minutes, free forever.

## Install

You need a Mac with Apple Silicon and [Homebrew](https://brew.sh).

```bash
git clone https://github.com/dertuman/yap
cd yap
./install.sh
```

The script installs whisper-cpp, downloads the model (574 MB, one time), builds the app, and drops it in /Applications. Easy peezy.

On first launch macOS asks for Microphone and Accessibility. Grant both. If the hotkey still does nothing, also enable Yap under Privacy & Security > Input Monitoring.

## Use

- Tap right ⌘ to start, yap, tap again to stop. The text is at your cursor before you can look for it.
- Or hold right ⌘ and speak, release to transcribe, walkie-talkie style.
- Press any other key while holding and it cancels, so real shortcuts still work.
- The menu bar mic turns red while recording.

The model stays loaded in memory, so transcription is basically instant and nothing ever leaves your Mac.

Want it on login? System Settings > General > Login Items, add Yap.

## How it works

Five small Swift files. A menu bar app watches the right ⌘ key with an event tap, records 16 kHz audio, sends it to a local whisper-server (kept running so the model stays loaded), then pastes the result at your cursor and restores your clipboard.

Want a different model? Grab any ggml model from [Hugging Face](https://huggingface.co/ggerganov/whisper.cpp/tree/main), put it in `~/Library/Application Support/Yap/models/`, and change the filename in `Sources/Transcriber.swift`.

## License

MIT
