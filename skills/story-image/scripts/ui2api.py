#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ui2api.py — 将 ComfyUI UI 格式工作流转换为 API 格式（实验性）。

用法：
  python ui2api.py --url http://127.0.0.1:8198 --input wf.json --output wf_api.json
  python ui2api.py --objinfo object_info.json --input wf.json --output wf_api.json   # 离线（对象信息缓存）

原理：按节点定义（object_info 的 input 顺序）把 widgets_values 映射到无连接的 input：
  - 有连接 → [源节点ID, 源输出槽]
  - 复杂类型（MODEL/CLIP/VAE/IMAGE...）→ 无 widget，跳过
  - combo/基本类型 → 按顺序消耗一个 widget 值
已知特例：KSampler/KSamplerAdvanced 的 seed 后跟一个 'randomize' toggle widget（非 input），自动跳过。

局限：自定义节点若 widget 顺序与 input 定义不一致，可能错位——转换后请用 ComfyUI 提交验证
（node_errors 检查在 imagegen-comfyui.sh 中已有）。
"""
import argparse
import json
import sys
import os
import urllib.request

# 复杂类型：无 widget，只能由连接提供
COMPLEX_TYPES = {
    "MODEL", "CLIP", "VAE", "CONDITIONING", "LATENT", "IMAGE", "MASK",
    "CONTROL_NET", "UPSCALE_MODEL", "CLIP_VISION", "CLIP_VISION_OUTPUT",
    "STYLE_MODEL", "GLIGEN", "EMBEDS", "AUDIO", "NOISE", "WEIGHTS",
    "TRANSFORMER_OPTIONS", "SAMPLER", "SIGMAS", "GUIDER", "LATENT_KEYFRAME",
    "LATENT_KEYFRAME_GROUP", "LATENT_KEYFRAME_TIMING",
    "VAE_APPROX", "PIXEL_WEIGHTS", "TIMESTEP_KEYFRAME", "TIMESTEP_KEYFRAME_GROUP",
}

# 基本类型标记（str 形式，有 widget）
BASIC_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN"}

# seed 后带 'randomize' toggle 的采样器节点（值可能是字符串 'randomize' 或整数 1）
SEED_RANDOMIZE_NODES = {
    "KSampler", "KSamplerAdvanced", "KSamplerWithRefiner", "SamplerCustom",
    "UltimateSDUpscale", "UltimateSDUpscaleNoUpscale",
}


def load_objinfo(url=None, path=None):
    if path:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    with urllib.request.urlopen(f"{url}/object_info", timeout=60) as r:
        return json.load(r)


def is_complex(spec_first):
    """spec_first 是类型标记：list=combo（有 widget），dict=JSON Schema（有 widget），
    大写类型名：在 COMPLEX_TYPES 里=复杂类型（无 widget），否则（如 INT/STRING）=基本类型（有 widget）"""
    if isinstance(spec_first, list):
        return False  # combo
    if isinstance(spec_first, dict):
        return False  # 基本类型 JSON Schema
    if isinstance(spec_first, str):
        return spec_first in COMPLEX_TYPES
    return False


def validate_input(cls, name, value, spec):
    """按 spec 校验 input 值是否合法（捕获 widget 顺序错位）。返回 (ok, hint)"""
    first = spec[0] if spec else None
    if isinstance(first, list):  # combo
        if value not in first:
            return False, f"值 {value!r} 不在可选列表"
        return True, ""
    if isinstance(first, str) and first.upper() in BASIC_TYPES:
        t = first.upper()
        if t == "INT":
            if isinstance(value, bool) or not isinstance(value, int):
                return False, f"值 {value!r} 不是 INT"
            lo, hi = (spec[1] or {}).get("min"), (spec[1] or {}).get("max")
            if lo is not None and value < lo:
                return False, f"值 {value} 小于最小值 {lo}"
            if hi is not None and value > hi:
                return False, f"值 {value} 大于最大值 {hi}"
            return True, ""
        if t == "FLOAT":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return False, f"值 {value!r} 不是 FLOAT"
            return True, ""
        if t == "BOOLEAN":
            if not isinstance(value, bool):
                return False, f"值 {value!r} 不是 BOOLEAN"
            return True, ""
        if t == "STRING":
            if not isinstance(value, str):
                return False, f"值 {value!r} 不是 STRING"
            return True, ""
    return True, ""


def convert(wf, objinfo):
    links = {l[0]: l for l in wf.get("links", [])}
    nodes = wf.get("nodes", [])
    by_id = {str(n.get("id")): n for n in nodes}
    warnings = []
    skipped = []

    # ---- 预扫描：Reroute 透传表 + SetNode/GetNode 配对表 ----
    reroutes = {}          # reroute_id -> (src_id, src_slot)
    set_by_name = {}       # set_name -> (set_id, (src_id, src_slot))
    get_names = {}         # get_id -> set_name
    for n in nodes:
        nid = str(n.get("id"))
        cls = n.get("type", "")
        if cls == "Reroute":
            for i in n.get("inputs") or []:
                if i.get("link") is not None and i["link"] in links:
                    l = links[i["link"]]
                    reroutes[nid] = (str(l[1]), l[2])
        elif cls == "GetNode" and (n.get("widgets_values") or []):
            get_names[nid] = n["widgets_values"][0]
        elif cls == "SetNode" and (n.get("widgets_values") or []):
            name = n["widgets_values"][0]
            src = None
            for i in n.get("inputs") or []:
                if i.get("link") is not None and i["link"] in links:
                    l = links[i["link"]]
                    src = (str(l[1]), l[2])
            if src:
                set_by_name[name] = (nid, src)

    # GetNode -> 对应 SetNode 的输入来源
    getnode_map = {}
    for gid, name in get_names.items():
        if name in set_by_name:
            getnode_map[gid] = set_by_name[name][1]
        else:
            warnings.append(f"节点 {gid} [GetNode] 找不到对应的 SetNode({name})，其输出将断开")

    def resolve(src_id, slot):
        """穿过 Reroute / GetNode，解析到真实来源"""
        for _ in range(20):
            if src_id in reroutes:
                src_id, slot = reroutes[src_id]
            elif src_id in getnode_map:
                src_id, slot = getnode_map[src_id]
            else:
                return src_id, slot
        return src_id, slot

    api = {}
    for n in nodes:
        cls = n.get("type", "")
        nid = str(n.get("id"))
        # 纯 UI / 预览类节点跳过
        if (
            cls in ("note", "memo")
            or cls.endswith("Note")
            or "Markdown" in cls
            or cls == "Label (rgthree)"
            or "Comparer" in cls
            or cls in ("Reroute", "GetNode", "SetNode", "Fast Bypasser (rgthree)")
        ):
            skipped.append(nid)
            continue
        info = objinfo.get(cls)
        if not info:
            warnings.append(f"节点 {nid} [{cls}] 不在 object_info 中，已跳过——该节点不会出现在 API 工作流里")
            skipped.append(nid)
            continue
        required = list((info.get("input", {}).get("required") or {}).keys())
        optional = list((info.get("input", {}).get("optional") or {}).keys())
        all_inputs = {**info["input"].get("required", {}), **info["input"].get("optional", {})}
        order = required + optional
        # 连接映射（穿过 Reroute/GetNode 解析）
        conns = {}
        for i in n.get("inputs") or []:
            if i.get("link") is not None and i["link"] in links:
                l = links[i["link"]]
                r_src, r_slot = resolve(str(l[1]), l[2])
                if r_src in by_id and r_src not in api and r_src not in skipped:
                    # 来源节点尚未转换（顺序问题）或将被跳过——先记着，末尾统一清理
                    pass
                if by_id.get(r_src) is not None:
                    conns[i["name"]] = [r_src, r_slot]
        wv = list(n.get("widgets_values") or [])
        wi = 0
        inputs = {}
        for name in order:
            spec = all_inputs[name]
            first = spec[0] if spec else None
            if is_complex(first):
                # 复杂类型无 widget，但可能有连接
                if name in conns:
                    inputs[name] = conns[name]
                continue
            # 有 widget 的 input：无论是否连接，widgets_values 里都占一个值；连接优先写入
            consumed = None
            if wi < len(wv):
                consumed = wv[wi]
                wi += 1
                # seed 后的 'randomize' toggle（仅采样器节点，非 input）
                if cls in SEED_RANDOMIZE_NODES and name == "noise_seed" and wi < len(wv) and wv[wi] in ("randomize", 1, True):
                    wi += 1
            if name in conns:
                inputs[name] = conns[name]
            elif consumed is not None:
                if isinstance(consumed, dict) and len(consumed) == 1 and "text" in consumed:
                    consumed = consumed["text"]
                inputs[name] = consumed
        if wi < len(wv):
            warnings.append(f"节点 {nid} [{cls}]: {len(wv) - wi} 个 widget 值未被消费，可能错位，请人工核对")
        # 值合法性校验（捕获 widget 顺序错位）
        for name, v in inputs.items():
            if isinstance(v, list):
                continue  # 连接引用
            ok, hint = validate_input(cls, name, v, all_inputs[name])
            if not ok:
                warnings.append(
                    f"节点 {nid} [{cls}] 的 {name} 可能错位（{hint}）——"
                    f"若该工作流由旧版节点保存，请在 ComfyUI 中打开并核对节点参数后重新 Export (API)"
                )
        api[nid] = {"class_type": cls, "inputs": inputs}

    # ---- 清理：引用被跳过/不存在节点的连接 ----
    kept = set(api.keys())
    for nid, node in api.items():
        for name, v in list(node["inputs"].items()):
            if isinstance(v, list) and v and v[0] not in kept:
                warnings.append(f"节点 {nid} [{node['class_type']}] 的 {name} 引用了被跳过的节点 {v[0]}，连接已断开")
                del node["inputs"][name]

    return api, warnings, skipped


def main():
    ap = argparse.ArgumentParser(description="ComfyUI UI 格式工作流 → API 格式")
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--url", default="http://127.0.0.1:8188")
    ap.add_argument("--objinfo", default=None, help="object_info JSON 缓存路径（离线模式）")
    args = ap.parse_args()

    with open(args.input, "r", encoding="utf-8-sig") as f:
        wf = json.load(f)
    objinfo = load_objinfo(args.url, args.objinfo)
    api, warnings, skipped = convert(wf, objinfo)
    out_dir = os.path.dirname(args.output)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(api, f, ensure_ascii=False, indent=2)
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    print(f"转换完成: {len(api)} 个节点 → {args.output}", file=sys.stderr)
    if skipped:
        print(f"跳过 {len(skipped)} 个纯 UI/未知节点: {','.join(skipped)}", file=sys.stderr)
    for w in warnings:
        print(f"[警告] {w}", file=sys.stderr)


if __name__ == "__main__":
    main()
