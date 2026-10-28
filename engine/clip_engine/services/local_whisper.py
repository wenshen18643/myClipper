"""
Local speech recognition with faster-whisper.

Returns the same verbose_json shape as OpenRouter's transcription endpoint
(text, language, word-timed `words`, usage) so the transcription service can
chunk, parse and validate local results exactly like provider results.
"""

import glob
import logging
import os
import sys
import threading
import wave
from typing import Optional

logger = logging.getLogger(__name__)

_model = None
_model_key: Optional[tuple[str, str]] = None
_model_lock = threading.Lock()
_dll_dirs_added = False

class LocalWhisperUnavailable(Exception):
    """faster-whisper is not installed or the model could not be loaded."""

def _add_cuda_dll_dirs() -> None:
    """Expose pip-installed CUDA runtime DLLs (nvidia-cublas/cudnn) on Windows."""
    global _dll_dirs_added
    if _dll_dirs_added or sys.platform != "win32":
        return
    _dll_dirs_added = True
    for root in sys.path:
        for directory in glob.glob(os.path.join(root, "nvidia", "*", "bin")):
            try:
                os.add_dll_directory(directory)
                os.environ["PATH"] = directory + os.pathsep + os.environ.get("PATH", "")
            except OSError:
                pass

def _load(model_name: str, device: str):
    global _model, _model_key
    with _model_lock:
        if _model is not None and _model_key == (model_name, device):
            return _model
        _add_cuda_dll_dirs()
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise LocalWhisperUnavailable(
                "faster-whisper is not installed in the engine environment"
            ) from exc
        attempts = [("cuda", "float16"), ("cpu", "int8")] if device == "auto" else [
            (device, "float16" if device == "cuda" else "int8")
        ]
        last_error: Optional[Exception] = None
        for target, compute_type in attempts:
            try:
                model = WhisperModel(model_name, device=target, compute_type=compute_type)
                logger.info("Loaded local Whisper model %s on %s (%s)", model_name, target, compute_type)
                _model, _model_key = model, (model_name, device)
                return model
            except Exception as exc:
                logger.warning("Local Whisper could not load on %s: %s", target, type(exc).__name__)
                last_error = exc
        raise LocalWhisperUnavailable("Local Whisper model could not be loaded") from last_error

def _read_pcm_wav(path: str):
    """The engine's 16 kHz mono PCM WAV as float32 samples (no PyAV decoding)."""
    import numpy as np

    with wave.open(path, "rb") as audio:
        if audio.getsampwidth() != 2 or audio.getnchannels() != 1 or audio.getframerate() != 16000:
            raise ValueError("Expected 16 kHz mono 16-bit PCM audio")
        frames = audio.readframes(audio.getnframes())
    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0

MAX_REPEATED_WORDS = 6

def _key(word: str) -> str:
    return word.strip(",.!?;:").lower()

def clean_words(words: list[dict]) -> list[dict]:
    """Drop Whisper's decoding artifacts from word-timed output.

    - zero-length words at the very end (text Whisper generated past the
      audio, often a repeat of an earlier line), and
    - runs of one word repeated more than MAX_REPEATED_WORDS times, cut to
      their first two.
    """
    words = list(words)
    while words and words[-1]["end"] - words[-1]["start"] < 0.02:
        words.pop()
    cleaned: list[dict] = []
    i = 0
    while i < len(words):
        j = i
        while j < len(words) and _key(words[j]["word"]) == _key(words[i]["word"]):
            j += 1
        cleaned += words[i:j] if j - i <= MAX_REPEATED_WORDS else words[i:i + 2]
        i = j
    return cleaned

def transcribe_file(
    audio_path: str,
    model_name: str,
    device: str = "auto",
    language: Optional[str] = None,
    vocabulary: Optional[list[str]] = None,
) -> dict:
    """Transcribe one audio file with word timestamps. Blocking; run in a thread."""
    model = _load(model_name, device)
    segments, info = model.transcribe(
        _read_pcm_wav(audio_path),
        language=language if language and language != "auto" else None,
        word_timestamps=True,
        vad_filter=True,
        initial_prompt=f"Hello. Names and terms: {', '.join(vocabulary)}." if vocabulary else None,
    )
    words: list[dict] = []
    texts: list[str] = []
    for segment in segments:
        texts.append(segment.text.strip())
        for word in segment.words or []:
            text = word.word.strip()
            if text and word.end >= word.start:
                words.append({"word": text, "start": float(word.start), "end": float(word.end)})
    words = clean_words(words)
    return {
        "text": " ".join(t for t in texts if t),
        "language": getattr(info, "language", None),
        "words": words,
        "usage": {"seconds": float(getattr(info, "duration", 0.0) or 0.0), "cost": 0.0},
    }
