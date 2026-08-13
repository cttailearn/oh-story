#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""prompt-template.py — story-image 内置提示词模板（portrait / turnaround / cover / scene）。

封装 references/visual-styles.md 和 image-types.md 的规范，避免每次由 agent 手写模板。

子命令：
  character <类型> <画风> <角色描述串...>   → stdout 输出完整英文提示词
      类型 ∈ {portrait, turnaround, cover, scene}
      画风 ∈ {jinjin, qidian, fanqie, yan, qimao, general}（晋江/起点/番茄/盐言/七猫/通用）

角色描述串建议格式（空格分隔或直接传一整串）：
  "hair=long black hair with straight bangs  eyes=almond eyes with tear mole under left eye
   outfit=red and white hanfu crossed collars wide sleeves  accessory=silver hairpin, white jade earring"
或简洁版："long black hair straight bangs, almond eyes tear mole left, red white hanfu, silver hairpin"
（脚本会智能拆分；详见角色描述解析段）

后端差异（turnaround）：
- 单图三格提示词：依赖模型对布局指令的理解（适合 volcengine/openai/dashscope，ComfyUI 通用工作流也可）
- ComfyUI 三格专用工作流（待用户自选提供）效果更可控
"""
import argparse
import json
import sys


STYLE_TAGS = {
    "jinjin":   ("ancient chinese style, dreamy ethereal aesthetic", "soft pastel tones, flower petals and bokeh, delicate beauty, elegant romantic"),
    "qidian":   ("polished refined illustration, detailed cinematic composition", "epic atmospheric, mature sophisticated style, premium quality, golden hour rim lighting"),
    "fanqie":   ("vibrant saturated colors, eye-catching bold design", "high contrast, character dominating frame, mass-market novel cover style"),
    "yan":      ("minimalist literary style, clean composition with negative space", "subtle moody atmosphere, independent film poster aesthetic"),
    "qimao":    ("warm narrative illustration, detailed environment, retro comic style", "warm earthy palette, comic-influenced shading, vivid storytelling"),
    "general":  ("high detail digital painting", "balanced lighting, clean composition"),
}


def split_features(blob):
    """把描述串拆成 (hair, face, outfit, accessory, extra)。
    接受逗号分隔的短语，每个短语可为 'key: value' / 'key=value'（key 不区分大小写，
    支持 hair/face/eyes/outfit/accessory/extra/prop 等），无前缀归入 extra。
    """
    fields = {"hair": "", "face": "", "outfit": "", "accessory": "", "extra": ""}
    extra_bits = []
    for phrase in blob.split(","):
        phrase = phrase.strip()
        if not phrase:
            continue
        matched = False
        for sep in (":", "="):
            if sep in phrase:
                k, _, v = phrase.partition(sep)
                k = k.strip().lower()
                v = v.strip()
                if k in fields:
                    fields[k] = (fields[k] + " " + v).strip() if fields[k] else v
                    matched = True
                    break
                if k in ("eyes", "eye", "face", "facial", "脸", "面部"):
                    fields["face"] = (fields["face"] + " " + v).strip() if fields["face"] else v
                    matched = True
                    break
                if k in ("clothes", "dress", "clothing", "服装", "服饰"):
                    fields["outfit"] = (fields["outfit"] + " " + v).strip() if fields["outfit"] else v
                    matched = True
                    break
                if k in ("prop", "道具", "饰品", "ornament"):
                    fields["accessory"] = (fields["accessory"] + " " + v).strip() if fields["accessory"] else v
                    matched = True
                    break
        if not matched:
            extra_bits.append(phrase)
    if not (fields["hair"] or fields["face"] or fields["outfit"] or fields["accessory"]) and extra_bits:
        fields["face"] = ", ".join(extra_bits)
        extra_bits = []
    if extra_bits:
        fields["extra"] = ", ".join(extra_bits)
    return fields["hair"], fields["face"], fields["outfit"], fields["accessory"], fields["extra"]


def build_portrait(style, hair, eyes, outfit, accessory, extra):
    style_main, style_atmos = STYLE_TAGS.get(style, STYLE_TAGS["general"])
    parts = [
        f"Character portrait, {style_main}.",
    ]
    if hair: parts.append(f"hair: {hair}.")
    if eyes: parts.append(f"face: {eyes}.")
    if outfit: parts.append(f"outfit: {outfit}.")
    if accessory: parts.append(f"accessory: {accessory}.")
    if extra: parts.append(extra + ".")
    parts.append("half-body portrait, single character, looking at viewer.")
    parts.append(f"background: simple blurred atmospheric scene, {style_atmos}.")
    parts.append("high detail digital painting, no text, no watermark")
    return " ".join(parts)


def build_turnaround(style, hair, eyes, outfit, accessory, extra):
    style_main, style_atmos = STYLE_TAGS.get(style, STYLE_TAGS["general"])
    parts = [
        # 布局指令（v2 强化：明确横版 triptych、左到右、同高、占满画布）
        "horizontal triptych character turnaround reference sheet.",
        "three equal panels arranged side by side from left to right.",
        "panel 1: front view, panel 2: side view, panel 3: back view.",
        "full body in each panel, same height and proportions.",
        "identical character design in all three views: same face, same hair, same outfit, same body type.",
        "standing pose with arms naturally at sides, no action pose.",
        # 白背景强化（v2：多句表达避免被模型忽略）
        "background: solid pure white #FFFFFF, blank canvas, no scenery, no gradient, no shadow.",
        # 题材风格
        f"style: {style_main}.",
    ]
    if hair: parts.append(f"hair: {hair}.")
    if eyes: parts.append(f"face: {eyes}.")
    if outfit: parts.append(f"outfit: {outfit}.")
    if accessory: parts.append(f"accessory: {accessory}.")
    if extra: parts.append(extra + ".")
    parts.append(f"atmosphere: {style_atmos}.")
    parts.append("character design sheet, model sheet, high detail digital illustration, no text, no watermark, no logo")
    return " ".join(parts)


def build_cover(*args, **kw):
    # 留作后续实现（与 image-types.md 的 cover 模板对齐）
    raise NotImplementedError("cover 模板待与 image-types.md 封面模板对齐后补全")


def build_scene(*args, **kw):
    raise NotImplementedError("scene 模板待补")


BUILDERS = {
    "portrait":   build_portrait,
    "turnaround": build_turnaround,
    "cover":      build_cover,
    "scene":      build_scene,
}


def main():
    ap = argparse.ArgumentParser(description="story-image 内置提示词模板")
    ap.add_argument("image_type", choices=list(BUILDERS), help="图像类型")
    ap.add_argument("style", choices=list(STYLE_TAGS), help="画风")
    ap.add_argument("--desc", required=True, help="角色描述串（逗号分隔多短语，可加 hair:/face:/outfit:/accessory: 前缀）")
    args = ap.parse_args()
    hair, eyes, outfit, accessory, extra = split_features(args.desc)
    try:
        prompt = BUILDERS[args.image_type](args.style, hair, eyes, outfit, accessory, extra)
    except NotImplementedError as e:
        print(str(e), file=sys.stderr)
        return 2
    print(prompt)
    return 0


if __name__ == "__main__":
    sys.exit(main())