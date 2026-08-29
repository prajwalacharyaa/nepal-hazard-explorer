"""SRTM elevation from the AWS terrarium tiles.

Same tiles and same maths as the browser (see anSampleTerrain in web/app.js).
Keep them in step or the pipeline and the live check will disagree.

Tiles cache under data/raw/terrain_tiles/, so repeat runs are free and work
offline once warm.

Terrarium encoding: metres = (R * 256 + G + B / 256) - 32768.
"""
from __future__ import annotations

import math
import threading

import numpy as np

from config import RAW

TILE_DIR = RAW / "terrain_tiles"
URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
DEFAULT_Z = 12                     # ~33 m/px at Nepal's latitude

_mem: dict[tuple, np.ndarray | None] = {}
_lock = threading.Lock()
_session = None


def _sess():
    global _session
    if _session is None:
        import requests
        from requests.adapters import HTTPAdapter
        s = requests.Session()
        s.mount("https://", HTTPAdapter(pool_maxsize=16, max_retries=3))
        s.headers["User-Agent"] = "nepal-hazard-explorer/1.0"
        _session = s
    return _session


def lon2tile(lon: float, z: int) -> float:
    return (lon + 180.0) / 360.0 * (2 ** z)


def lat2tile(lat: float, z: int) -> float:
    r = math.radians(lat)
    return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * (2 ** z)


def m_per_px(lat: float, z: int) -> float:
    return 156543.03392 * math.cos(math.radians(lat)) / (2 ** z)


def _load_tile(z: int, x: int, y: int):
    key = (z, x, y)
    with _lock:
        if key in _mem:
            return _mem[key]
    path = TILE_DIR / str(z) / str(x) / f"{y}.png"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            r = _sess().get(URL.format(z=z, x=x, y=y), timeout=60)
            if r.status_code != 200 or not r.content.startswith(b"\x89PNG"):
                with _lock:
                    _mem[key] = None
                return None
            path.write_bytes(r.content)
        except Exception:
            with _lock:
                _mem[key] = None
            return None
    try:
        from PIL import Image
        with Image.open(path) as im:
            arr = np.asarray(im.convert("RGB"), dtype=np.int32)
        elev = arr[:, :, 0] * 256 + arr[:, :, 1] + arr[:, :, 2] / 256.0 - 32768.0
    except Exception:
        elev = None
    with _lock:
        _mem[key] = elev
    return elev


def elevation(points, z: int = DEFAULT_Z) -> np.ndarray:
    """Elevation in metres for an iterable of (lon, lat). NaN where unavailable.

    Points are grouped by tile so each tile is fetched once, which matters when
    sampling thousands of positions across the same few valleys."""
    pts = np.asarray(points, dtype=float)
    if pts.ndim == 1:
        pts = pts.reshape(1, 2)
    n = len(pts)
    out = np.full(n, np.nan)

    px = lon2tile(pts[:, 0], z) * 256.0
    py = np.array([lat2tile(la, z) for la in pts[:, 1]]) * 256.0
    tx = np.floor(px / 256).astype(int)
    ty = np.floor(py / 256).astype(int)

    for key in {(int(a), int(b)) for a, b in zip(tx, ty)}:
        m = (tx == key[0]) & (ty == key[1])
        tile = _load_tile(z, key[0], key[1])
        if tile is None:
            continue
        ix = np.clip((px[m] - key[0] * 256).astype(int), 0, 255)
        iy = np.clip((py[m] - key[1] * 256).astype(int), 0, 255)
        out[m] = tile[iy, ix]
    return out


def window(lon: float, lat: float, half_km: float, n: int = 41,
           z: int = DEFAULT_Z) -> np.ndarray | None:
    """An n x n elevation grid centred on (lon, lat), spanning 2*half_km."""
    mpp = m_per_px(lat, z)
    half_px = (half_km * 1000.0) / mpp
    cx = lon2tile(lon, z) * 256.0
    cy = lat2tile(lat, z) * 256.0
    step = (half_px * 2) / (n - 1)

    gx, gy = np.meshgrid(np.arange(n), np.arange(n))
    px = cx - half_px + gx * step
    py = cy - half_px + gy * step

    grid = np.full((n, n), np.nan)
    tx = np.floor(px / 256).astype(int)
    ty = np.floor(py / 256).astype(int)
    for key in {(int(a), int(b)) for a, b in zip(tx.ravel(), ty.ravel())}:
        m = (tx == key[0]) & (ty == key[1])
        tile = _load_tile(z, key[0], key[1])
        if tile is None:
            continue
        ix = np.clip((px[m] - key[0] * 256).astype(int), 0, 255)
        iy = np.clip((py[m] - key[1] * 256).astype(int), 0, 255)
        grid[m] = tile[iy, ix]
    if np.isnan(grid).mean() > 0.5:
        return None
    return grid


def stats(lon: float, lat: float, half_km: float = 2.0, n: int = 41,
          z: int = DEFAULT_Z):
    """The same four numbers the browser computes, so the two agree.

    Returns dict with elev, hand (height above nearest low ground), relief_up,
    slope_deg, steep_near — or None if the tiles were unavailable."""
    grid = window(lon, lat, half_km, n, z)
    if grid is None:
        return None
    c = (n - 1) // 2
    elev = grid[c, c]
    if not np.isfinite(elev):
        return None
    mpc = (half_km * 2000.0) / (n - 1)

    yy, xx = np.mgrid[0:n, 0:n]
    dist = np.hypot(xx - c, yy - c)

    near = grid[(dist <= min(c, 1500 / mpc)) & np.isfinite(grid)]
    hand = float(elev - near.min()) if near.size else 0.0

    up = grid[(dist <= min(c, 1200 / mpc)) & np.isfinite(grid)]
    relief_up = float(up.max() - elev) if up.size else 0.0

    # slope at the centre, from the 8 neighbours
    g = 0.0
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1):
            if di == 0 and dj == 0:
                continue
            v = grid[c + dj, c + di]
            if not np.isfinite(v):
                continue
            g = max(g, abs(v - elev) / (math.hypot(di, dj) * mpc))
    slope_deg = math.degrees(math.atan(g))

    # steepest ground within ~600 m
    gy, gx = np.gradient(grid, mpc)
    grad = np.hypot(gx, gy)
    mask = (dist <= min(c, 600 / mpc)) & np.isfinite(grad)
    steep_near = math.degrees(math.atan(float(grad[mask].max()))) if mask.any() else 0.0

    return {
        "elev": round(float(elev), 1),
        "hand": round(max(0.0, hand), 1),
        "relief_up": round(max(0.0, relief_up), 1),
        "slope_deg": round(slope_deg, 2),
        "steep_near": round(steep_near, 2),
    }
