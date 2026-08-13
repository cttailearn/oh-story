#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""analyze.py — story-image 测试产物客观指标分析（不依赖肉眼）。

指标：
  - 宽高比与"理想比例"的偏差（turnaround 期望横版 3:1）
  - 白背景占比（turnaround 期望 > 60%，portrait 不强求但背景应简洁）
  - 文件大小与清晰度粗判（>200KB 为合理图，<50KB 疑似退化/纯色）

用法：python analyze.py <image_path> [--type=portrait|turnaround]
"""
import os
import argparse


def analyze(path):
    try:
        from PIL import Image
    except ImportError:
        return None
    img = Image.open(path).convert("RGB")
    w, h = img.size
    pixels = list(img.getdata())
    n = len(pixels)
    # 白背景占比（RGB 都 >= 240）
    white = sum(1 for r, g, b in pixels if r >= 240 and g >= 240 and b >= 240)
    white_ratio = white / n if n else 0
    aspect = w / h if h else 0
    # 平均颜色（粗判色调）
    avg_r = sum(p[0] for p in pixels) // n
    avg_g = sum(p[1] for p in pixels) // n
    avg_b = sum(p[2] for p in pixels) // n
    size = os.path.getsize(path)
    return {
        "path": path,
        "size_px": f"{w}x{h}",
        "aspect": round(aspect, 3),
        "is_landscape": aspect > 1.2,
        "is_portrait": aspect < 0.83,
        "white_ratio": round(white_ratio, 4),
        "avg_rgb": f"({avg_r},{avg_g},{avg_b})",
        "file_bytes": size,
    }


def interpret(m, image_type):
    if not m:
        return "PIL 不可用"
    notes = []
    if image_type == "turnaround":
        if m["is_landscape"]:
            notes.append("[OK] landscape (matches 3-panel horizontal layout)")
        elif m["is_portrait"]:
            notes.append("[FAIL] portrait orientation -- did NOT follow 3-panel layout")
        else:
            notes.append("[?] near square")
        if m["white_ratio"] >= 0.6:
            notes.append(f"[OK] white bg {m['white_ratio']*100:.1f}%")
        elif m["white_ratio"] >= 0.3:
            notes.append(f"[~] low white bg {m['white_ratio']*100:.1f}% (may be light tone counted as white)")
        else:
            notes.append(f"[FAIL] bg not white ({m['white_ratio']*100:.1f}%)")
    elif image_type == "portrait":
        if m["is_portrait"]:
            notes.append("[OK] portrait orientation")
        if m["white_ratio"] >= 0.3:
            notes.append(f"[~] white/light bg {m['white_ratio']*100:.1f}% (portrait does not require)")
    if m["file_bytes"] < 50000:
        notes.append(f"[WARN] small file ({m['file_bytes']//1024}KB) -- possibly low quality")
    return " | ".join(notes) or "-"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--type", choices=["portrait", "turnaround"])
    args = ap.parse_args()
    for p in args.paths:
        m = analyze(p)
        if not m:
            print(f"{p}: PIL 不可用"); continue
        print(f"=== {p}")
        for k, v in m.items():
            print(f"  {k}: {v}")
        print(f"  评估: {interpret(m, args.type)}")


if __name__ == "__main__":
    main()