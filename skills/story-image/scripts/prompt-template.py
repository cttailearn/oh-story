#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""prompt-template.py — story-image 内置提示词模板（char-sheet 角色卡图 / portrait / turnaround / cover / scene）。

封装 references/visual-styles.md 和 image-types.md 的规范，避免每次由 agent 手写模板。

子命令：
  character <类型> <画风> <角色描述串...>   → stdout 输出完整提示词
      类型 ∈ {char-sheet, portrait, turnaround, cover, scene}
      画风 ∈ {jinjin, qidian, fanqie, yan, qimao, general}（晋江/起点/番茄/盐言/七猫/通用）
      语言 ∈ {en, zh}（--lang，默认 en；char-sheet 双语可用）

char-sheet（角色卡图，v3 统一替代 portrait/turnaround）：
  参考表布局——大标题（中文名+拼音+标语）+ 左侧基本信息面板 + 中央 front/side/back 三视图
  + 右上表情网格 + 下方服装/配饰分解 + 底部色板/简介/关键词。模块化拼接，按角色卡
  实际可用字段自动裁剪，避免提示词超长。

角色描述串建议格式（空格分隔或直接传一整串）：
  "hair=long black hair with straight bangs  eyes=almond eyes with tear mole under left eye
   outfit=red and white hanfu crossed collars wide sleeves  accessory=silver hairpin, white jade earring"
或简洁版："long black hair straight bangs, almond eyes tear mole left, red white hanfu, silver hairpin"
（脚本会智能拆分；详见角色描述解析段）

后端差异（三视图）：
- 单图三格提示词：依赖模型对布局指令的理解（适合 volcengine/openai/dashscope，ComfyUI 通用工作流也可）
- ComfyUI 三格专用工作流（待用户自选提供）效果更可控
"""
import argparse
import re
import sys


STYLE_TAGS = {
    "jinjin":   ("ancient chinese style, dreamy ethereal aesthetic", "soft pastel tones, flower petals and bokeh, delicate beauty, elegant romantic"),
    "qidian":   ("polished refined illustration, detailed cinematic composition", "epic atmospheric, mature sophisticated style, premium quality, golden hour rim lighting"),
    "fanqie":   ("vibrant saturated colors, eye-catching bold design", "high contrast, character dominating frame, mass-market novel cover style"),
    "yan":      ("minimalist literary style, clean composition with negative space", "subtle moody atmosphere, independent film poster aesthetic"),
    "qimao":    ("warm narrative illustration, detailed environment, retro comic style", "warm earthy palette, comic-influenced shading, vivid storytelling"),
    # 默认画风档（未指定 style 或非平台档时兜底，权威定义见 visual-styles.md「默认画风（兜底档）」）
    "general":  ("semi-realistic painterly digital illustration, high detail refined character art, cinematic soft lighting, clean composition", "balanced lighting, soft natural skin texture, elegant color grading, avoid photorealistic and plastic look"),
    "photo":    ("realistic photographic style, sharp focus, professional studio photography", "soft dramatic studio lighting, clean background, natural skin texture"),
}
# char-sheet 专用风格：摄影写实参考表（火火模板基准），仍可按 --style 覆盖
CHAR_SHEET_BASE_STYLE = {
    "en": "A clean minimalist East Asian character reference sheet on pure white/cream background (#FAFAFA). Elegant black typography, thin gray grid lines, light decorative floral elements and small stars.",
    "zh": "干净的极简东亚角色参考表，纯白/米白背景（#FAFAFA）。优雅的黑色排版，细灰网格线，淡雅花卉元素与小星星装饰。",
}

# 表情网格默认 2×3（可 --expressions 覆盖；空串省略整个网格）
DEFAULT_EXPRESSIONS = ["平静", "微笑", "眨眼", "认真", "惊讶", "思考"]
DEFAULT_EXPRESSIONS_EN = ["calm", "smile", "blink", "serious", "surprised", "thinking"]


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


def parse_kv_args(raw):
    """把 --kv 'k1=v1; k2=v2' 形式的键值串解析为 dict；值带逗号的用引号包裹。"""
    result = {}
    for chunk in re.split(r";\s*", raw.strip()) if raw else []:
        if "=" not in chunk:
            continue
        k, _, v = chunk.partition("=")
        result[k.strip()] = v.strip().strip('"').strip("'")
    return result


def build_char_sheet(style, hair, face, outfit, accessory, extra, lang="en",
                     name="", pinyin="", tagline="", info=None, expressions=None,
                     colors=None, bio="", tags=None, modules=None):
    """角色卡图（char-sheet）：参考表布局，模块化拼接。

    模块（--modules 逗号分隔，默认全开；'core' 恒开=三视图+背景+风格）：
      header（大标题） / info（基本信息面板） / expressions（表情网格） /
      breakdown（服装配饰分解+细节网格） / palette（色板+简介+关键词） / signature（签名区）
    """
    style_main, style_atmos = STYLE_TAGS.get(style, STYLE_TAGS["general"])
    info = info or {}
    tags = tags or []
    modules = modules or ["header", "info", "expressions", "breakdown", "palette"]
    parts = []

    # 背景 + 排版基座（固定）
    parts.append(CHAR_SHEET_BASE_STYLE[lang])

    # header：大标题（中文名 + 拼音 + 标语）
    if "header" in modules and name:
        if lang == "zh":
            header_zh = [f'大标题：中文名「{name}」']
            if pinyin:
                header_zh.append(f'拼音「{pinyin}」')
            if tagline:
                header_zh.append(f'标语「{tagline}」')
            parts.append("，".join(header_zh) + "。")
        else:
            header_en = [f'large header with Chinese name "{name}"']
            if pinyin:
                header_en.append(f'pinyin "{pinyin}"')
            parts.append("Layout includes: " + ", ".join(header_en) + (f'; tagline "{tagline}"' if tagline else "") + ".")

    # 基本信息面板
    if "info" in modules and info:
        info_en = [f"{k}: {v}" for k, v in info.items() if v]
        if lang == "zh":
            parts.append("左侧基本信息面板：" + "；".join(info_en))
        else:
            parts.append("left-side basic info panel: " + " / ".join(info_en) + ".")

    # 中央三视图（core，恒开）
    three_views = []
    if lang == "zh":
        three_views.append("中央全身正/侧/背三视图（front/side/back），同一角色同一服装同一发型同一体型")
        if face:
            three_views.append("面部：" + face)
        if hair:
            three_views.append("发型：" + hair)
        if outfit:
            three_views.append("服装：" + outfit)
        if accessory:
            three_views.append("饰品：" + accessory)
        if extra:
            three_views.append(extra)
    else:
        three_views.append("center full-body front/side/back three views of the same character")
        if face:
            three_views.append(f"face: {face}")
        if hair:
            three_views.append(f"hair: {hair}")
        if outfit:
            three_views.append(f"outfit: {outfit}")
        if accessory:
            three_views.append(f"accessory: {accessory}")
        if extra:
            three_views.append(extra)
    parts.append(". ".join(three_views) + ".")

    # 表情网格（2×3）
    if "expressions" in modules and expressions:
        if lang == "zh":
            parts.append(f"右上角 2×3 表情网格（{ '、'.join(expressions) }）")
        else:
            parts.append(f"top-right 2x3 expression grid labeled {', '.join(expressions)}.")

    # 服装/配饰分解 + 细节特写
    if "breakdown" in modules and (outfit or accessory):
        if lang == "zh":
            b = []
            if outfit:
                b.append("服装分解：" + outfit)
            if accessory:
                b.append("配饰分解：" + accessory)
            parts.append("；".join(b) + "。")
        else:
            b = []
            if outfit:
                b.append(f"clothing breakdown: {outfit}")
            if accessory:
                b.append(f"accessories breakdown: {accessory}")
            parts.append("lower section with " + ", ".join(b) + ".")

    # 色板 + 简介 + 关键词标签 + 签名
    if "palette" in modules and (colors or bio or tags):
        p = []
        if colors:
            p.append(f"color palette swatches with hex codes: {', '.join(colors)}")
        if bio:
            p.append(f'character bio: "{bio}"')
        if tags:
            p.append(f"keyword tag pills: {', '.join(tags)}")
        if lang == "zh":
            parts.append("底部：" + "；".join(x for x in p))
        else:
            parts.append("bottom row with " + ", ".join(p) + ".")

    # 风格 + 通用修饰
    parts.append(f"style: {style_main}.")
    parts.append(style_atmos + ".")
    parts.append("character design sheet, model sheet, high detail, no text watermark" if lang == "en"
                 else "角色设计参考表，模型表，高细节，无水印文字")
    return " ".join(parts)


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
    "char-sheet": build_char_sheet,
    "portrait":   build_portrait,
    "turnaround": build_turnaround,
    "cover":      build_cover,
    "scene":      build_scene,
}


def main():
    ap = argparse.ArgumentParser(description="story-image 内置提示词模板")
    ap.add_argument("image_type", choices=list(BUILDERS), help="图像类型（char-sheet 角色卡图 / portrait / turnaround / cover / scene）")
    ap.add_argument("style", choices=list(STYLE_TAGS), default="general", nargs="?", help="画风（默认 general = 默认画风档，见 visual-styles.md「默认画风（兜底档）」）")
    ap.add_argument("--desc", help="角色描述串（逗号分隔多短语，可加 hair:/face:/outfit:/accessory: 前缀）")
    ap.add_argument("--lang", choices=("en", "zh"), default="en", help="提示词语言（char-sheet 支持双语；默认 en）")
    ap.add_argument("--name", default="", help="角色中文名（char-sheet 大标题）")
    ap.add_argument("--pinyin", default="", help="角色拼音（char-sheet 大标题）")
    ap.add_argument("--tagline", default="", help="标语（char-sheet 大标题下方）")
    ap.add_argument("--info", default="", help="基本信息面板，分号分隔 k=v，如 '姓名=火火; 年龄=20岁; 身份=演员'")
    ap.add_argument("--expressions", default="", help="表情网格 2×3，逗号分隔（默认 平静/微笑/眨眼/认真/惊讶/思考；空串省略）")
    ap.add_argument("--colors", default="", help="色板 hex，逗号分隔（如 #FFFFFF,#000000）")
    ap.add_argument("--bio", default="", help="人物简介一句话")
    ap.add_argument("--tags", default="", help="关键词标签，逗号分隔")
    ap.add_argument("--modules", default="", help="char-sheet 模块（逗号分隔：header/info/expressions/breakdown/palette；默认全开）")
    args = ap.parse_args()

    if args.image_type == "char-sheet":
        desc = args.desc or ""
        hair, eyes, outfit, accessory, extra = split_features(desc)
        info = parse_kv_args(args.info)
        expressions = [e.strip() for e in args.expressions.split(",") if e.strip()] if args.expressions else (
            DEFAULT_EXPRESSIONS if args.lang == "zh" else DEFAULT_EXPRESSIONS_EN
        )
        colors = [c.strip() for c in args.colors.split(",") if c.strip()] if args.colors else []
        tags = [t.strip() for t in args.tags.split(",") if t.strip()] if args.tags else []
        modules = [m.strip() for m in args.modules.split(",") if m.strip()] if args.modules else None
        try:
            prompt = build_char_sheet(
                args.style, hair, eyes, outfit, accessory, extra,
                lang=args.lang, name=args.name, pinyin=args.pinyin, tagline=args.tagline,
                info=info, expressions=expressions, colors=colors, bio=args.bio,
                tags=tags, modules=modules,
            )
        except NotImplementedError as e:
            print(str(e), file=sys.stderr)
            return 2
        print(prompt)
        return 0

    if not args.desc:
        print("错误：portrait/turnaround/cover/scene 需要 --desc（角色描述串）", file=sys.stderr)
        return 2
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
