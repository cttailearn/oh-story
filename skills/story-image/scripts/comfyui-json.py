#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""comfyui-json.py — story-image 的 ComfyUI JSON 处理 helper（替代 jq，Windows 零依赖）。

子命令：
  format <workflow.json>                     → 输出 ui | api | unknown
  inject <workflow.json> --prompt P [--negative N] [--ckpt C]
                                              → stdout 输出注入后的 API 格式 JSON
                                              → stderr 输出注入方式信息
  nodeinfo <prompt_response.json>            → 输出 prompt_id:<id> / error:<msg> / node_errors:<json>
  firstimage <history.json> <prompt_id>      → 输出 filename<TAB>subfolder<TAB>type
  discover-workflows [显式目录]               → 输出探测到的工作流目录（每行一个）
  wf-kind <workflow.json>                    → 输出 文生图 | 图生图 | 视频 | 其他

注入规则（与 imagegen-comfyui.sh 一致）：
  1) 工作流含 __PROMPT__/__NEGATIVE__/__CKPT__ 占位符 → 直接替换（推荐）
  2) 无占位符 → 自动注入 CLIPTextEncode 节点：节点 ID 最小者=正向，次小者=负向（负向为空时不注入）

工作流目录探测（discover-workflows，全部为通用规则，无本机路径硬编码）：
  1. 显式参数
  2. 环境变量 COMFYUI_WORKFLOW_DIR
  3. 官方默认 ~/ComfyUI/user/default/workflows
  4. 便携整合包常见约定位置（~/ComfyUI_windows_portable、~/ComfyUI_portable）
  5. 进程探测：从正在运行的 ComfyUI python 进程（Windows: Win32_Process；Linux: /proc）
     反推其安装目录 → 推导 workflows 路径
"""
import json
import re
import subprocess
import sys
import os


VIDEO_NODE_PATTERNS = (
    "video", "Video", "AnimateDiff", "Wan", "Hunyuan", "Mochi", "LTXV",
    "CogVideo", "ImageToVideo", "TextToVideo", "FramePack", "SVD",
)
IMAGE2IMG_NODE_PATTERNS = ("LoadImage", "VHS_LoadImage", "ImageToImage")


def _out(s=""):
    """stdout 输出，兼容 Windows GBK 终端"""
    if os.name == "nt":
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    print(s)


def _err(s):
    if os.name == "nt":
        try:
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    print(s, file=sys.stderr)


def load_json(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def detect_format(wf):
    if isinstance(wf, dict):
        if "nodes" in wf and "links" in wf and "last_node_id" in wf:
            return "ui"
        # API 格式：顶层是 {节点ID: {"class_type": ..., "inputs": ...}}
        if all(
            isinstance(v, dict) and "class_type" in v for v in wf.values()
        ):
            return "api"
    return "unknown"


def placeholder_inject(wf, prompt, negative, ckpt):
    """递归替换字符串占位符。返回 (新wf, 是否命中占位符)"""
    hit = {"v": False}

    def walk(o):
        if isinstance(o, str):
            if o == "__PROMPT__":
                hit["v"] = True
                return prompt
            if o == "__NEGATIVE__":
                hit["v"] = True
                return negative
            if o == "__CKPT__":
                hit["v"] = True
                return ckpt
            return o
        if isinstance(o, list):
            return [walk(x) for x in o]
        if isinstance(o, dict):
            return {k: walk(v) for k, v in o.items()}
        return o

    return walk(wf), hit["v"]


def auto_inject_clip_text(wf, prompt, negative):
    """自动注入 CLIPTextEncode：ID 最小=正向，次小=负向。返回 (新wf, 注入的节点ID列表)"""
    encs = sorted(
        (k for k, v in wf.items() if v.get("class_type") == "CLIPTextEncode"),
        key=lambda x: int(x),
    )
    if not encs:
        raise RuntimeError(
            "工作流里没有 CLIPTextEncode 节点，无法自动注入提示词；"
            "请在工作流中把提示词节点文本设为 __PROMPT__ 后重试"
        )
    wf = json.loads(json.dumps(wf))
    wf[encs[0]]["inputs"]["text"] = prompt
    injected = [encs[0]]
    if negative and len(encs) > 1:
        wf[encs[1]]["inputs"]["text"] = negative
        injected.append(encs[1])
    return wf, injected


# ---------- 工作流目录探测（通用规则） ----------

def _candidates_from_python_exe(exe):
    """从 ComfyUI 的 python 可执行路径上溯推导 workflows 目录候选。
    portable 结构: <根>/python_embeded/python.exe → 根/ComfyUI/user/default/workflows
    venv 结构:     <根>/venv/Scripts/python.exe   → 根/ComfyUI/user/default/workflows
    """
    d = os.path.dirname(os.path.abspath(exe))
    for _ in range(6):
        for sub in ("ComfyUI/user/default/workflows", "user/default/workflows"):
            c = os.path.join(d, sub)
            if os.path.isdir(c):
                yield c
        d = os.path.dirname(d)


def _probe_python_processes():
    """找到运行中 ComfyUI 的 python 可执行路径（跨平台，找不到返回空列表）"""
    found = []
    try:
        if os.name == "nt":
            script = (
                "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "
                "Get-CimInstance Win32_Process | "
                "Where-Object { $_.Name -match 'python' -and $_.CommandLine -match 'main\\.py' } | "
                "Select-Object -ExpandProperty ExecutablePath"
            )
            out = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                capture_output=True, timeout=30,
            )
            for line in out.stdout.decode("utf-8", "replace").splitlines():
                p = line.strip()
                if p and os.path.isfile(p):
                    found.append(p)
        else:
            out = subprocess.run(
                ["ps", "-eo", "pid,args"], capture_output=True, timeout=15
            )
            pids = []
            for line in out.stdout.decode("utf-8", "replace").splitlines():
                if "main.py" in line and "ComfyUI" in line:
                    parts = line.split(None, 1)
                    if parts:
                        pids.append(parts[0])
            for pid in pids:
                try:
                    cwd = os.readlink(f"/proc/{pid}/cwd")
                    found.append(os.path.join(cwd, "ComfyUI", "main.py"))
                except OSError:
                    continue
    except Exception:
        pass
    return found


def discover_workflow_dirs(explicit=None):
    """按通用规则探测工作流目录，返回存在的目录列表（去重、保持优先级）"""
    dirs, seen = [], set()

    def add(d):
        if not d:
            return
        d = os.path.abspath(os.path.expanduser(d))
        if d not in seen and os.path.isdir(d):
            seen.add(d)
            dirs.append(d)

    if explicit:
        add(explicit)
    add(os.environ.get("COMFYUI_WORKFLOW_DIR"))
    add(os.path.expanduser("~/ComfyUI/user/default/workflows"))
    # 便携整合包常见约定位置（通用规则，非本机硬编码）
    add(os.path.expanduser("~/ComfyUI_windows_portable/ComfyUI/user/default/workflows"))
    add(os.path.expanduser("~/ComfyUI_portable/ComfyUI/user/default/workflows"))
    # 进程探测：从运行中的 ComfyUI 反推安装位置
    for exe in _probe_python_processes():
        for c in _candidates_from_python_exe(exe):
            add(c)
    return dirs


def workflow_kind(path):
    """粗判工作流类型：文生图 / 图生图 / 视频 / 其他（读文件头即可）"""
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            head = f.read(200000)
    except OSError:
        return "不可读"
    names = []
    if "\"nodes\"" in head or "\"links\"" in head:
        # UI 格式：从 nodes 数组取 type
        try:
            wf = json.loads(head)
            names = [n.get("type", "") for n in wf.get("nodes", [])]
        except Exception:
            names = re.findall(r'"type"\s*:\s*"([^"]+)"', head)
    else:
        try:
            wf = json.loads(head)
            names = [n.get("class_type", "") for n in wf.values() if isinstance(n, dict)]
        except Exception:
            names = re.findall(r'"class_type"\s*:\s*"([^"]+)"', head)
    joined = "\n".join(names)
    for pat in VIDEO_NODE_PATTERNS:
        if pat in joined:
            return "视频"
    if any(p in joined for p in IMAGE2IMG_NODE_PATTERNS):
        return "图生图"
    if "KSampler" in joined or "UNETLoader" in joined or "CheckpointLoader" in joined:
        return "文生图"
    return "其他"



def main():
    if len(sys.argv) < 2:
        _err("用法: comfyui-json.py format|inject|nodeinfo|firstimage ...")
        return 2
    cmd = sys.argv[1]

    if cmd == "format":
        wf = load_json(sys.argv[2])
        _out(detect_format(wf))
        return 0

    if cmd == "discover-workflows":
        explicit = sys.argv[2] if len(sys.argv) > 2 else None
        for d in discover_workflow_dirs(explicit):
            _out(d)
        return 0

    if cmd == "wf-kind":
        _out(workflow_kind(sys.argv[2]))
        return 0

    if cmd == "inject":
        path = sys.argv[2]
        args = sys.argv[3:]
        prompt = negative = ckpt = None
        i = 0
        while i < len(args):
            if args[i] == "--prompt" and i + 1 < len(args):
                prompt = args[i + 1]
                i += 2
            elif args[i] == "--negative" and i + 1 < len(args):
                negative = args[i + 1]
                i += 2
            elif args[i] == "--ckpt" and i + 1 < len(args):
                ckpt = args[i + 1]
                i += 2
            else:
                _err(f"未知参数: {args[i]}")
                return 2
        if prompt is None:
            _err("缺少 --prompt")
            return 2
        wf = load_json(path)
        if detect_format(wf) != "api":
            _err("不是 API 格式工作流（UI 格式请先在 ComfyUI 中 Workflow → Export (API) 导出）")
            return 1
        wf, hit = placeholder_inject(wf, prompt, negative or "", ckpt or "")
        if hit:
            _err("injected:placeholder")
        else:
            wf2, injected = auto_inject_clip_text(wf, prompt, negative or "")
            wf = wf2
            _err(f"injected:auto:{','.join(injected)}")
        _out(json.dumps(wf, ensure_ascii=False))
        return 0

    if cmd == "nodeinfo":
        d = load_json(sys.argv[2])
        if d.get("error"):
            _out(f"error:{d['error'].get('message', str(d['error']))}")
            return 0
        if d.get("node_errors"):
            _out("node_errors:" + json.dumps(d["node_errors"], ensure_ascii=False))
            return 0
        pid = d.get("prompt_id")
        if pid:
            _out(f"prompt_id:{pid}")
            return 0
        _out("error:unknown response: " + json.dumps(d, ensure_ascii=False)[:200])
        return 0

    if cmd == "firstimage":
        d = load_json(sys.argv[2])
        pid = sys.argv[3]
        entry = d.get(pid) or {}
        outs = entry.get("outputs") or {}
        # 多输出（如 原图SaveImage + 放大SaveImage）时取节点 ID 最大的（通常=流程末端的最终产物）
        # 不能依赖 dict 顺序（ComfyUI 并行执行时输出顺序不稳定）
        best = None
        for nid, out in outs.items():
            imgs = (out or {}).get("images") or []
            if imgs and (best is None or int(nid) > int(best[0])):
                best = (nid, imgs[0])
        if best:
            img = best[1]
            _out(
                f"{img.get('filename','')}\t{img.get('subfolder','')}\t{img.get('type','output')}"
            )
            return 0
        return 1  # 尚无图片

    _err(f"未知子命令: {cmd}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
