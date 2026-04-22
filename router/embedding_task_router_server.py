from __future__ import annotations

import argparse
import json
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Tuple

from embedding_task_router import (
    DEFAULT_CONFIG_PATH,
    DEFAULT_DEVICE,
    DEFAULT_MODEL_NAME,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_TOP_K,
    EmbeddingTaskRouter,
)


def extract_text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text", "")
                if text:
                    parts.append(str(text))
        return "\n".join(parts)

    return ""


def extract_prompt_from_messages(messages: Any) -> str:
    if not isinstance(messages, list):
        return ""

    user_texts: List[str] = []
    fallback_texts: List[str] = []

    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role", "")
        text = extract_text_from_content(message.get("content"))
        if not text:
            continue
        fallback_texts.append(text)
        if role == "user":
            user_texts.append(text)

    if user_texts:
        return "\n".join(user_texts)
    return "\n".join(fallback_texts)


class OpenAICompatibleRouterHandler(BaseHTTPRequestHandler):
    router: EmbeddingTaskRouter
    response_model_name: str

    server_version = "EmbeddingTaskRouterHTTP/1.0"

    def _send_json(self, payload: Dict[str, Any], status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> Tuple[Dict[str, Any] | None, str | None]:
        content_length = self.headers.get("Content-Length", "0")
        try:
            raw_length = int(content_length)
        except ValueError:
            return None, "Invalid Content-Length header"

        raw_body = self.rfile.read(raw_length)
        if not raw_body:
            return {}, None

        try:
            return json.loads(raw_body.decode("utf-8")), None
        except json.JSONDecodeError as exc:
            return None, f"Invalid JSON body: {exc}"

    def _send_error_json(self, message: str, status: int) -> None:
        self._send_json(
            {
                "error": {
                    "message": message,
                    "type": "invalid_request_error",
                    "code": status,
                }
            },
            status=status,
        )

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json({"status": "ok"})
            return

        if self.path == "/v1/models":
            self._send_json(
                {
                    "object": "list",
                    "data": [
                        {
                            "id": self.response_model_name,
                            "object": "model",
                            "created": int(time.time()),
                            "owned_by": "local",
                        }
                    ],
                }
            )
            return

        self._send_error_json("Not found", HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self._send_error_json("Not found", HTTPStatus.NOT_FOUND)
            return

        payload, error_message = self._read_json_body()
        if error_message:
            self._send_error_json(error_message, HTTPStatus.BAD_REQUEST)
            return

        assert payload is not None
        prompt = extract_prompt_from_messages(payload.get("messages"))
        if not prompt.strip():
            self._send_error_json(
                "Could not extract prompt text from request.messages",
                HTTPStatus.BAD_REQUEST,
            )
            return

        top_k = payload.get("top_k", DEFAULT_TOP_K)
        try:
            top_k_int = max(1, int(top_k))
        except (TypeError, ValueError):
            top_k_int = DEFAULT_TOP_K

        result = self.router.predict(prompt=prompt, top_k=top_k_int)
        content = json.dumps(
            {"taskTypeId": result["predicted_task_type_id"]},
            ensure_ascii=False,
            separators=(",", ":"),
        )

        created = int(time.time())
        response = {
            "id": f"chatcmpl-{uuid.uuid4().hex}",
            "object": "chat.completion",
            "created": created,
            "model": str(payload.get("model") or self.response_model_name),
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": content,
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
            },
            "router_result": result,
        }
        self._send_json(response)

    def log_message(self, format: str, *args: Any) -> None:
        return


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the embedding task router via an OpenAI-compatible API")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind, default: 127.0.0.1")
    parser.add_argument("--port", type=int, default=8011, help="Port to bind, default: 8011")
    parser.add_argument(
        "--model-name",
        default=DEFAULT_MODEL_NAME,
        help=f"sentence_transformers model name, default: {DEFAULT_MODEL_NAME}",
    )
    parser.add_argument(
        "--config-path",
        type=Path,
        default=DEFAULT_CONFIG_PATH,
        help=f"Path to quantclaw config, default: {DEFAULT_CONFIG_PATH}",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Path to embedding index, default: {DEFAULT_OUTPUT_DIR}",
    )
    parser.add_argument(
        "--device",
        default=DEFAULT_DEVICE,
        help=(
            "Device for sentence_transformers, e.g. auto, cpu, cuda, cuda:0. "
            f"Default: {DEFAULT_DEVICE}"
        ),
    )
    parser.add_argument(
        "--response-model-name",
        default="embedding-task-router",
        help="Model name exposed by /v1/models and used in completion responses",
    )
    parser.add_argument(
        "--rebuild-if-missing",
        action="store_true",
        help="Build the embedding index automatically if it does not exist",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    router = EmbeddingTaskRouter(
        model_name=args.model_name,
        config_path=args.config_path,
        output_dir=args.output_dir,
        device=args.device,
    )

    metadata_path = args.output_dir / "metadata.json"
    embeddings_path = args.output_dir / "prototype_embeddings.npy"
    if metadata_path.exists() and embeddings_path.exists():
        router.load_index()
    elif args.rebuild_if_missing:
        router.build_index()
    else:
        raise FileNotFoundError(
            "Embedding index not found. Run embedding_task_router.py build first, "
            "or start the server with --rebuild-if-missing."
        )

    OpenAICompatibleRouterHandler.router = router
    OpenAICompatibleRouterHandler.response_model_name = args.response_model_name

    server = ThreadingHTTPServer((args.host, args.port), OpenAICompatibleRouterHandler)
    print(f"Serving on http://{args.host}:{args.port}")
    print("POST /v1/chat/completions")
    print("GET  /v1/models")
    print("GET  /health")
    server.serve_forever()


if __name__ == "__main__":
    main()

'''
python embedding_task_router_server.py --model-name all-MiniLM-L6-v2 --device cuda
'''
