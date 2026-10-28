"""Local mode: faster-whisper transcription and Claude API chat, offline."""

import asyncio
from types import SimpleNamespace

import pytest

from clip_engine.config import Settings
from clip_engine.services import anthropic_direct
from clip_engine.services import transcription_service as stt
from clip_engine.services.openrouter import json_schema_format

LOCAL = stt.LOCAL_TRANSCRIPTION_PREFIX + "large-v3-turbo"

def test_local_mode_settings_route_transcription_and_chat():
    settings = Settings(clipping_mode="local", anthropic_api_key="k", openrouter_api_key="")
    assert settings.transcription_model == LOCAL
    assert settings.uses_anthropic_direct and settings.chat_provider_configured
    assert not Settings(clipping_mode="local").chat_provider_configured
    assert not Settings(clipping_mode="quality", anthropic_api_key="k").uses_anthropic_direct

def test_request_translates_openrouter_payload():
    schema = {"type": "object", "properties": {"n": {"type": "integer", "minimum": 0},
              "items": {"type": "array", "maxItems": 3, "items": {"type": "string", "maxLength": 9}}},
              "required": ["n", "items"], "additionalProperties": False}
    payload = {
        "model": "anthropic/claude-opus-5.5",
        "messages": [
            {"role": "system", "content": "Plan clips."},
            {"role": "user", "content": [
                {"type": "text", "text": "Transcript"},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,QUJD"}},
            ]},
        ],
        "max_tokens": 32000, "response_format": json_schema_format("plan", schema),
        "reasoning": {"effort": "medium", "exclude": True},
        "plugins": [{"id": "response-healing"}], "provider": {"require_parameters": True},
        "models": ["google/gemini-3.8-flash"], "temperature": 0.2,
    }
    request = anthropic_direct.build_request(payload)
    assert request["model"] == "claude-opus-5-5"
    assert request["system"] == "Plan clips."
    assert request["max_tokens"] == 32000
    assert request["messages"] == [{"role": "user", "content": [
        {"type": "text", "text": "Transcript"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "QUJD"}},
    ]}]
    sent = request["output_config"]["format"]["schema"]
    assert "minimum" not in sent["properties"]["n"]
    assert "maxItems" not in sent["properties"]["items"]
    assert "maxLength" not in sent["properties"]["items"]["items"]
    assert sent["additionalProperties"] is False
    assert request["output_config"]["effort"] == "medium"
    assert not {"plugins", "provider", "models", "temperature", "reasoning"} & request.keys()
    assert schema["properties"]["n"]["minimum"] == 0

def test_effort_none_maps_to_low_and_non_claude_models_are_refused():
    request = anthropic_direct.build_request({"model": "anthropic/claude-sonnet-5.5", "messages": [
        {"role": "user", "content": "hi"}], "reasoning": {"effort": "none"}})
    assert request["model"] == "claude-sonnet-5-5"
    assert request["output_config"] == {"effort": "low"}
    with pytest.raises(anthropic_direct.AnthropicDirectError):
        anthropic_direct.build_request({"model": "google/gemini-3.8-flash", "messages": []})

def test_cost_uses_list_prices():
    assert anthropic_direct._cost("claude-opus-5-5", 1_000_000, 100_000, 0, 0) == 6.0
    assert anthropic_direct._cost("unknown-model", 1, 1, 0, 0) is None

def test_local_transcription_needs_no_openrouter_key_and_costs_nothing(monkeypatch, tmp_path):
    svc = stt.TranscriptionService.__new__(stt.TranscriptionService)
    svc.settings = SimpleNamespace(transcription_model=LOCAL, openrouter_api_key="", local_whisper_device="cpu",
                                   transcription_diarize=True, clipping_mode="local")
    svc.progress_callback = None
    calls = []

    def fake_transcribe(path, model, device, language, vocabulary):
        calls.append((model, device, vocabulary))
        return {"text": "Hello there.", "language": "en", "usage": {"seconds": 2.0, "cost": 0.0},
                "words": [{"word": "Hello", "start": 0.1, "end": 0.4}, {"word": "there.", "start": 0.5, "end": 0.9}]}

    from clip_engine.services import local_whisper
    monkeypatch.setattr(local_whisper, "transcribe_file", fake_transcribe)
    monkeypatch.setattr(svc, "_audio_duration", lambda _: 2.0)
    path = tmp_path / "audio.wav"
    path.write_bytes(b"offline audio")
    result = asyncio.run(svc.transcribe_audio(str(path), keyterms=["myClipper"]))
    assert calls == [("large-v3-turbo", "cpu", ["myClipper"])]
    assert [w.word for w in result.segments[0].words] == ["Hello", "there."]
    assert result.segments[0].words[1].end_time_ms == 900
    assert result.api_costs.estimated_cost_usd == 0.0 and not result.api_costs.cost_incomplete

def test_missing_faster_whisper_is_a_clear_non_retryable_error(monkeypatch, tmp_path):
    svc = stt.TranscriptionService.__new__(stt.TranscriptionService)
    svc.settings = SimpleNamespace(transcription_model=LOCAL, openrouter_api_key="", local_whisper_device="auto",
                                   transcription_diarize=True, clipping_mode="local")
    svc.progress_callback = None
    from clip_engine.services import local_whisper

    def unavailable(*_):
        raise local_whisper.LocalWhisperUnavailable("faster-whisper is not installed in the engine environment")

    monkeypatch.setattr(local_whisper, "transcribe_file", unavailable)
    monkeypatch.setattr(svc, "_audio_duration", lambda _: 2.0)
    path = tmp_path / "audio.wav"
    path.write_bytes(b"offline audio")
    with pytest.raises(stt.TranscriptionError) as error:
        asyncio.run(svc.transcribe_audio(str(path)))
    assert error.value.reason == "local_whisper_unavailable"
