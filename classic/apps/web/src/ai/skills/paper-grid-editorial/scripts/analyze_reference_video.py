#!/usr/bin/env python3
"""Extract a deterministic audiovisual sample and quantify every transition.

The output is intentionally model-friendly:
- exact sampled frames
- labeled contact sheets
- per-frame visual metrics
- one record for every consecutive frame transition
- native-frame scene-change candidates
- word-timed speech gaps independent of the mastered mix
- 50ms audio windows, silence intervals, and a labeled waveform
- a Markdown summary with the strongest change candidates

Only FFmpeg, FFprobe, Pillow, and NumPy are required.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import shutil
import subprocess
import sys
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageFont


@dataclass(frozen=True)
class FrameMetric:
    frame_index: int
    timestamp_seconds: float
    filename: str
    mean_luma: float
    black_ratio: float
    white_ratio: float
    mean_saturation: float
    edge_density: float
    active_transcript: str


@dataclass(frozen=True)
class TransitionMetric:
    from_frame: int
    to_frame: int
    from_seconds: float
    to_seconds: float
    gray_mae: float
    rgb_mae: float
    hash_distance: int
    changed_area_ratio: float
    motion_centroid_x: float | None
    motion_centroid_y: float | None
    classification: str


@dataclass(frozen=True)
class AudioWindow:
    start_seconds: float
    end_seconds: float
    rms_dbfs: float
    peak_dbfs: float
    classification: str


@dataclass(frozen=True)
class SilenceInterval:
    start_seconds: float
    end_seconds: float
    duration_seconds: float
    mean_rms_dbfs: float


@dataclass(frozen=True)
class SceneCutCandidate:
    timestamp_seconds: float
    threshold: float


@dataclass(frozen=True)
class SpeechGap:
    start_seconds: float
    end_seconds: float
    duration_seconds: float
    previous_word: str | None
    next_word: str | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sample and analyze a reference video frame by frame.",
    )
    parser.add_argument("input", type=Path, help="Source video file")
    parser.add_argument("--output", type=Path, required=True, help="Output directory")
    parser.add_argument(
        "--duration",
        type=float,
        help="Seconds to analyze from the beginning (default: full video)",
    )
    parser.add_argument(
        "--sample-fps",
        type=float,
        default=3.0,
        help="Frame samples per second (default: 3)",
    )
    parser.add_argument(
        "--sheet-seconds",
        type=float,
        default=10.0,
        help="Seconds represented by each contact sheet (default: 10)",
    )
    parser.add_argument(
        "--transcript-json",
        type=Path,
        help="Optional whisper.cpp JSON for transcript alignment",
    )
    parser.add_argument(
        "--silence-db",
        type=float,
        default=-42.0,
        help="RMS threshold used for silence candidates (default: -42 dBFS)",
    )
    parser.add_argument(
        "--silence-min-seconds",
        type=float,
        default=0.1,
        help="Minimum silence interval to report (default: 0.1)",
    )
    parser.add_argument(
        "--scene-threshold",
        type=float,
        default=0.12,
        help="FFmpeg native-frame scene-change threshold (default: 0.12)",
    )
    parser.add_argument("--ffmpeg", default="ffmpeg", help="FFmpeg executable")
    parser.add_argument("--ffprobe", default="ffprobe", help="FFprobe executable")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace only artifacts previously generated in the output directory",
    )
    return parser.parse_args()


def run(command: Sequence[str]) -> str:
    completed = subprocess.run(
        list(command),
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"Command failed ({completed.returncode}): {detail}")
    return completed.stdout


def run_bytes(command: Sequence[str]) -> bytes:
    completed = subprocess.run(
        list(command),
        check=False,
        capture_output=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"Command failed ({completed.returncode}): {detail}")
    return completed.stdout


def resolve_executable(value: str) -> str:
    explicit = Path(value)
    if explicit.exists():
        return str(explicit.resolve())
    resolved = shutil.which(value)
    if not resolved:
        raise FileNotFoundError(f"Executable not found: {value}")
    return resolved


def validate_inputs(args: argparse.Namespace) -> None:
    if not args.input.is_file():
        raise FileNotFoundError(f"Input video does not exist: {args.input}")
    if args.duration is not None and (
        not math.isfinite(args.duration) or args.duration <= 0
    ):
        raise ValueError("--duration must be a positive finite number")
    if not math.isfinite(args.sample_fps) or args.sample_fps <= 0:
        raise ValueError("--sample-fps must be a positive finite number")
    if args.sample_fps > 30:
        raise ValueError("--sample-fps is capped at 30")
    if not math.isfinite(args.sheet_seconds) or args.sheet_seconds <= 0:
        raise ValueError("--sheet-seconds must be a positive finite number")
    if not math.isfinite(args.silence_db) or args.silence_db >= 0:
        raise ValueError("--silence-db must be a finite negative number")
    if (
        not math.isfinite(args.silence_min_seconds)
        or args.silence_min_seconds <= 0
    ):
        raise ValueError("--silence-min-seconds must be positive and finite")
    if (
        not math.isfinite(args.scene_threshold)
        or args.scene_threshold <= 0
        or args.scene_threshold >= 1
    ):
        raise ValueError("--scene-threshold must be between 0 and 1")


def prepare_output(output: Path, overwrite: bool) -> None:
    output.mkdir(parents=True, exist_ok=True)
    generated = [
        output / "frames",
        output / "contact-sheets",
        output / "manifest.json",
        output / "frames.csv",
        output / "transitions.json",
        output / "audio-windows.csv",
        output / "audio-analysis.json",
        output / "audio-waveform.png",
        output / "scene-cuts.json",
        output / "speech-gaps.json",
        output / "analysis.md",
    ]
    existing = [path for path in generated if path.exists()]
    if existing and not overwrite:
        names = ", ".join(path.name for path in existing)
        raise FileExistsError(
            f"Generated artifacts already exist ({names}); pass --overwrite",
        )
    if not overwrite:
        return
    for path in existing:
        resolved = path.resolve()
        if output.resolve() not in resolved.parents:
            raise RuntimeError(f"Refusing to remove path outside output: {resolved}")
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()


def probe_video(ffprobe: str, source: Path) -> dict[str, Any]:
    raw = run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            (
                "format=duration,size,bit_rate:"
                "stream=index,codec_type,codec_name,width,height,"
                "r_frame_rate,avg_frame_rate,duration"
            ),
            "-of",
            "json",
            str(source),
        ],
    )
    return json.loads(raw)


def source_video_duration(metadata: dict[str, Any]) -> float:
    streams = metadata.get("streams")
    if isinstance(streams, list):
        for stream in streams:
            if not isinstance(stream, dict) or stream.get("codec_type") != "video":
                continue
            duration = parse_timestamp(stream.get("duration"))
            if duration is not None and duration > 0:
                return duration
    container_duration = parse_timestamp(
        metadata.get("format", {}).get("duration")
        if isinstance(metadata.get("format"), dict)
        else None,
    )
    if container_duration is None or container_duration <= 0:
        raise RuntimeError("Could not determine a positive video duration")
    return container_duration


def detect_scene_cuts(
    ffmpeg: str,
    source: Path,
    duration: float,
    threshold: float,
) -> list[SceneCutCandidate]:
    completed = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "info",
            "-i",
            str(source),
            "-t",
            f"{duration:.9f}",
            "-vf",
            f"select=gt(scene\\,{threshold:.12g}),showinfo",
            "-an",
            "-f",
            "null",
            "-",
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(
            f"Native-frame scene scan failed ({completed.returncode}): {detail}",
        )
    matches = re.findall(r"\bpts_time:([0-9]+(?:\.[0-9]+)?)", completed.stderr)
    return [
        SceneCutCandidate(
            timestamp_seconds=round(float(timestamp), 6),
            threshold=threshold,
        )
        for timestamp in matches
    ]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def expected_frame_count(duration: float, sample_fps: float) -> int:
    """Match FFmpeg's fps filter rounding at a fractional final sample."""
    return max(1, int(math.floor(duration * sample_fps + 0.5)))


def extract_frames(
    ffmpeg: str,
    source: Path,
    output: Path,
    duration: float,
    sample_fps: float,
) -> list[Path]:
    temporary = output / f".frames-{uuid.uuid4().hex}"
    temporary.mkdir(parents=True)
    pattern = temporary / "frame_%04d.jpg"
    try:
        run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(source),
                "-t",
                f"{duration:.9f}",
                "-vf",
                f"fps={sample_fps:.12g}",
                "-q:v",
                "2",
                str(pattern),
            ],
        )
        frames = sorted(temporary.glob("frame_*.jpg"))
        expected = expected_frame_count(duration, sample_fps)
        if len(frames) != expected:
            raise RuntimeError(
                f"Expected {expected} sampled frames, extracted {len(frames)}",
            )
        target = output / "frames"
        temporary.rename(target)
        return sorted(target.glob("frame_*.jpg"))
    except Exception:
        if temporary.exists():
            shutil.rmtree(temporary)
        raise


def parse_timestamp(value: Any) -> float | None:
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        try:
            return float(text)
        except ValueError:
            pass
        parts = text.replace(",", ".").split(":")
        if len(parts) == 3:
            try:
                hours, minutes, seconds = (float(part) for part in parts)
                return hours * 3600 + minutes * 60 + seconds
            except ValueError:
                return None
    return None


def transcript_segments(path: Path | None) -> list[tuple[float, float, str]]:
    if path is None:
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    candidates: Iterable[Any]
    if isinstance(raw, dict):
        candidates = raw.get("transcription") or raw.get("segments") or []
    elif isinstance(raw, list):
        candidates = raw
    else:
        return []
    segments: list[tuple[float, float, str]] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        timestamps = candidate.get("timestamps")
        offsets = candidate.get("offsets")
        start_candidates = [
            parse_timestamp(candidate.get("start")),
            parse_timestamp(candidate.get("start_time")),
            parse_timestamp(timestamps.get("from"))
            if isinstance(timestamps, dict)
            else None,
        ]
        end_candidates = [
            parse_timestamp(candidate.get("end")),
            parse_timestamp(candidate.get("end_time")),
            parse_timestamp(timestamps.get("to"))
            if isinstance(timestamps, dict)
            else None,
        ]
        start = next((value for value in start_candidates if value is not None), None)
        end = next((value for value in end_candidates if value is not None), None)
        if start is None and isinstance(offsets, dict):
            offset_start = parse_timestamp(offsets.get("from"))
            start = offset_start / 1000 if offset_start is not None else None
        if end is None and isinstance(offsets, dict):
            offset_end = parse_timestamp(offsets.get("to"))
            end = offset_end / 1000 if offset_end is not None else None
        text = str(candidate.get("text") or "").strip()
        if start is None or end is None or end <= start or not text:
            continue
        segments.append((start, end, text))
    return segments


def transcript_words(path: Path | None) -> list[tuple[float, float, str]]:
    if path is None:
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        candidates = raw.get("transcription") or raw.get("segments") or []
    elif isinstance(raw, list):
        candidates = raw
    else:
        return []
    words: list[tuple[float, float, str]] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        word_candidates = candidate.get("words")
        if not isinstance(word_candidates, list):
            continue
        for word in word_candidates:
            if not isinstance(word, dict):
                continue
            timestamps = word.get("timestamps")
            start = parse_timestamp(word.get("start"))
            end = parse_timestamp(word.get("end"))
            if start is None and isinstance(timestamps, dict):
                start = parse_timestamp(timestamps.get("from"))
            if end is None and isinstance(timestamps, dict):
                end = parse_timestamp(timestamps.get("to"))
            text = str(word.get("text") or word.get("word") or "").strip()
            if start is None or end is None or end <= start or not text:
                continue
            words.append((start, end, text))
    return sorted(words, key=lambda item: (item[0], item[1]))


def speech_gaps(
    words: Sequence[tuple[float, float, str]],
    duration: float,
    minimum_seconds: float,
) -> list[SpeechGap]:
    if not words:
        return []
    gaps: list[SpeechGap] = []
    boundaries = [
        (0.0, words[0][0], None, words[0][2]),
        *[
            (before[1], after[0], before[2], after[2])
            for before, after in zip(words, words[1:])
        ],
        (words[-1][1], duration, words[-1][2], None),
    ]
    for start, end, previous_word, next_word in boundaries:
        clipped_start = max(0.0, min(duration, start))
        clipped_end = max(0.0, min(duration, end))
        gap_duration = clipped_end - clipped_start
        if gap_duration + 1e-9 < minimum_seconds:
            continue
        gaps.append(
            SpeechGap(
                start_seconds=round(clipped_start, 6),
                end_seconds=round(clipped_end, 6),
                duration_seconds=round(gap_duration, 6),
                previous_word=previous_word,
                next_word=next_word,
            ),
        )
    return gaps


def transcript_at(
    timestamp: float,
    segments: Sequence[tuple[float, float, str]],
) -> str:
    return " ".join(
        text for start, end, text in segments if start <= timestamp < end
    ).strip()


def load_analysis_image(path: Path) -> tuple[np.ndarray, np.ndarray]:
    image = Image.open(path).convert("RGB")
    image.thumbnail((320, 180), Image.Resampling.LANCZOS)
    rgb = np.asarray(image, dtype=np.float32)
    gray = (
        0.2126 * rgb[:, :, 0]
        + 0.7152 * rgb[:, :, 1]
        + 0.0722 * rgb[:, :, 2]
    )
    return rgb, gray


def average_hash(gray: np.ndarray) -> np.ndarray:
    image = Image.fromarray(np.clip(gray, 0, 255).astype(np.uint8))
    small = np.asarray(
        image.resize((8, 8), Image.Resampling.LANCZOS),
        dtype=np.float32,
    )
    return small > small.mean()


def frame_metric(
    frame_index: int,
    timestamp: float,
    filename: str,
    rgb: np.ndarray,
    gray: np.ndarray,
    transcript: str,
) -> FrameMetric:
    maximum = rgb.max(axis=2)
    minimum = rgb.min(axis=2)
    saturation = np.divide(
        maximum - minimum,
        np.maximum(maximum, 1),
        out=np.zeros_like(maximum),
        where=maximum > 0,
    )
    dx = np.abs(np.diff(gray, axis=1))
    dy = np.abs(np.diff(gray, axis=0))
    edge_density = float(
        (np.count_nonzero(dx > 22) + np.count_nonzero(dy > 22))
        / (dx.size + dy.size)
    )
    return FrameMetric(
        frame_index=frame_index,
        timestamp_seconds=round(timestamp, 6),
        filename=filename,
        mean_luma=round(float(gray.mean()), 4),
        black_ratio=round(float(np.mean(gray < 24)), 6),
        white_ratio=round(float(np.mean(gray > 232)), 6),
        mean_saturation=round(float(saturation.mean()), 6),
        edge_density=round(edge_density, 6),
        active_transcript=transcript,
    )


def classify_transition(
    gray_mae: float,
    rgb_mae: float,
    hash_distance: int,
    changed_area_ratio: float,
) -> str:
    if gray_mae >= 42 or rgb_mae >= 48 or hash_distance >= 31:
        return "hard_cut_or_full_frame_transition"
    if gray_mae >= 24 or rgb_mae >= 28 or hash_distance >= 22:
        return "major_composition_change"
    if changed_area_ratio >= 0.18 or gray_mae >= 11:
        return "motion_text_build_or_camera_change"
    return "hold_or_subtle_motion"


def transition_metric(
    from_index: int,
    to_index: int,
    from_time: float,
    to_time: float,
    previous_rgb: np.ndarray,
    previous_gray: np.ndarray,
    current_rgb: np.ndarray,
    current_gray: np.ndarray,
) -> TransitionMetric:
    height = min(previous_gray.shape[0], current_gray.shape[0])
    width = min(previous_gray.shape[1], current_gray.shape[1])
    before_gray = previous_gray[:height, :width]
    after_gray = current_gray[:height, :width]
    before_rgb = previous_rgb[:height, :width]
    after_rgb = current_rgb[:height, :width]
    difference = np.abs(after_gray - before_gray)
    changed = difference > 22
    ys, xs = np.nonzero(changed)
    changed_area_ratio = float(np.mean(changed))
    centroid_x = float(xs.mean() / max(width - 1, 1)) if xs.size else None
    centroid_y = float(ys.mean() / max(height - 1, 1)) if ys.size else None
    gray_mae = float(difference.mean())
    rgb_mae = float(np.abs(after_rgb - before_rgb).mean())
    hash_distance = int(
        np.count_nonzero(average_hash(before_gray) != average_hash(after_gray)),
    )
    return TransitionMetric(
        from_frame=from_index,
        to_frame=to_index,
        from_seconds=round(from_time, 6),
        to_seconds=round(to_time, 6),
        gray_mae=round(gray_mae, 4),
        rgb_mae=round(rgb_mae, 4),
        hash_distance=hash_distance,
        changed_area_ratio=round(changed_area_ratio, 6),
        motion_centroid_x=round(centroid_x, 6) if centroid_x is not None else None,
        motion_centroid_y=round(centroid_y, 6) if centroid_y is not None else None,
        classification=classify_transition(
            gray_mae,
            rgb_mae,
            hash_distance,
            changed_area_ratio,
        ),
    )


def analyze_frames(
    frames: Sequence[Path],
    sample_fps: float,
    segments: Sequence[tuple[float, float, str]],
) -> tuple[list[FrameMetric], list[TransitionMetric]]:
    frame_metrics: list[FrameMetric] = []
    transitions: list[TransitionMetric] = []
    previous_rgb: np.ndarray | None = None
    previous_gray: np.ndarray | None = None
    for offset, frame_path in enumerate(frames):
        frame_index = offset + 1
        timestamp = offset / sample_fps
        rgb, gray = load_analysis_image(frame_path)
        frame_metrics.append(
            frame_metric(
                frame_index,
                timestamp,
                frame_path.name,
                rgb,
                gray,
                transcript_at(timestamp, segments),
            ),
        )
        if previous_rgb is not None and previous_gray is not None:
            transitions.append(
                transition_metric(
                    frame_index - 1,
                    frame_index,
                    (offset - 1) / sample_fps,
                    timestamp,
                    previous_rgb,
                    previous_gray,
                    rgb,
                    gray,
                ),
            )
        previous_rgb = rgb
        previous_gray = gray
    return frame_metrics, transitions


def font_for_labels() -> ImageFont.ImageFont:
    candidates = [
        Path("C:/Windows/Fonts/arial.ttf"),
        Path("C:/Windows/Fonts/segoeui.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), 18)
    return ImageFont.load_default()


def contact_sheet(
    frames: Sequence[Path],
    start_index: int,
    sample_fps: float,
    columns: int,
    tile_width: int,
) -> Image.Image:
    font = font_for_labels()
    tiles: list[Image.Image] = []
    for local_index, frame_path in enumerate(frames):
        image = Image.open(frame_path).convert("RGB")
        ratio = tile_width / image.width
        tile_height = max(1, round(image.height * ratio))
        image = image.resize((tile_width, tile_height), Image.Resampling.LANCZOS)
        draw = ImageDraw.Draw(image)
        global_offset = start_index + local_index
        label = f"#{global_offset + 1:03d}  {global_offset / sample_fps:06.3f}s"
        box = draw.textbbox((0, 0), label, font=font)
        draw.rectangle(
            (4, 4, box[2] - box[0] + 14, box[3] - box[1] + 13),
            fill=(0, 0, 0),
        )
        draw.text((9, 7), label, font=font, fill=(255, 255, 255))
        tiles.append(image)
    rows = math.ceil(len(tiles) / columns)
    tile_height = tiles[0].height
    margin = 4
    canvas = Image.new(
        "RGB",
        (
            columns * tile_width + (columns + 1) * margin,
            rows * tile_height + (rows + 1) * margin,
        ),
        "black",
    )
    for index, tile in enumerate(tiles):
        x = margin + (index % columns) * (tile_width + margin)
        y = margin + (index // columns) * (tile_height + margin)
        canvas.paste(tile, (x, y))
    return canvas


def write_contact_sheets(
    frames: Sequence[Path],
    output: Path,
    sample_fps: float,
    sheet_seconds: float,
) -> list[Path]:
    directory = output / "contact-sheets"
    directory.mkdir(parents=True)
    frames_per_sheet = max(1, round(sample_fps * sheet_seconds))
    created: list[Path] = []
    for start in range(0, len(frames), frames_per_sheet):
        subset = frames[start : start + frames_per_sheet]
        start_seconds = start / sample_fps
        end_seconds = (start + len(subset)) / sample_fps
        sheet = contact_sheet(
            subset,
            start,
            sample_fps,
            columns=5,
            tile_width=320,
        )
        destination = directory / (
            f"sheet_{start_seconds:06.2f}_{end_seconds:06.2f}.jpg"
        )
        sheet.save(destination, quality=92)
        created.append(destination)
    overview = contact_sheet(
        frames,
        0,
        sample_fps,
        columns=15,
        tile_width=192,
    )
    overview_path = directory / "overview.jpg"
    overview.save(overview_path, quality=90)
    created.append(overview_path)
    return created


def write_csv(path: Path, frames: Sequence[FrameMetric]) -> None:
    rows = [asdict(frame) for frame in frames]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def extract_audio(
    ffmpeg: str,
    source: Path,
    duration: float,
    sample_rate: int = 16_000,
) -> np.ndarray:
    raw = run_bytes(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-t",
            f"{duration:.9f}",
            "-map",
            "0:a:0?",
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "-f",
            "f32le",
            "pipe:1",
        ],
    )
    return np.frombuffer(raw, dtype="<f4").copy()


def dbfs(value: float) -> float:
    return max(-120.0, 20 * math.log10(max(value, 1e-6)))


def classify_audio(rms_dbfs: float, silence_db: float) -> str:
    if rms_dbfs <= silence_db:
        return "silence_candidate"
    if rms_dbfs <= -30:
        return "low"
    if rms_dbfs <= -12:
        return "active"
    return "peak"


def analyze_audio(
    samples: np.ndarray,
    sample_rate: int,
    silence_db: float,
    silence_min_seconds: float,
    window_seconds: float = 0.05,
) -> tuple[list[AudioWindow], list[SilenceInterval], dict[str, Any]]:
    if samples.size == 0:
        return [], [], {
            "available": False,
            "sampleRate": sample_rate,
            "durationSeconds": 0,
            "integratedRmsDbfs": None,
            "peakDbfs": None,
            "activeRatio": 0,
            "silenceRatio": 0,
        }
    window_size = max(1, round(sample_rate * window_seconds))
    windows: list[AudioWindow] = []
    for start in range(0, samples.size, window_size):
        chunk = samples[start : start + window_size].astype(np.float64)
        if chunk.size == 0:
            continue
        rms = float(np.sqrt(np.mean(np.square(chunk))))
        peak = float(np.max(np.abs(chunk)))
        rms_dbfs = dbfs(rms)
        windows.append(
            AudioWindow(
                start_seconds=round(start / sample_rate, 6),
                end_seconds=round((start + chunk.size) / sample_rate, 6),
                rms_dbfs=round(rms_dbfs, 3),
                peak_dbfs=round(dbfs(peak), 3),
                classification=classify_audio(rms_dbfs, silence_db),
            ),
        )

    silences: list[SilenceInterval] = []
    group: list[AudioWindow] = []
    for window in [*windows, None]:
        if window is not None and window.classification == "silence_candidate":
            group.append(window)
            continue
        if group:
            start = group[0].start_seconds
            end = group[-1].end_seconds
            if end - start + 1e-9 >= silence_min_seconds:
                silences.append(
                    SilenceInterval(
                        start_seconds=start,
                        end_seconds=end,
                        duration_seconds=round(end - start, 6),
                        mean_rms_dbfs=round(
                            float(np.mean([item.rms_dbfs for item in group])),
                            3,
                        ),
                    ),
                )
            group = []

    duration = samples.size / sample_rate
    silence_duration = sum(item.duration_seconds for item in silences)
    overall_rms = float(
        np.sqrt(np.mean(np.square(samples.astype(np.float64)))),
    )
    summary = {
        "available": True,
        "sampleRate": sample_rate,
        "durationSeconds": round(duration, 6),
        "windowSeconds": window_seconds,
        "silenceThresholdDbfs": silence_db,
        "minimumSilenceSeconds": silence_min_seconds,
        "integratedRmsDbfs": round(dbfs(overall_rms), 3),
        "peakDbfs": round(dbfs(float(np.max(np.abs(samples)))), 3),
        "activeRatio": round(max(0.0, 1 - silence_duration / duration), 6),
        "silenceRatio": round(min(1.0, silence_duration / duration), 6),
        "silenceCount": len(silences),
        "silenceDurationSeconds": round(silence_duration, 6),
    }
    return windows, silences, summary


def write_audio_csv(path: Path, windows: Sequence[AudioWindow]) -> None:
    if not windows:
        path.write_text(
            "start_seconds,end_seconds,rms_dbfs,peak_dbfs,classification\n",
            encoding="utf-8",
        )
        return
    rows = [asdict(window) for window in windows]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def write_waveform(
    path: Path,
    samples: np.ndarray,
    sample_rate: int,
    silences: Sequence[SilenceInterval],
) -> None:
    width = 1800
    height = 360
    image = Image.new("RGB", (width, height), "#101216")
    draw = ImageDraw.Draw(image)
    font = font_for_labels()
    duration = samples.size / sample_rate if samples.size else 0
    if duration <= 0:
        draw.text((20, 20), "No audio stream", font=font, fill="white")
        image.save(path)
        return
    for silence in silences:
        left = round(silence.start_seconds / duration * (width - 1))
        right = round(silence.end_seconds / duration * (width - 1))
        draw.rectangle((left, 0, max(left + 1, right), height), fill="#352326")
    center = height // 2
    draw.line((0, center, width, center), fill="#5a626f", width=1)
    samples_per_column = max(1, math.ceil(samples.size / width))
    for x in range(width):
        chunk = samples[
            x * samples_per_column : min(samples.size, (x + 1) * samples_per_column)
        ]
        if chunk.size == 0:
            continue
        amplitude = min(1.0, float(np.max(np.abs(chunk))))
        half = max(1, round(amplitude * (height * 0.44)))
        draw.line((x, center - half, x, center + half), fill="#58c9b9")
    for second in range(0, math.ceil(duration) + 1, 5):
        x = round(second / duration * (width - 1))
        draw.line((x, height - 24, x, height), fill="#818896", width=1)
        draw.text((x + 4, height - 25), f"{second}s", font=font, fill="white")
    image.save(path)


def write_summary(
    path: Path,
    source: Path,
    frames: Sequence[FrameMetric],
    transitions: Sequence[TransitionMetric],
    sample_fps: float,
    duration: float,
    audio_summary: dict[str, Any],
    silences: Sequence[SilenceInterval],
    scene_cuts: Sequence[SceneCutCandidate],
    scene_threshold: float,
    transcript_gaps: Sequence[SpeechGap],
) -> None:
    counts: dict[str, int] = {}
    for transition in transitions:
        counts[transition.classification] = (
            counts.get(transition.classification, 0) + 1
        )
    strongest = sorted(
        transitions,
        key=lambda item: (item.rgb_mae, item.hash_distance),
        reverse=True,
    )[:20]
    lines = [
        "# Reference video frame analysis",
        "",
        f"- Source: `{source}`",
        f"- Sample: {sample_fps:g} frames/second for {duration:g} seconds",
        f"- Frames: {len(frames)}",
        f"- Consecutive transitions analyzed: {len(transitions)}",
        f"- Native-frame scene candidates: {len(scene_cuts)} at threshold "
        f"{scene_threshold:g}",
        "",
        "## Automatic transition inventory",
        "",
    ]
    for key in sorted(counts):
        lines.append(f"- `{key}`: {counts[key]}")
    lines.extend(["", "## Audio inventory", ""])
    if audio_summary.get("available"):
        lines.extend(
            [
                f"- Integrated RMS: {audio_summary['integratedRmsDbfs']:.1f} dBFS",
                f"- Peak: {audio_summary['peakDbfs']:.1f} dBFS",
                f"- Reported silence: {audio_summary['silenceDurationSeconds']:.2f}s "
                f"({audio_summary['silenceRatio']:.1%}) across "
                f"{audio_summary['silenceCount']} intervals",
                f"- Silence rule: <= {audio_summary['silenceThresholdDbfs']:.1f} dBFS "
                f"for >= {audio_summary['minimumSilenceSeconds']:.2f}s",
                "",
                "| Start | End | Duration | Mean RMS |",
                "| ---: | ---: | ---: | ---: |",
            ],
        )
        for silence in sorted(
            silences,
            key=lambda item: item.duration_seconds,
            reverse=True,
        )[:30]:
            lines.append(
                f"| {silence.start_seconds:.3f}s | {silence.end_seconds:.3f}s | "
                f"{silence.duration_seconds:.3f}s | {silence.mean_rms_dbfs:.1f} dBFS |",
            )
    else:
        lines.append("- No audio stream was available.")
    lines.extend(["", "## Transcript speech-gap inventory", ""])
    if transcript_gaps:
        gap_duration = sum(item.duration_seconds for item in transcript_gaps)
        lines.extend(
            [
                f"- Word-timed gaps: {len(transcript_gaps)} totaling "
                f"{gap_duration:.2f}s",
                "- These are transcript-derived speech candidates, independent "
                "of music or other sounds in the master mix.",
                "",
                "| Start | End | Duration | Previous | Next |",
                "| ---: | ---: | ---: | --- | --- |",
            ],
        )
        for gap in sorted(
            transcript_gaps,
            key=lambda item: item.duration_seconds,
            reverse=True,
        )[:30]:
            lines.append(
                f"| {gap.start_seconds:.3f}s | {gap.end_seconds:.3f}s | "
                f"{gap.duration_seconds:.3f}s | "
                f"{gap.previous_word or 'START'} | {gap.next_word or 'END'} |",
            )
    else:
        lines.append("- No word-timed transcript gaps were available.")
    lines.extend(["", "## Native-frame scene candidates", ""])
    if scene_cuts:
        lines.append(
            "- "
            + ", ".join(f"{item.timestamp_seconds:.3f}s" for item in scene_cuts),
        )
    else:
        lines.append("- None at the selected threshold.")
    lines.extend(
        [
            "",
            "## Strongest visual changes",
            "",
            "| From | To | RGB MAE | Hash Δ | Changed area | Classification |",
            "| ---: | ---: | ---: | ---: | ---: | --- |",
        ],
    )
    for item in strongest:
        lines.append(
            "| "
            f"{item.from_seconds:.3f}s | {item.to_seconds:.3f}s | "
            f"{item.rgb_mae:.2f} | {item.hash_distance} | "
            f"{item.changed_area_ratio:.1%} | `{item.classification}` |",
        )
    lines.extend(
        [
            "",
            "Automatic classifications are evidence for review, not semantic truth. "
            "Use the labeled contact sheets to describe the editorial meaning of "
            "each change and the transcript alignment.",
            "",
        ],
    )
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    args = parse_args()
    validate_inputs(args)
    ffmpeg = resolve_executable(args.ffmpeg)
    ffprobe = resolve_executable(args.ffprobe)
    source = args.input.resolve()
    output = args.output.resolve()
    prepare_output(output, args.overwrite)
    metadata = probe_video(ffprobe, source)
    available_duration = source_video_duration(metadata)
    duration = min(args.duration or available_duration, available_duration)
    if duration * args.sample_fps < 1:
        raise ValueError("Selected duration is too short for the requested sample rate")
    frames = extract_frames(
        ffmpeg,
        source,
        output,
        duration,
        args.sample_fps,
    )
    segments = transcript_segments(args.transcript_json)
    words = transcript_words(args.transcript_json)
    transcript_gaps = speech_gaps(
        words,
        duration,
        args.silence_min_seconds,
    )
    scene_cuts = detect_scene_cuts(
        ffmpeg,
        source,
        duration,
        args.scene_threshold,
    )
    frame_metrics, transitions = analyze_frames(
        frames,
        args.sample_fps,
        segments,
    )
    sheets = write_contact_sheets(
        frames,
        output,
        args.sample_fps,
        args.sheet_seconds,
    )
    write_csv(output / "frames.csv", frame_metrics)
    (output / "transitions.json").write_text(
        json.dumps([asdict(item) for item in transitions], indent=2),
        encoding="utf-8",
    )
    (output / "scene-cuts.json").write_text(
        json.dumps([asdict(item) for item in scene_cuts], indent=2),
        encoding="utf-8",
    )
    (output / "speech-gaps.json").write_text(
        json.dumps([asdict(item) for item in transcript_gaps], indent=2),
        encoding="utf-8",
    )
    audio_sample_rate = 16_000
    audio_samples = extract_audio(ffmpeg, source, duration, audio_sample_rate)
    audio_windows, silences, audio_summary = analyze_audio(
        audio_samples,
        audio_sample_rate,
        args.silence_db,
        args.silence_min_seconds,
    )
    write_audio_csv(output / "audio-windows.csv", audio_windows)
    (output / "audio-analysis.json").write_text(
        json.dumps(
            {
                "summary": audio_summary,
                "silences": [asdict(item) for item in silences],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    write_waveform(
        output / "audio-waveform.png",
        audio_samples,
        audio_sample_rate,
        silences,
    )
    manifest = {
        "schemaVersion": 3,
        "source": {
            "path": str(source),
            "sha256": sha256_file(source),
            "probe": metadata,
        },
        "sample": {
            "requestedDurationSeconds": args.duration,
            "sourceVideoDurationSeconds": available_duration,
            "durationSeconds": duration,
            "framesPerSecond": args.sample_fps,
            "expectedFrameCount": expected_frame_count(
                duration,
                args.sample_fps,
            ),
            "frameCount": len(frames),
            "transitionCount": len(transitions),
        },
        "transcript": {
            "path": str(args.transcript_json.resolve())
            if args.transcript_json
            else None,
            "segmentCount": len(segments),
            "wordCount": len(words),
            "speechGapCount": len(transcript_gaps),
        },
        "artifacts": {
            "frames": "frames/",
            "frameMetrics": "frames.csv",
            "transitions": "transitions.json",
            "sceneCuts": "scene-cuts.json",
            "speechGaps": "speech-gaps.json",
            "audioWindows": "audio-windows.csv",
            "audioAnalysis": "audio-analysis.json",
            "audioWaveform": "audio-waveform.png",
            "contactSheets": [
                str(sheet.relative_to(output)).replace("\\", "/") for sheet in sheets
            ],
            "summary": "analysis.md",
        },
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )
    write_summary(
        output / "analysis.md",
        source,
        frame_metrics,
        transitions,
        args.sample_fps,
        duration,
        audio_summary,
        silences,
        scene_cuts,
        args.scene_threshold,
        transcript_gaps,
    )
    print(
        json.dumps(
            {
                "output": str(output),
                "frames": len(frames),
                "transitions": len(transitions),
                "sceneCuts": len(scene_cuts),
                "speechGaps": len(transcript_gaps),
                "silences": len(silences),
                "contactSheets": len(sheets),
            },
        ),
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
