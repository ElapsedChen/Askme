"""对无文本的 PDF 页执行有界、本地 CPU OCR；失败保留原始缺口。"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

MAX_OCR_PAGES = 8
MAX_PIXELS = 1_500_000
MAX_INPUT = 100_000_000
MAX_TEXT = 100_000
TOTAL_TIMEOUT = 18.0
ROOT = Path(__file__).resolve().parent
HIDDEN = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def _status(value: str) -> dict:
    return {"engine": "tesseract.js", "status": value, "languages": ["eng", "chi_sim"]}


def _stop_tree(process: subprocess.Popen) -> None:
    # Windows 上先停止整个子树，不能先杀父进程而遗留 OCR worker。
    if process.poll() is None and os.name == "nt":
        try:
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=2, creationflags=HIDDEN, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass
    if process.poll() is None:
        process.kill()


def enrich_empty_pdf_pages(data: bytes, parts: list[dict], total_timeout: float = TOTAL_TIMEOUT) -> list[dict]:
    """原地补全 parts；number 始终是 PDF 实体页码，已有文字/确定空白页不处理。

    recognized 表示通过保守词级阈值；partial 的残词不写入可检索正文。
    OCR 只识别文字，不代表图表、照片的视觉含义已经读取。
    """
    candidates = [item for item in parts if not str(item.get("text", "")).strip()
                  and not item.get("blankKind")]
    for item in candidates:
        item["ocr"] = _status("page-budget")
    selected = candidates[:MAX_OCR_PAGES]
    if not selected:
        return parts
    if not data or len(data) > MAX_INPUT:
        for item in selected:
            item["ocr"] = _status("input-limit")
        return parts
    node = shutil.which("node")
    runtime = ROOT / "ocr-runtime" / "node_modules"
    if not node or not (runtime / "tesseract.js" / "src" / "index.js").is_file():
        for item in selected:
            item["ocr"] = _status("unavailable")
        return parts
    budget = max(0.1, min(float(total_timeout), TOTAL_TIMEOUT))
    numbers = [int(item["number"]) for item in selected]
    command = [sys.executable, str(Path(__file__).resolve()), "--worker", node,
               json.dumps(numbers), str(max(0.05, budget - 0.5))]
    process = None
    output = b""
    fallback = "failed"
    try:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, creationflags=HIDDEN)
        output, _ = process.communicate(data, timeout=budget)
    except subprocess.TimeoutExpired:
        fallback = "timeout"
        _stop_tree(process)
        try:
            output, _ = process.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            output = b""
    except OSError:
        fallback = "unavailable"
    finally:
        if process is not None and process.poll() is None:
            _stop_tree(process)
    by_number = {}
    # worker 输出仅包含每页受限的结果；日志和损坏记录不能混入课程材料。
    for line in output[:2_000_000].splitlines():
        try:
            record = json.loads(line)
            if isinstance(record, dict) and record.get("number") in numbers:
                by_number[record["number"]] = record
        except (ValueError, TypeError):
            continue
    for item in selected:
        record = by_number.get(item["number"])
        if not record or not isinstance(record.get("ocr"), dict):
            item["ocr"] = _status(fallback)
            continue
        item["ocr"] = record["ocr"]
        text = " ".join(str(record.get("text", "")).split())
        if text and record["ocr"].get("status") == "recognized":
            item["text"] = text[:MAX_TEXT]
            item["truncated"] = len(text) > MAX_TEXT or bool(record.get("truncated"))
            item["extractionMethod"] = "ocr"
            item["ocrConfidence"] = record["ocr"].get("confidence")
    return parts


def _emit(record: dict) -> None:
    print(json.dumps(record, ensure_ascii=True), flush=True)


def _worker(node: str, numbers: list[int], budget: float) -> None:
    import fitz
    from PIL import Image, ImageChops

    deadline = time.monotonic() + budget
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT:
        return
    with fitz.open(stream=data, filetype="pdf") as document, tempfile.TemporaryDirectory(prefix="askme-ocr-") as temporary:
        images = []
        for number in numbers[:MAX_OCR_PAGES]:
            if time.monotonic() >= deadline:
                _emit({"number": number, "ocr": _status("timeout")})
                continue
            try:
                page = document[number - 1]
                # 独立 worker 再次确认，禁止调用方误把已有文本页送入 OCR。
                if page.get_text().strip():
                    _emit({"number": number, "ocr": _status("text-already-present")})
                    continue
                width, height = page.rect.width, page.rect.height
                if not all(math.isfinite(value) and value > 0 for value in (width, height)):
                    raise ValueError("invalid page bounds")
                scale = min(2.5, math.sqrt((MAX_PIXELS - 5000) / (width * height)), 4000 / max(width, height))
                pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
                if pixmap.width * pixmap.height > MAX_PIXELS:
                    raise ValueError("pixel budget exceeded")
                path = Path(temporary) / f"page-{number}.png"
                pixmap.save(str(path))
                entry = {"number": number, "path": str(path)}
                # 额外保留黑字通道：最大 RGB 通道使亮红线/黄色背景变白，原彩色图仍是首选。
                if deadline - time.monotonic() >= 1:
                    rgb = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
                    red, green, blue = rgb.split()
                    brightest = ImageChops.lighter(ImageChops.lighter(red, green), blue)
                    neutral = brightest.point([0 if value < 150 else 255 for value in range(256)])
                    alternate = Path(temporary) / f"page-{number}-dark-text.png"
                    neutral.save(str(alternate))
                    entry["alternatePath"] = str(alternate)
                images.append(entry)
            except Exception:
                _emit({"number": number, "ocr": _status("render-failed")})
        remaining = deadline - time.monotonic()
        if not images or remaining <= 0.1:
            for entry in images:
                _emit({"number": entry["number"], "ocr": _status("timeout")})
            return
        manifest = Path(temporary) / "pages.json"
        manifest.write_text(json.dumps({"pages": images, "timeoutMs": int(remaining * 1000)}), encoding="utf-8")
        # Node 自身设置计时器并退出整个进程，线程型 Tesseract worker 同时终止。
        child = subprocess.Popen([node, "--max-old-space-size=256", str(ROOT / "pdf_ocr_worker.mjs"), str(manifest)],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=HIDDEN)
        try:
            for line in child.stdout:
                if len(line) <= 250_000:
                    sys.stdout.buffer.write(line)
                    sys.stdout.buffer.flush()
            child.wait(timeout=max(0.1, deadline - time.monotonic()))
        finally:
            _stop_tree(child)


if __name__ == "__main__" and len(sys.argv) == 5 and sys.argv[1] == "--worker":
    _worker(sys.argv[2], json.loads(sys.argv[3]), float(sys.argv[4]))
