from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Sequence

import numpy as np
from sentence_transformers import SentenceTransformer
import torch


DEFAULT_CONFIG_PATH = Path(".openclaw/quantclaw.json")
DEFAULT_OUTPUT_DIR = Path("./embedding_router_index")
DEFAULT_MODEL_NAME = "BAAI/bge-m3"
DEFAULT_TOP_K = 1
DEFAULT_DEVICE = "auto"


def normalize_text(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"\s+", " ", text)
    return text


def has_cjk(text: str) -> bool:
    return bool(re.search(r"[\u4e00-\u9fff]", text))


def tokenize_for_overlap(text: str) -> List[str]:
    normalized = normalize_text(text)
    tokens = re.findall(r"[\u4e00-\u9fff]+|[a-z0-9_+\-.#]+", normalized)
    return [token for token in tokens if len(token) > 1]


@dataclass
class Prototype:
    task_id: str
    variant: str
    text: str


class EmbeddingTaskRouter:
    def __init__(
        self,
        model_name: str = DEFAULT_MODEL_NAME,
        config_path: Path = DEFAULT_CONFIG_PATH,
        output_dir: Path = DEFAULT_OUTPUT_DIR,
        device: str = DEFAULT_DEVICE,
    ) -> None:
        self.model_name = model_name
        self.config_path = Path(config_path)
        self.output_dir = Path(output_dir)
        self.requested_device = device
        self.device = self.resolve_device(device)
        self.model = SentenceTransformer(model_name, device=self.device)

        self.metadata: Dict = {}
        self.prototypes: List[Prototype] = []
        self.prototype_embeddings: np.ndarray | None = None
        self.task_keywords: Dict[str, List[str]] = {}
        self.default_task_type = "standard"

    @staticmethod
    def resolve_device(device: str) -> str:
        requested = (device or DEFAULT_DEVICE).strip().lower()
        if requested in {"", "auto"}:
            return "cuda" if torch.cuda.is_available() else "cpu"
        if requested.startswith("cuda") and not torch.cuda.is_available():
            raise RuntimeError(
                f"CUDA device '{device}' was requested, but torch.cuda.is_available() is False."
            )
        return device

    def load_config(self) -> Dict:
        with self.config_path.open("r", encoding="utf-8") as f:
            config = json.load(f)
        return config["quant"]

    def build_prototypes(self, task_types: Sequence[Dict]) -> List[Prototype]:
        prototypes: List[Prototype] = []

        for task in task_types:
            task_id = task["id"]
            description = task.get("description", "").strip()
            keywords = [str(x).strip() for x in task.get("keywords", []) if str(x).strip()]
            self.task_keywords[task_id] = keywords

            mixed_keywords = ", ".join(keywords)
            english_keywords = [kw for kw in keywords if not has_cjk(kw)]
            chinese_keywords = [kw for kw in keywords if has_cjk(kw)]

            candidates = [
                (
                    "full",
                    f"Task type id: {task_id}. Description: {description}. Keywords: {mixed_keywords}.",
                ),
                (
                    "desc",
                    f"{task_id}: {description}",
                ),
                (
                    "keywords_all",
                    f"{task_id}: {mixed_keywords}",
                ),
            ]

            if english_keywords:
                candidates.append(
                    ("keywords_en", f"{task_id}: {', '.join(english_keywords)}")
                )
            if chinese_keywords:
                candidates.append(
                    ("keywords_zh", f"{task_id}: {'，'.join(chinese_keywords)}")
                )

            for keyword in keywords:
                candidates.append(
                    (
                        "keyword_single",
                        f"Task type {task_id} is relevant when the user asks about {keyword}.",
                    )
                )

            seen_texts = set()
            for variant, text in candidates:
                normalized = normalize_text(text)
                if normalized in seen_texts:
                    continue
                seen_texts.add(normalized)
                prototypes.append(Prototype(task_id=task_id, variant=variant, text=text))

        return prototypes

    def encode_texts(self, texts: Iterable[str]) -> np.ndarray:
        embeddings = self.model.encode(
            list(texts),
            normalize_embeddings=True,
            show_progress_bar=True,
            convert_to_numpy=True,
        )
        return np.asarray(embeddings, dtype=np.float32)

    def build_index(self) -> None:
        quant_config = self.load_config()
        task_types = quant_config["taskTypes"]
        self.default_task_type = quant_config.get("defaultTaskType", "standard")
        self.prototypes = self.build_prototypes(task_types)
        self.prototype_embeddings = self.encode_texts(proto.text for proto in self.prototypes)

        self.output_dir.mkdir(parents=True, exist_ok=True)

        metadata = {
            "model_name": self.model_name,
            "config_path": str(self.config_path),
            "default_task_type": self.default_task_type,
            "task_keywords": self.task_keywords,
            "prototypes": [
                {
                    "task_id": proto.task_id,
                    "variant": proto.variant,
                    "text": proto.text,
                }
                for proto in self.prototypes
            ],
        }

        with (self.output_dir / "metadata.json").open("w", encoding="utf-8") as f:
            json.dump(metadata, f, ensure_ascii=False, indent=2)

        np.save(self.output_dir / "prototype_embeddings.npy", self.prototype_embeddings)

    def load_index(self) -> None:
        with (self.output_dir / "metadata.json").open("r", encoding="utf-8") as f:
            self.metadata = json.load(f)

        self.default_task_type = self.metadata.get("default_task_type", "standard")
        self.task_keywords = self.metadata["task_keywords"]
        self.prototypes = [
            Prototype(
                task_id=item["task_id"],
                variant=item["variant"],
                text=item["text"],
            )
            for item in self.metadata["prototypes"]
        ]
        self.prototype_embeddings = np.load(self.output_dir / "prototype_embeddings.npy")

    def keyword_bonus(self, prompt: str, task_id: str) -> float:
        prompt_norm = normalize_text(prompt)
        prompt_tokens = set(tokenize_for_overlap(prompt))
        keywords = self.task_keywords.get(task_id, [])
        if not keywords:
            return 0.0

        substring_hits = 0
        overlap_hits = 0
        for keyword in keywords:
            keyword_norm = normalize_text(keyword)
            if keyword_norm and keyword_norm in prompt_norm:
                substring_hits += 1

            keyword_tokens = set(tokenize_for_overlap(keyword))
            if keyword_tokens and keyword_tokens & prompt_tokens:
                overlap_hits += 1

        return min(0.18, substring_hits * 0.06 + overlap_hits * 0.02)

    def score_prompt(self, prompt: str) -> List[Dict]:
        if self.prototype_embeddings is None:
            raise RuntimeError("Index is not loaded. Run build_index() or load_index() first.")

        prompt_embedding = self.encode_texts([prompt])[0]
        similarities = self.prototype_embeddings @ prompt_embedding

        per_task_scores: Dict[str, List[float]] = {}
        for similarity, proto in zip(similarities.tolist(), self.prototypes):
            per_task_scores.setdefault(proto.task_id, []).append(float(similarity))

        results: List[Dict] = []
        for task_id, scores in per_task_scores.items():
            sorted_scores = sorted(scores, reverse=True)
            best_score = sorted_scores[0]
            mean_top3 = float(np.mean(sorted_scores[:3]))
            bonus = self.keyword_bonus(prompt, task_id)

            final_score = 0.78 * best_score + 0.22 * mean_top3 + bonus
            results.append(
                {
                    "task_id": task_id,
                    "score": round(final_score, 6),
                    "best_embedding_score": round(best_score, 6),
                    "mean_top3_embedding_score": round(mean_top3, 6),
                    "keyword_bonus": round(bonus, 6),
                }
            )

        results.sort(key=lambda item: item["score"], reverse=True)
        return results

    def predict(self, prompt: str, top_k: int = DEFAULT_TOP_K) -> Dict:
        ranked = self.score_prompt(prompt)
        best = ranked[0] if ranked else None

        if not best:
            predicted_task_id = self.default_task_type
            confidence = 0.0
        else:
            predicted_task_id = best["task_id"]
            confidence = best["score"]

        return {
            "prompt": prompt,
            "predicted_task_type_id": predicted_task_id,
            "confidence": round(confidence, 6),
            "default_task_type": self.default_task_type,
            "top_k": ranked[:top_k],
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build and query an embedding-based task type router from "
            "/home/sza/.openclaw/quantclaw.json"
        )
    )
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
        help=f"Where to save/load the embedding index, default: {DEFAULT_OUTPUT_DIR}",
    )
    parser.add_argument(
        "--device",
        default=DEFAULT_DEVICE,
        help=(
            "Device for sentence_transformers, e.g. auto, cpu, cuda, cuda:0. "
            f"Default: {DEFAULT_DEVICE}"
        ),
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    build_parser = subparsers.add_parser("build", help="Build embedding index from taskTypes")
    build_parser.add_argument(
        "--print-summary",
        action="store_true",
        help="Print a short summary after index build",
    )

    predict_parser = subparsers.add_parser("predict", help="Predict task type for one prompt")
    predict_parser.add_argument("--prompt", required=True, help="Prompt text to classify")
    predict_parser.add_argument(
        "--top-k",
        type=int,
        default=DEFAULT_TOP_K,
        help=f"Number of ranked task types to return, default: {DEFAULT_TOP_K}",
    )

    repl_parser = subparsers.add_parser("repl", help="Interactive prompt classification loop")
    repl_parser.add_argument(
        "--top-k",
        type=int,
        default=DEFAULT_TOP_K,
        help=f"Number of ranked task types to return, default: {DEFAULT_TOP_K}",
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

    if args.command == "build":
        router.build_index()
        if args.print_summary:
            print(
                json.dumps(
                    {
                        "model_name": router.model_name,
                        "requested_device": router.requested_device,
                        "device": router.device,
                        "config_path": str(router.config_path),
                        "output_dir": str(router.output_dir),
                        "task_type_count": len(router.task_keywords),
                        "prototype_count": len(router.prototypes),
                        "default_task_type": router.default_task_type,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        return

    router.load_index()

    if args.command == "predict":
        result = router.predict(prompt=args.prompt, top_k=args.top_k)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    if args.command == "repl":
        print("Enter a prompt. Type 'exit' or 'quit' to stop.")
        while True:
            prompt = input("prompt> ").strip()
            if not prompt:
                continue
            if prompt.lower() in {"exit", "quit"}:
                break
            result = router.predict(prompt=prompt, top_k=args.top_k)
            print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

