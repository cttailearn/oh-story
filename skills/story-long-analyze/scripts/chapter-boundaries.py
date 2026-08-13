#!/usr/bin/env python3
"""chapter-boundaries.py — 长篇小说章节边界确定性切片（story-long-analyze Stage 0 子步骤）

用法：python chapter-boundaries.py <原文路径> [--out 输出JSON路径]

功能（与 SKILL.md「Stage 0 章节边界子步骤」契约一致）：
1. 章节正则扫描（中文数字含 千/两 + 阿拉伯/全角数字，覆盖 1000+ 章）
2. 剔目录块：相邻命中行距持续远小于全体中位数的开头连续命中整块丢弃
3. 卷号消歧：多卷书「第一章」重起时标题列保留原样，章号列按全书连续序号重编
4. 输出四列表（章号/标题/起始行/字数）+ 连续性校验

主线程职责：复核 JSON（识别率 <95% 时回退手工流程）、落表到 _progress.md「章节边界」。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

CN_NUM = "零一二三四五六七八九十百千万两"
# 章节标题行：行首可带空白，`第` + 数字（中文/半角/全角）+ 章/回/节/卷
CHAPTER_RE = re.compile(
    rf"^\s*第\s*[{CN_NUM}0-9０-９]+\s*[章回节卷]\s*[：:\s　]*(?P<title>\S.*)?$"
)
# 卷标题行（多卷书消歧辅助）：第X卷
VOLUME_RE = re.compile(
    rf"^\s*第\s*[{CN_NUM}0-9０-９]+\s*卷\s*[：:\s　]*(?P<title>\S.*)?$"
)


def scan(path: Path) -> list[dict]:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    hits = []  # (line_index, kind, raw_title, volume)
    volume = ""
    for i, line in enumerate(lines, 1):
        vm = VOLUME_RE.match(line)
        if vm:
            volume = vm.group("title") or line.strip()
            continue
        cm = CHAPTER_RE.match(line)
        if cm:
            hits.append({"line": i, "title": line.strip(), "volume": volume})
    return hits


def drop_toc(hits: list[dict]) -> list[dict]:
    """剔目录块：开头连续命中行距远小于全体中位数 → 整块丢弃。"""
    if len(hits) < 4:
        return hits
    gaps = [hits[i + 1]["line"] - hits[i]["line"] for i in range(len(hits) - 1)]
    median = sorted(gaps)[len(gaps) // 2]
    if median <= 2:
        return hits
    drop = 0
    for gap in gaps:
        if gap <= max(2, median // 4):  # 目录块行距特征：1-2 行；正文行距远大于此
            drop += 1
        else:
            break
    if drop > 0 and drop < len(hits):
        return hits[drop:]
    return hits


def build_table(path: Path, hits: list[dict]) -> dict:
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    rows = []
    for idx, hit in enumerate(hits):
        start = hit["line"]
        end = hits[idx + 1]["line"] - 1 if idx + 1 < len(hits) else len(lines)
        chars = sum(len(lines[j - 1]) for j in range(start, min(end, len(lines)) + 1))
        rows.append(
            {
                "no": idx + 1,  # 全书连续序号（多卷消歧：不以「第一章」重复计数）
                "title": hit["title"],
                "volume": hit["volume"],
                "start_line": start,
                "chars": chars,
            }
        )
    return {"rows": rows, "total_chapters": len(rows)}


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    src = Path(sys.argv[1])
    if not src.is_file():
        print(f"原文不存在: {src}", file=sys.stderr)
        return 1

    hits = scan(src)
    if not hits:
        print("ERROR: 未识别到任何章节标题行", file=sys.stderr)
        return 1
    hits = drop_toc(hits)
    table = build_table(src, hits)

    # 连续性/重复校验（标题列可能合法重复=多卷，章号列必须连续）
    nos = [r["no"] for r in table["rows"]]
    issues = []
    if nos != list(range(1, len(nos) + 1)):
        issues.append("章号列不连续（内部错误）")
    title_counts: dict[str, int] = {}
    for r in table["rows"]:
        title_counts[r["title"]] = title_counts.get(r["title"], 0) + 1
    dupes = {t: c for t, c in title_counts.items() if c > 1}
    if dupes:
        issues.append(f"重复标题 {len(dupes)} 个（多卷书为合法结构，主线程复核）")

    out = {
        "source": str(src),
        "total_chapters": table["total_chapters"],
        "issues": issues,
        "rows": table["rows"],
    }
    out_path = sys.argv[3] if len(sys.argv) > 3 and sys.argv[2] == "--out" else None
    if out_path:
        Path(out_path).write_text(
            json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
