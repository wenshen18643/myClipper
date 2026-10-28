# Local mode

Local mode transcribes on your computer with [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (Whisper Large V3 Turbo) and sends planning and layout-vision requests to the Claude API with your own key. Nothing goes to OpenRouter, so Jev review, source web research and boundary repairs are off. Review & edit still opens candidates in the editor, without Jev scores.

## Set up

1. Install the add-ons into the engine environment:

   ```powershell
   uv pip install --python engine/.venv/Scripts/python.exe -r engine/requirements-local.txt
   ```

2. Run the app (`npm run dev`), open **Settings → API keys** and paste a Claude API key from the [Claude Console](https://platform.claude.com/settings/keys).
3. On **Create → Clips**, choose **Local**.

The first job downloads the Whisper model (about 1.6 GB) to the Hugging Face cache. With an NVIDIA GPU it runs on CUDA; otherwise it falls back to the CPU, which is several times slower.

## Models and cost

| Step | Model | Cost |
| --- | --- | --- |
| Transcription | Whisper Large V3 Turbo, local | Free |
| Clip planning | `claude-opus-5-5`, medium effort | Billed to your Claude API key |
| Layout vision (optional) | `claude-opus-5-5`, low effort | Billed per checked shot |

Override the Claude models with the `LOCAL_PLANNER_MODEL` and `LOCAL_VISION_MODEL` environment variables (OpenRouter-style IDs such as `anthropic/claude-sonnet-5.5`). `LOCAL_WHISPER_MODEL` and `LOCAL_WHISPER_DEVICE` (`auto`, `cuda`, `cpu`) select the Whisper model and device.
