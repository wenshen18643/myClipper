"""
Claude API backend for the OpenRouter-shaped chat requests used in local mode.

Planning and layout vision build OpenRouter chat-completions payloads. This
module translates one payload to a Messages API request with the Anthropic SDK
and returns an OpenRouter-shaped body and usage, so callers stay unchanged.
"""

import copy
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

PRICES = {
    "claude-opus-5-5": (4.0, 20.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-haiku-5-5": (0.10, 0.50),
}

UNSUPPORTED_SCHEMA_KEYS = {
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "pattern",
}

FINISH_REASONS = {"end_turn": "stop", "stop_sequence": "stop", "max_tokens": "length", "refusal": "content_filter"}
EFFORTS = {"none": "low", "minimal": "low", "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh"}
DEFAULT_MAX_TOKENS = 16000

class AnthropicDirectError(Exception):
    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable

def claude_model_id(model: str) -> str:
    """`anthropic/claude-opus-5.5` -> `claude-opus-5-5`."""
    if not model.startswith("anthropic/"):
        raise AnthropicDirectError(f"Local mode only supports Claude models, not {model}")
    return model.split("/", 1)[1].replace(".", "-")

def _sanitize_schema(node: Any) -> Any:
    if isinstance(node, dict):
        return {k: _sanitize_schema(v) for k, v in node.items() if k not in UNSUPPORTED_SCHEMA_KEYS}
    if isinstance(node, list):
        return [_sanitize_schema(v) for v in node]
    return node

def _content_blocks(content: Any) -> Any:
    if isinstance(content, str):
        return content
    blocks = []
    for part in content or []:
        kind = part.get("type")
        if kind == "text":
            blocks.append({"type": "text", "text": part["text"]})
        elif kind == "image_url":
            url = (part.get("image_url") or {}).get("url", "")
            header, _, data = url.partition(",")
            if not header.startswith("data:") or ";base64" not in header:
                raise AnthropicDirectError("Only inline base64 images are supported")
            blocks.append({"type": "image", "source": {
                "type": "base64", "media_type": header[5:].split(";")[0], "data": data}})
    return blocks

def build_request(payload: dict[str, Any]) -> dict[str, Any]:
    """Translate an OpenRouter chat payload to Messages API parameters."""
    system: list[str] = []
    messages = []
    for message in payload.get("messages", []):
        if message["role"] == "system":
            content = message["content"]
            system.append(content if isinstance(content, str) else
                          "\n".join(p.get("text", "") for p in content if p.get("type") == "text"))
        else:
            messages.append({"role": message["role"], "content": _content_blocks(message["content"])})
    request: dict[str, Any] = {
        "model": claude_model_id(payload["model"]),
        "max_tokens": payload.get("max_tokens") or DEFAULT_MAX_TOKENS,
        "messages": messages,
    }
    if system:
        request["system"] = "\n\n".join(system)
    output_config: dict[str, Any] = {}
    effort = (payload.get("reasoning") or {}).get("effort")
    if effort:
        output_config["effort"] = EFFORTS.get(effort, "medium")
    response_format = payload.get("response_format") or {}
    if response_format.get("type") == "json_schema":
        schema = copy.deepcopy(response_format["json_schema"]["schema"])
        output_config["format"] = {"type": "json_schema", "schema": _sanitize_schema(schema)}
    if output_config:
        request["output_config"] = output_config
    return request

def _cost(model: str, input_tokens: int, output_tokens: int, cache_read: int, cache_write: int) -> Optional[float]:
    price = PRICES.get(model)
    if not price:
        return None
    input_price, output_price = price
    return round((input_tokens * input_price + cache_read * input_price * 0.1
                  + cache_write * input_price * 1.25 + output_tokens * output_price) / 1_000_000, 8)

async def chat_completion(payload: dict[str, Any], api_key: str) -> tuple[dict, dict]:
    """Run one OpenRouter-shaped chat request against the Claude API."""
    import anthropic

    request = build_request(payload)
    client = anthropic.AsyncAnthropic(api_key=api_key, max_retries=2, timeout=600.0)
    try:
        async with client.messages.stream(**request) as stream:
            message = await stream.get_final_message()
    except anthropic.AuthenticationError:
        raise AnthropicDirectError("Claude API key was rejected. Check it in Settings.") from None
    except anthropic.PermissionDeniedError:
        raise AnthropicDirectError("Claude API key cannot use this model") from None
    except anthropic.RateLimitError:
        raise AnthropicDirectError("Claude API rate limit reached", retryable=True) from None
    except anthropic.BadRequestError as error:
        if "credit balance" in str(error).lower():
            raise AnthropicDirectError("Claude API credits are used up. Add credits in the Claude Console.") from None
        raise AnthropicDirectError("Claude API rejected the request") from None
    except anthropic.APIStatusError as error:
        raise AnthropicDirectError(f"Claude API error ({error.status_code})", retryable=error.status_code >= 500) from None
    except anthropic.APIConnectionError:
        raise AnthropicDirectError("Claude API request failed", retryable=True) from None
    finally:
        await client.close()

    text = "".join(block.text for block in message.content if block.type == "text")
    usage = message.usage
    input_tokens = usage.input_tokens or 0
    cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
    cache_write = getattr(usage, "cache_creation_input_tokens", 0) or 0
    output_tokens = usage.output_tokens or 0
    cost = _cost(request["model"], input_tokens, output_tokens, cache_read, cache_write)
    prompt_tokens = input_tokens + cache_read + cache_write
    body = {
        "model": message.model,
        "choices": [{"message": {"role": "assistant", "content": text},
                     "finish_reason": FINISH_REASONS.get(message.stop_reason, message.stop_reason)}],
        "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": output_tokens,
                  "total_tokens": prompt_tokens + output_tokens, "cost": cost},
    }
    usage_data = {"prompt_tokens": prompt_tokens, "completion_tokens": output_tokens,
                  "total_tokens": prompt_tokens + output_tokens, "cost": cost}
    logger.info("Claude API usage (%s): %d input, %d output, cost=$%s",
                message.model, prompt_tokens, output_tokens, cost if cost is not None else "n/a")
    return body, usage_data
