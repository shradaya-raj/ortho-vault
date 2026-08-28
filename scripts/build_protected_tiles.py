"""Build browser-ready tiles without modifying the source datasets.

Run with the bundled Codex Python or another Python containing rasterio and Pillow.
The output directory can be uploaded to the PRIVATE Supabase bucket under `tiles/`.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform_bounds

# ============================================================================
# EDIT THESE LOCATIONS ONLY
INPUT_RASTER = Path(r"C:\Users\Shradaya_Raj\Downloads\result.tif")  # <-- INPUT
INPUT_KML_DIRECTORY = Path(r"C:\Users\Shradaya_Raj\Downloads\Rasuwa-KML")  # <-- INPUT
OUTPUT_TILE_DIRECTORY = Path(r"C:\Users\Shradaya_Raj\Downloads\Rasuwa-Protected-Tiles")  # <-- OUTPUT
# ============================================================================

TILE_SIZE = 256
WEB_MERCATOR_LIMIT = 20037508.342789244
RASTER_ZOOMS = range(10, 21)
VECTOR_ZOOMS = range(8, 21)
KML_LAYERS = {
    "buildings": ("Flood_afftected_Buildings.kml", "Possible flood affected"),
    "local-governments": ("GaPaNaPa.kml", "Affected local government"),
    "river-corridor": ("1km-River-Boundary.kml", "1 km Trishuli River corridor boundary"),
    "trishuli-river": ("Trishuli-River.kml", "Trishuli River"),
}


def mercator_tile_bounds(x: int, y: int, z: int) -> tuple[float, float, float, float]:
    span = (WEB_MERCATOR_LIMIT * 2) / (1 << z)
    left = -WEB_MERCATOR_LIMIT + x * span
    right = left + span
    top = WEB_MERCATOR_LIMIT - y * span
    return left, top - span, right, top


def mercator_tile_range(bounds: tuple[float, float, float, float], z: int):
    left, bottom, right, top = bounds
    count = 1 << z
    span = (WEB_MERCATOR_LIMIT * 2) / count
    min_x = max(0, math.floor((left + WEB_MERCATOR_LIMIT) / span))
    max_x = min(count - 1, math.floor((right + WEB_MERCATOR_LIMIT) / span))
    min_y = max(0, math.floor((WEB_MERCATOR_LIMIT - top) / span))
    max_y = min(count - 1, math.floor((WEB_MERCATOR_LIMIT - bottom) / span))
    return range(min_x, max_x + 1), range(min_y, max_y + 1)


def build_raster_tiles(source: Path, output: Path) -> None:
    if not source.is_file():
        raise FileNotFoundError(f"Raster not found: {source}")
    with rasterio.open(source) as dataset:
        bounds_3857 = transform_bounds(dataset.crs, "EPSG:3857", *dataset.bounds, densify_pts=21)
        with WarpedVRT(dataset, crs="EPSG:3857", add_alpha=True) as vrt:
            alpha_band = vrt.count
            rgb_bands = list(range(1, min(3, dataset.count) + 1))
            if len(rgb_bands) < 3:
                rgb_bands = [1, 1, 1]
            for z in RASTER_ZOOMS:
                xs, ys = mercator_tile_range(bounds_3857, z)
                for x in xs:
                    for y in ys:
                        bounds = mercator_tile_bounds(x, y, z)
                        window = rasterio.windows.from_bounds(*bounds, transform=vrt.transform)
                        rgb = vrt.read(rgb_bands, window=window, out_shape=(3, TILE_SIZE, TILE_SIZE), resampling=Resampling.bilinear, boundless=True, fill_value=0)
                        alpha = vrt.read(alpha_band, window=window, out_shape=(TILE_SIZE, TILE_SIZE), resampling=Resampling.nearest, boundless=True, fill_value=0)
                        if not alpha.any():
                            continue
                        rgba = np.dstack((np.moveaxis(rgb, 0, -1), alpha)).astype(np.uint8)
                        tile_path = output / "drone" / str(z) / str(x) / f"{y}.webp"
                        tile_path.parent.mkdir(parents=True, exist_ok=True)
                        Image.fromarray(rgba, "RGBA").save(tile_path, "WEBP", quality=86, method=4)


def parse_coordinates(text: str) -> list[list[float]]:
    result = []
    for item in re.split(r"\s+", text.strip()):
        values = item.split(",")
        if len(values) >= 2:
            result.append([float(values[0]), float(values[1])])
    return result


def iter_kml_features(path: Path, safe_label: str):
    root = ET.parse(path).getroot()
    for placemark in root.findall(".//{*}Placemark"):
        name_node = placemark.find("./{*}name")
        safe_name = (name_node.text or "").strip() if name_node is not None else ""
        properties = {"label": safe_name or safe_label}
        for point in placemark.findall(".//{*}Point/{*}coordinates"):
            coords = parse_coordinates(point.text or "")
            if coords:
                yield {"type": "Feature", "properties": properties, "geometry": {"type": "Point", "coordinates": coords[0]}}
        for line in placemark.findall(".//{*}LineString/{*}coordinates"):
            coords = parse_coordinates(line.text or "")
            if coords:
                yield {"type": "Feature", "properties": properties, "geometry": {"type": "LineString", "coordinates": coords}}
        for polygon in placemark.findall(".//{*}Polygon"):
            rings = []
            for coordinates in polygon.findall(".//{*}LinearRing/{*}coordinates"):
                ring = parse_coordinates(coordinates.text or "")
                if ring:
                    rings.append(ring)
            if rings:
                yield {"type": "Feature", "properties": properties, "geometry": {"type": "Polygon", "coordinates": rings}}


def walk_positions(value):
    if value and isinstance(value[0], (int, float)):
        yield value
    else:
        for child in value:
            yield from walk_positions(child)


def lonlat_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    lat = max(-85.05112878, min(85.05112878, lat))
    n = 1 << z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def build_vector_tiles(kml_directory: Path, output: Path) -> None:
    for layer, (filename, label) in KML_LAYERS.items():
        source = kml_directory / filename
        if not source.is_file():
            print(f"Skipping missing {source}")
            continue
        features = list(iter_kml_features(source, label))
        for z in VECTOR_ZOOMS:
            tiles = defaultdict(list)
            for feature in features:
                positions = list(walk_positions(feature["geometry"]["coordinates"]))
                xs, ys = zip(*(lonlat_tile(lon, lat, z) for lon, lat in positions))
                for x in range(min(xs), max(xs) + 1):
                    for y in range(min(ys), max(ys) + 1):
                        tiles[(x, y)].append(feature)
            for (x, y), tile_features in tiles.items():
                tile_path = output / layer / str(z) / str(x) / f"{y}.json"
                tile_path.parent.mkdir(parents=True, exist_ok=True)
                tile_path.write_text(json.dumps({"type": "FeatureCollection", "features": tile_features}, separators=(",", ":")), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raster", action="store_true", help="Build imagery tiles")
    parser.add_argument("--vectors", action="store_true", help="Build tiled KML derivatives")
    args = parser.parse_args()
    if not args.raster and not args.vectors:
        parser.error("Choose --raster, --vectors, or both")
    OUTPUT_TILE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    if args.raster:
        build_raster_tiles(INPUT_RASTER, OUTPUT_TILE_DIRECTORY)
    if args.vectors:
        build_vector_tiles(INPUT_KML_DIRECTORY, OUTPUT_TILE_DIRECTORY)


if __name__ == "__main__":
    main()
