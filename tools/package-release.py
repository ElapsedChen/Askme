from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "extension"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def main() -> None:
    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
    build = manifest["version_name"].split("·", 1)[1].strip()
    target = ROOT / "dist" / f"Askme-{manifest['version']}-build-{build}.zip"
    source_files = sorted(path for path in EXTENSION.rglob("*") if path.is_file())

    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in source_files:
            archive.write(path, path.relative_to(ROOT).as_posix())

    expected = {path.relative_to(ROOT).as_posix(): path.read_bytes() for path in source_files}
    with zipfile.ZipFile(target) as archive:
        archive.testzip()
        names = archive.namelist()
        actual = {name: archive.read(name) for name in names}
    if set(actual) != set(expected):
        raise RuntimeError("ZIP 文件清单与 extension 目录不一致")
    if any(actual[name] != content for name, content in expected.items()):
        raise RuntimeError("ZIP 内容与 extension 目录不一致")

    print(json.dumps({
        "path": target.relative_to(ROOT).as_posix(),
        "sizeBytes": target.stat().st_size,
        "sha256": sha256(target),
        "sourceFileCount": len(source_files),
        "zipFileCount": len(actual),
        "byteForByteMatch": True,
        "zipIntegrity": "passed",
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
