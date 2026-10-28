#!/usr/bin/env python3
"""
为首页 world.svg 生成港澳台独立边界 path(hk/tw/mo),插入到 cn path 之后。

数据源:DataV.GeoAtlas(与 cn 国界同源)
  - 810000 香港特别行政区(行政边界,含水域)
  - 820000 澳门特别行政区(行政边界)
  - 710000 台湾省(含澎湖/钓鱼岛/绿岛/兰屿)

投影:world.svg 采用 Mercator(由 cn path 与 DataV 边界拟合求得):
    x = S * lon * DEG + X0
    y = Y0 - S * atanh(sin(lat * DEG))
    S=161.9955, X0=472.868, Y0=464.237  (验证:700 随机点 100% 落在 cn 轮廓 1 单位内)

用法:python3 scripts/build-territory-paths.py  # 直接改写 public/images/world.svg
"""
import json
import math
import re
import sys
import urllib.request

sys.setrecursionlimit(300000)

DEG = math.pi / 180
S = 161.9955
X0 = 472.868
Y0 = 464.237
DP_TOL = 0.04          # 简化容差(地图单位),与 cn 轮廓密度一致
MIN_AREA = 0.01        # 小于该投影面积的岛屿环丢弃(亚可见)
DECIMALS = 2           # 与 world.svg 现有坐标精度一致

TERRITORIES = [
    ("810000", "hk", "Hong Kong"),
    ("820000", "mo", "Macau"),
    ("710000", "tw", "Taiwan"),
]


def fetch(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def proj(lon, lat):
    return (S * lon * DEG + X0, Y0 - S * math.atanh(math.sin(lat * DEG)))


def douglas_peucker(pts, tol):
    if len(pts) < 3:
        return pts
    x1, y1 = pts[0]
    x2, y2 = pts[-1]
    dx = x2 - x1
    dy = y2 - y1
    L2 = dx * dx + dy * dy

    def perp_dist(p):
        px, py = p
        if L2 == 0:
            return math.hypot(px - x1, py - y1)
        t = max(0, min(1, ((px - x1) * dx + (py - y1) * dy) / L2))
        return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))

    dmax = 0.0
    idx = 0
    for i in range(1, len(pts) - 1):
        d = perp_dist(pts[i])
        if d > dmax:
            dmax = d
            idx = i
    if dmax > tol:
        return douglas_peucker(pts[:idx + 1], tol)[:-1] + douglas_peucker(pts[idx:], tol)
    return [pts[0], pts[-1]]


def rings_of(geom):
    out = []

    def walk(c):
        if not c:
            return
        if isinstance(c[0], (list, tuple)):
            if isinstance(c[0][0], (int, float)):
                out.append(c)
                return
            for x in c:
                walk(x)
        else:
            out.append(c)

    if not geom:
        return out
    t = geom["type"]
    if t in ("Polygon", "MultiPolygon"):
        walk(geom["coordinates"])
    elif t == "GeometryCollection":
        for g in geom["geometries"]:
            out += rings_of(g)
    return out


def ring_area(ring):
    a = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2


def ring_to_d(pr):
    parts = [f"M{pr[0][0]:.{DECIMALS}f},{pr[0][1]:.{DECIMALS}f}"]
    for x, y in pr[1:]:
        parts.append(f"L{x:.{DECIMALS}f},{y:.{DECIMALS}f}")
    parts.append("Z")
    return " ".join(parts)


def build_path_element(code, pid, label):
    g = fetch(f"https://geo.datav.aliyun.com/areas_v3/bound/{code}.json")
    feats = g.get("features", [g])
    rings = []
    for f in feats:
        rings += rings_of(f.get("geometry"))

    subpaths = []
    for r in rings:
        pr = [proj(p[0], p[1]) for p in r]
        if pr[0] != pr[-1]:
            pr = pr + [pr[0]]
        simp = douglas_peucker(pr, DP_TOL)
        if len(simp) < 3 or ring_area(simp) < MIN_AREA:
            continue
        subpaths.append(ring_to_d(simp))

    d = " ".join(subpaths)
    return (
        f'\t<path\n'
        f'\t\td="{d}"\n'
        f'\t\taria-label="{label}"\n'
        f'\t\tid="{pid}"\n'
        f'\t/>'
    )


def main():
    path = "public/images/world.svg"
    svg = open(path, encoding="utf-8").read()

    blocks = []
    for code, pid, label in TERRITORIES:
        el = build_path_element(code, pid, label)
        npts = len(re.findall(r"[ML]", el.split('d="')[1].split('"')[0]))
        blocks.append(el)
        print(f"{pid}: path points ~{npts}")

    # 插入到 cn path 之后(在 cn 之上渲染)
    cnm = re.search(r'<path\b(?:(?!<path).)*?\bid="cn"[^>]*>', svg, re.S)
    if not cnm:
        sys.exit("cn path not found")
    # 每块自带前导 \t，直接以换行连接即可（避免第 2、3 块多一层缩进）
    insertion = "\n" + "\n".join(blocks) + "\n"
    svg = svg[:cnm.end()] + insertion + svg[cnm.end():]

    open(path, "w", encoding="utf-8").write(svg)
    print(f"world.svg updated: {len(svg)} bytes")


if __name__ == "__main__":
    main()
