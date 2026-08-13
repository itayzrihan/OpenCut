#!/usr/bin/env python3
"""Create an analyzer-compatible local Whisper transcript with word timings."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Transcribe a reference video locally with OpenAI Whisper.",
    )
    parser.add_argument("input", type=Path, help="Source video or audio file")
    parser.add_argument("--output", type=Path, required=True, help="Output JSON")
    parser.add_argument("--model", default="small.en", help="Whisper model")
    parser.add_argument("--language", default="en", help="Language or auto")
    parser.add_argument(
        "--model-dir",
        type=Path,
        help="Optional directory for downloaded model weights",
    )
    parser.add_argument(
        "--device",
        choices=["auto", "cpu", "cuda"],
        default="auto",
        help="Inference device",
    )
    return parser.parse_args()


def round_seconds(value: Any) -> float:
    return round(float(value), 3)


def normalize_word(word: dict[str, Any]) -> dict[str, Any] | None:
    text = str(word.get("word") or "").strip()
    start = word.get("start")
    end = word.get("end")
    if not text or start is None or end is None or float(end) <= float(start):
        return None
    probability = float(word.get("probability") or 0)
    return {
        "text": text,
        "start": round_seconds(start),
        "end": round_seconds(end),
        "probability": round(probability, 6),
    }


def normalize_segment(segment: dict[str, Any]) -> dict[str, Any] | None:
    text = str(segment.get("text") or "").strip()
    start = segment.get("start")
    end = segment.get("end")
    if not text or start is None or end is None or float(end) <= float(start):
        return None
    words = [
        normalized
        for word in segment.get("words") or []
        if (normalized := normalize_word(word)) is not None
    ]
    return {
        "text": text,
        "start": round_seconds(start),
        "end": round_seconds(end),
        "words": words,
        "averageLogProbability": round(
            float(segment.get("avg_logprob") or 0),
            6,
        ),
        "noSpeechProbability": round(
            float(segment.get("no_speech_prob") or 0),
            6,
        ),
    }


def main() -> int:
    args = parse_args()
    if not args.input.is_file():
        raise FileNotFoundError(f"Input does not exist: {args.input}")
    try:
        import torch
        import whisper
    except ImportError as error:
        raise RuntimeError(
            "Install the optional local transcriber with: "
            "python -m pip install openai-whisper",
        ) from error

    device = args.device
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is not available")

    model = whisper.load_model(
        args.model,
        device=device,
        download_root=str(args.model_dir.resolve()) if args.model_dir else None,
    )
    raw = model.transcribe(
        str(args.input.resolve()),
        language=None if args.language == "auto" else args.language,
        task="transcribe",
        word_timestamps=True,
        verbose=False,
        fp16=device == "cuda",
    )
    segments = [
        normalized
        for segment in raw.get("segments") or []
        if (normalized := normalize_segment(segment)) is not None
    ]
    words = [word for segment in segments for word in segment["words"]]
    probabilities = [word["probability"] for word in words]
    low_confidence = [word for word in words if word["probability"] < 0.55]
    result = {
        "schemaVersion": 1,
        "source": {
            "path": str(args.input.resolve()),
            "model": args.model,
            "language": raw.get("language"),
            "device": device,
        },
        "text": str(raw.get("text") or "").strip(),
        "segments": segments,
        "quality": {
            "segmentCount": len(segments),
            "wordCount": len(words),
            "meanWordProbability": (
                round(sum(probabilities) / len(probabilities), 6)
                if probabilities
                else None
            ),
            "lowConfidenceWordCount": len(low_confidence),
            "lowConfidenceWords": low_confidence,
        },
    }
    if result["quality"]["meanWordProbability"] is not None and not math.isfinite(
        result["quality"]["meanWordProbability"],
    ):
        raise RuntimeError("Whisper produced a non-finite confidence score")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        f"{json.dumps(result, indent=2, ensure_ascii=False)}\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "output": str(args.output.resolve()),
                "segments": len(segments),
                "words": len(words),
                "meanWordProbability": result["quality"]["meanWordProbability"],
            },
        ),
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"error: {error}")
        raise SystemExit(1)
