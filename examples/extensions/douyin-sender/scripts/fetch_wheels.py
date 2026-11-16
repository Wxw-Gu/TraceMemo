#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
用 urllib 从镜像拉 wheel，再交给 pip 本地安装 —— 绕开 pip 自己那层网络栈。

    python fetch_wheels.py <目标目录> [包名 ...]
"""

import os
import re
import ssl
import sys
import urllib.parse
import urllib.request
from pathlib import Path

MIRRORS = [
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "https://mirrors.aliyun.com/pypi/simple",
]

DEFAULT_PACKAGES = ["requests", "playwright"]

WHEEL_RE = re.compile(r'href="([^"#]+\.whl)[^"]*"')
VER_RE = re.compile(r'-(\d+(?:\.\d+)*)')

# 部分镜像对浏览器 UA 返回 403，用 pip 自己的才放行。
USER_AGENT = "pip/26.1.2"


def page_links(mirror: str, package: str) -> list[str]:
    """索引页 href 是相对路径，用 urljoin 归一。"""
    url = f"{mirror}/{package}/"
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        html = resp.read().decode("utf-8", "replace")
    return [urllib.parse.urljoin(url, href) for href in WHEEL_RE.findall(html)]


def wheel_key(name: str) -> tuple:
    """排序键：越靠后越优先。"""
    base = name.rsplit("/", 1)[-1].lower()
    pure = 1 if ("none-any" in base) else 0
    win_amd64 = 1 if "win_amd64" in base else 0
    cp313 = 1 if "cp313" in base else 0
    abi3 = 1 if "abi3" in base else 0
    return (pure, win_amd64, abi3, cp313)


def version_key(url: str) -> tuple:
    """从文件名取版本号数字段。"""
    m = VER_RE.search(url.rsplit("/", 1)[-1])
    if not m:
        return ()
    return tuple(int(part) for part in m.group(1).split("."))


def pick(links: list[str]) -> str | None:
    """挑一个 Windows x64 / cp313 可用的 wheel。"""
    candidates = []
    for link in links:
        low = link.lower()
        if "macosx" in low or "manylinux" in low or "musllinux" in low:
            continue
        if "win32" in low or "win_arm64" in low:
            continue
        if "none-any.whl" in low or "win_amd64.whl" in low:
            candidates.append(link)
    if not candidates:
        return None
    candidates.sort(key=lambda url: (wheel_key(url), version_key(url)))
    return candidates[-1]


def download(url: str, dest_dir: Path) -> Path:
    name = url.rsplit("/", 1)[-1].split("#")[0]
    target = dest_dir / name
    if target.exists() and target.stat().st_size > 0:
        print(f"  cached  {name}")
        return target
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    target.write_bytes(data)
    print(f"  saved   {name}  ({len(data)//1024} KB)")
    return target


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    dest = Path(sys.argv[1]).expanduser()
    packages = sys.argv[2:] or DEFAULT_PACKAGES
    dest.mkdir(parents=True, exist_ok=True)

    failed = []
    for package in packages:
        print(f"[{package}]")
        chosen = None
        for mirror in MIRRORS:
            try:
                links = page_links(mirror, package)
            except Exception as exc:
                print(f"  mirror {mirror} failed: {type(exc).__name__}")
                continue
            chosen = pick(links)
            if chosen:
                print(f"  mirror  {mirror}")
                break
        if not chosen:
            print("  no compatible wheel found")
            failed.append(package)
            continue
        try:
            download(chosen, dest)
        except Exception as exc:
            print(f"  download failed: {type(exc).__name__} {exc}")
            failed.append(package)

    if failed:
        print("FAILED: " + ", ".join(failed))
        return 1
    print(f"OK -> {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
