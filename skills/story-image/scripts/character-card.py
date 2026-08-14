#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""character-card.py — 从 `设定/角色/{名}.md` 提取角色卡图（char-sheet）需要的生图素材。

把角色卡 6 大标题制的内容解析为结构化字段，供 prompt-template.py 的 char-sheet 直接消费。
解析只读不写；缺失字段返回空串/空列表，由调用方决定省略对应模块。

用法：
  python character-card.py <角色卡路径> [--json] [--lang en|zh]

输出（默认人类可读，--json 输出机器可读）：
  name       角色名（文件 H1 `# 角色卡：{名}（定位）` 或文件名）
  pinyin     拼音（--pinyin 需另行传入，卡内无拼音字段）
  identity   身份标签（基础信息「身份标签」行）
  personality 性格关键词（「性格关键词」行）
  info       基本信息面板 k=v 列表（姓名/年龄/身份/气质 等「基础信息」标题下字段行）
  face/hair/outfit/accessory/extra  形象描述串（「形象与能力」标题下外貌记忆点/分时期表/服饰）
  bio        简介（核心目标 或 核心动机 行）
  tags       关键词标签（性格关键词拆分）

「形象与能力」的解析策略（按出现顺序取第一个非空）：
  1. 外貌记忆点：行 → face
  2. 分时期表/列表：首行描述 → hair/outfit 尽力归类（含 发/头/髻/辫 → hair；含 衣/服/裙/袍/甲 → outfit）
  3. 服饰描述自由文本 → outfit
  4. 形象图行（`形象图：`）跳过——它是生成记录不是描述素材
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def parse_character_card(path: Path) -> dict:
    """解析角色卡 markdown 为结构化字段（值均为 str 或 list[str]）。"""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()

    result = {
        "name": "",
        "identity": "",
        "personality": "",
        "info": {},          # k -> v（基础信息字段行）
        "face": "",
        "hair": "",
        "outfit": "",
        "accessory": "",
        "extra": "",
        "bio": "",
        "tags": [],
    }

    # 角色名：H1 `# 角色卡：{名}（定位）` 优先，否则文件名（去 .md）
    name_match = re.search(r"^#\s+角色卡[:：]\s*([^（(]+)", text, re.MULTILINE)
    if name_match:
        result["name"] = name_match.group(1).strip()
    else:
        result["name"] = path.stem.strip()

    # 小节分类：哪些标题属于「形象素材」来源（6 大标题制 + 旧版兼容）
    IMAGE_SECTIONS = {"形象与能力", "外在表现", "外貌", "外形"}
    INFO_SECTIONS = {"基础信息", "基本信息", "人物信息"}
    # 当前所在标题（用于把字段行归到对应类别）
    current_section = ""
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("```") or stripped.startswith(">"):
            continue
        heading = re.match(r"^#{2,6}\s+(.+?)\s*$", stripped)
        if heading:
            current_section = heading.group(1).strip()
            continue

        # 字段行：`字段名：值` / `- 字段名：值` / `**字段名**：值`（旧版粗体头）
        field_match = re.match(r"^\s*(?:-\s*)?\*\*?([^：:*]+?)\*?\s*[：:]\s*(.+)$", stripped)
        if not field_match:
            field_match = re.match(r"^([^：:]+?)\s*[：:]\s*(.+)$", stripped)
        if not field_match:
            continue
        key, value = field_match.group(1).strip(), field_match.group(2).strip()
        value = re.sub(r"[（(].*?[)）]", "", value).strip()  # 去「结论（补充）」的补充段
        if not value:
            continue

        if current_section in INFO_SECTIONS:
            result["info"][key] = value
            if key in ("身份标签", "身份"):
                result["identity"] = value
            elif key in ("性格关键词", "性格"):
                result["personality"] = value
                result["tags"] = [t.strip() for t in re.split(r"[、,，/]", value) if t.strip()]
            elif key in ("核心目标", "目标") and not result["bio"]:
                result["bio"] = value
            elif key in ("核心动机", "动机") and not result["bio"]:
                result["bio"] = value

        elif current_section in IMAGE_SECTIONS:
            if key in ("形象图", "形象图路径", "生成记录"):
                continue  # 生成记录，不是描述素材
            if key in ("外貌记忆点", "外貌", "记忆点", "长相"):
                result["face"] = value
            elif key in ("服饰", "服装", "穿着"):
                result["outfit"] = value
            elif key in ("发型", "头发"):
                result["hair"] = value
            elif key in ("饰品", "配饰", "道具"):
                result["accessory"] = value
            else:
                # 其他字段行尽力归类（含旧版 `**身份/外貌**` 这类合并键）
                if re.search(r"发|头|髻|辫", key):
                    result["hair"] = value
                elif re.search(r"衣|服|裙|袍|甲|装", key):
                    result["outfit"] = value
                elif re.search(r"外貌", key) and not result["face"]:
                    result["face"] = value
                elif re.search(r"饰|坠|链|戒|簪|环", key):
                    result["accessory"] = value
                elif key in ("行为习惯", "标志动作"):
                    pass  # 非形象素材，跳过
                else:
                    result["extra"] = value

    # 分时期表：`| 时期 | 外形/能力/身份 | 记忆点 |` 行（取第一行数据）
    period_rows = [
        line.strip() for line in lines
        if re.match(r"^\|\s*[^|]+\|[^|]+\|[^|]+\|\s*$", line.strip())
        and "时期" not in line and "外形" not in line and "记忆点" not in line
    ]
    if period_rows and not (result["face"] and result["outfit"]):
        cells = [c.strip() for c in period_rows[0].strip("|").split("|")]
        if len(cells) >= 2:
            desc = cells[1]
            if not result["face"]:
                result["face"] = desc
            elif not result["outfit"]:
                result["outfit"] = desc

    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="从角色卡提取 char-sheet 生图素材")
    ap.add_argument("card", type=Path, help="设定/角色/{名}.md 路径")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--lang", choices=("en", "zh"), default="zh", help="人类可读输出语言（默认 zh）")
    args = ap.parse_args()

    if not args.card.is_file():
        print(f"角色卡不存在: {args.card}", file=sys.stderr)
        return 1

    data = parse_character_card(args.card)
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0

    # 人类可读摘要
    print(f"角色名: {data['name']}")
    if data["identity"]:
        print(f"身份: {data['identity']}")
    if data["personality"]:
        print(f"性格: {data['personality']}")
    if data["info"]:
        print("基本信息面板:")
        for k, v in data["info"].items():
            print(f"  {k}: {v}")
    for label, key in (("面部", "face"), ("发型", "hair"), ("服饰", "outfit"), ("饰品", "accessory"), ("其他", "extra")):
        if data[key]:
            print(f"{label}: {data[key]}")
    if data["bio"]:
        print(f"简介: {data['bio']}")
    if data["tags"]:
        print(f"关键词: {'、'.join(data['tags'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
