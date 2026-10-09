"""Publish explicitly selected host audio without changing any project IDs.

Usage: python3 scripts/import-global-audio.py --catalog catalog.json
  --legacy-account-id UUID [--legacy-library-dir PATH] [--apply]
Catalog audioAssets contain sourceFile plus metadata/license evidence.
Without --apply this validates and reports only. No account credentials are read.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import uuid


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare(root, catalog, account_id, legacy_dir=None):
    assets = []
    if account_id:
        if not re.fullmatch(r"[a-fA-F0-9-]{36}", account_id):
            raise ValueError("Expected explicit legacy account UUID")
        private = root / "data" / account_id / "shared-library"
        manifest = json.loads((private / "manifest.json").read_text())
        for item in manifest["audioAssets"]:
            item = dict(item)
            file = private / "audio" / item["folder"] / item["fileName"]
            if not file.exists() and legacy_dir:
                file = legacy_dir / "files" / "audio" / item["id"]
            item["sourceFile"] = str(file)
            item["license"] = {
                "status": "needs-review",
                "note": "Commercial use may require licensing. Review the original source and permissions before commercial distribution.",
            }
            assets.append(item)
    if catalog:
        assets.extend(json.loads(catalog.read_text())["audioAssets"])
    prepared = []
    ids = set()
    for item in assets:
        item = dict(item)
        file = Path(item.pop("sourceFile"))
        if file.is_symlink() or not file.is_file():
            raise ValueError(f"Missing or linked source: {file}")
        if item["id"] in ids or not re.fullmatch(r"[a-zA-Z0-9_-]+", item["id"]):
            raise ValueError("Duplicate or invalid audio ID")
        ids.add(item["id"])
        name = item["fileName"]
        if not re.fullmatch(r"[a-zA-Z0-9_-]+\.(mp3|wav|ogg|opus|m4a|aac|flac|aif|aiff|webm)", name):
            raise ValueError("Unsupported audio filename")
        if item["folder"] not in ("sfx", "music"):
            raise ValueError("Invalid audio folder")
        size = file.stat().st_size
        sha = digest(file)
        if not 0 < size <= 100 * 1024 * 1024 or size != item["size"]:
            raise ValueError(f"Size mismatch: {name}")
        if item.get("sha256", sha) != sha:
            raise ValueError(f"Checksum mismatch: {name}")
        license = item.get("license", {})
        if license.get("status") == "commercial-use-verified":
            if license.get("licenseId") != "CC0-1.0" or not license.get("sourcePage") or not license.get("verifiedAt"):
                raise ValueError("Verified catalog items require recorded CC0 source evidence")
        elif license.get("status") != "needs-review":
            raise ValueError("Every audio file requires a license review status")
        item.update(sha256=sha, visibility="global", storageKind="repo",
                    sourceUrl=f"/api/global-assets/shared-library/audio/{item['folder']}/{name}",
                    repositoryPath=f"global/shared-library/audio/{item['folder']}/{name}")
        prepared.append((file, item))
    return prepared


def publish(root, prepared):
    library = root / "global" / "shared-library"
    library.mkdir(parents=True, exist_ok=True)
    lock = library / ".publish.lock"
    with lock.open("x") as stream:
        stream.write(str(os.getpid()))
    try:
        manifest_path = library / "manifest.json"
        existing = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"version": 1, "audioAssets": []}
        records = {item["id"]: item for item in existing["audioAssets"]}
        # Validate all collisions before copying or publishing anything.
        for source, item in prepared:
            target = library / "audio" / item["folder"] / item["fileName"]
            if item["id"] in records and records[item["id"]].get("sha256") != item["sha256"]:
                raise ValueError(f"Global ID has different bytes: {item['id']}")
            if target.exists() and digest(target) != item["sha256"]:
                raise ValueError(f"Global path has different bytes: {target.name}")
        for source, item in prepared:
            target = library / "audio" / item["folder"] / item["fileName"]
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                temporary = target.with_suffix(target.suffix + f".{uuid.uuid4()}.tmp")
                shutil.copyfile(source, temporary)
                if digest(temporary) != item["sha256"]:
                    raise ValueError("Copied audio failed checksum validation")
                temporary.replace(target)
            # Re-running migration must not reset a later human licensing review.
            records.setdefault(item["id"], item)
        if manifest_path.exists():
            shutil.copyfile(manifest_path, library / f"manifest.backup-{uuid.uuid4()}.json")
        temporary = library / f"manifest.{uuid.uuid4()}.tmp"
        temporary.write_text(json.dumps({**existing, "audioAssets": list(records.values())}, ensure_ascii=False, indent=2))
        temporary.replace(manifest_path)
        return len(records)
    finally:
        lock.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accounts-root", type=Path, default=Path(os.environ.get("OPENCUT_ACCOUNTS_DIR", Path.home() / "Movies" / "OpenCut Accounts")))
    parser.add_argument("--catalog", type=Path)
    parser.add_argument("--legacy-account-id")
    parser.add_argument("--legacy-library-dir", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    prepared = prepare(args.accounts_root, args.catalog, args.legacy_account_id, args.legacy_library_dir)
    print(json.dumps({"validated": len(prepared), "music": sum(a["folder"] == "music" for _, a in prepared), "sfx": sum(a["folder"] == "sfx" for _, a in prepared), "published": publish(args.accounts_root, prepared) if args.apply else None}))
