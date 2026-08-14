#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""api-json.py — story-image 云后端（openai/volcengine/dashscope）的 JSON 处理 helper（替代 jq，Windows 零依赖）。

子命令：
  body <kind> <model> <prompt> [size]      → stdout 输出请求体 JSON
      kind ∈ {openai, volcengine, dashscope}（结构差异内置）
  has-error <resp.json> [kind]             → 有错误输出错误对象 JSON；无错误无输出（exit 0）
      kind=dashscope 用 code/message 规则，其余用 error 字段
  field <resp.json> <点路径>               → 提取字段值（支持 data.0.url 风格路径），输出原值
  first-image <resp.json>                  → 输出 url:<...> 或 b64:<...> 或 none（OpenAI 兼容响应）
  task-id <resp.json>                      → 输出 dashscope 异步任务的 task_id（无则空）
  task-status <resp.json>                  → 输出 SUCCEEDED/FAILED/... 或空
  fix-ext <image_file>                     → 按文件头检测实际格式（JPEG/PNG/WebP/GIF），
                                            与扩展名不符时输出建议扩展名（如 jpeg→jpg），相符无输出
"""
import json
import sys
import os


def _out(s=""):
    if os.name == "nt":
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass
    print(s)


def load_json(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError, UnicodeError) as exc:
        _out(json.dumps({"error": "无法解析 JSON {}: {}".format(path, exc)}, ensure_ascii=False))
        raise SystemExit(1) from exc


def get_path(d, path):
    """点路径提取：data.0.url → d['data'][0]['url']"""
    cur = d
    for seg in path.split("."):
        if isinstance(cur, list) and seg.isdigit():
            try:
                cur = cur[int(seg)]
            except IndexError:
                return None
        elif isinstance(cur, dict):
            cur = cur.get(seg)
        else:
            return None
        if cur is None:
            return None
    return cur


def build_body(kind, model, prompt, size=None):
    if kind == "volcengine":
        b = {"model": model, "prompt": prompt, "response_format": "url", "watermark": True}
        if size:
            b["size"] = size
        return b
    if kind == "dashscope":
        b = {"model": model, "input": {"prompt": prompt}, "parameters": {"size": size or "1024*1024", "n": 1}}
        return b
    if kind == "grsai":
        # GrsAI /v1/draw/completions：同步返回，results[].url 取图
        b = {"model": model, "prompt": prompt, "shutProgress": True}
        if size:
            b["aspectRatio"] = size
        return b
    # openai（默认）
    b = {"model": model, "prompt": prompt}
    if size:
        b["size"] = size
    return b


def detect_image_ext(path):
    """按 magic bytes 检测图片格式；无法识别返回 None"""
    try:
        with open(path, "rb") as f:
            head = f.read(16)
    except OSError:
        return None
    if head[:3] == b"\xff\xd8\xff":
        return "jpg"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    return None


def main():
    if len(sys.argv) < 2:
        _err = sys.stderr
        print("用法: api-json.py body|has-error|field|first-image|task-id|task-status ...", file=_err)
        return 2
    cmd = sys.argv[1]

    if cmd == "body":
        kind, model, prompt = sys.argv[2], sys.argv[3], sys.argv[4]
        size = sys.argv[5] if len(sys.argv) > 5 else None
        _out(json.dumps(build_body(kind, model, prompt, size), ensure_ascii=False))
        return 0

    if cmd == "has-error":
        d = load_json(sys.argv[2])
        kind = sys.argv[3] if len(sys.argv) > 3 else "openai"
        if kind == "dashscope":
            # 原生异步接口错误形如 {code, message}；有 task_id 则视为成功响应
            if (d.get("code") or d.get("message")) and not get_path(d, "output.task_id"):
                _out(json.dumps(d, ensure_ascii=False)[:500])
                return 1
        elif kind == "grsai":
            # GrsAI 响应：status != "succeeded" 视为失败，error 字段优先
            if d.get("error"):
                _out(json.dumps(d["error"], ensure_ascii=False)[:500])
                return 1
            if d.get("status") not in (None, "succeeded"):
                _out(json.dumps(d, ensure_ascii=False)[:500])
                return 1
        else:
            if d.get("error"):
                _out(json.dumps(d["error"], ensure_ascii=False)[:500])
                return 1
        return 0

    if cmd == "field":
        d = load_json(sys.argv[2])
        v = get_path(d, sys.argv[3])
        if v is not None:
            _out(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
        return 0

    if cmd == "first-image":
        d = load_json(sys.argv[2])
        # OpenAI 兼容：data[0].url / data[0].b64_json
        items = d.get("data") or []
        # GrsAI：results[0].url（/v1/draw/completions 同步响应）
        if not items and isinstance(d.get("results"), list):
            items = d["results"]
        if not items:
            _out("none")
            return 0
        item = items[0]
        if item.get("url"):
            _out("url:" + item["url"])
        elif item.get("b64_json"):
            _out("b64:" + item["b64_json"])
        else:
            _out("none")
        return 0

    if cmd == "task-id":
        d = load_json(sys.argv[2])
        v = get_path(d, "output.task_id")
        if v:
            _out(v)
        return 0

    if cmd == "task-status":
        d = load_json(sys.argv[2])
        v = get_path(d, "output.task_status")
        if v:
            _out(v)
        return 0

    if cmd == "fix-ext":
        path = sys.argv[2]
        real = detect_image_ext(path)
        cur = os.path.splitext(path)[1].lstrip(".").lower()
        if real and real != cur:
            _out(real)
        return 0

    print(f"未知子命令: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
