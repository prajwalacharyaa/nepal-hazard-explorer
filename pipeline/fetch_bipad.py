"""Fetch all incidents from the Nepal BIPAD / DRR Portal open API.

Resumable. Writes newline-delimited JSON so a dropped connection never loses
progress — just run it again and it continues from where it stopped.

Output: data/raw/bipad_incidents.jsonl   (one raw record per line)
        data/raw/bipad_hazards.json      (hazard label frequency, for HAZARD_MAP)

No API key. Public endpoint. Offset pagination.
"""
from __future__ import annotations

import json
import sys
import time
from collections import Counter

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from config import RAW

BASE = "https://bipadportal.gov.np/api/v1/incident/"
LIMIT = 500
EXPAND = "loss,hazard"
ORDERING = "incident_on"
OUT = RAW / "bipad_incidents.jsonl"

session = requests.Session()
session.mount("https://", HTTPAdapter(max_retries=Retry(
    total=6, backoff_factor=1.5,
    status_forcelist=[429, 500, 502, 503, 504],
    allowed_methods=["GET"],
)))


def fetch_page(offset: int) -> list[dict]:
    params = {"limit": LIMIT, "offset": offset, "expand": EXPAND, "ordering": ORDERING}
    # extra outer loop for DNS / connection resets that Retry() does not cover
    for attempt in range(8):
        try:
            r = session.get(BASE, params=params, timeout=90)
            r.raise_for_status()
            return r.json().get("results", [])
        except (requests.RequestException, ValueError) as e:
            wait = min(60, 2 ** attempt)
            print(f"  ! offset {offset}: {e.__class__.__name__} — wait {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise SystemExit(f"repeatedly failed at offset {offset}; re-run to resume")


def count_existing() -> int:
    if not OUT.exists():
        return 0
    with OUT.open("r", encoding="utf-8") as fh:
        return sum(1 for _ in fh)


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    have = count_existing()
    offset = (have // LIMIT) * LIMIT  # re-fetch the tail partial page, dedupe later
    if have:
        print(f"resuming: {have} records on disk, restarting at offset {offset}")
        # trim to a clean page boundary so we don't double-count
        _trim_to(offset)

    with OUT.open("a", encoding="utf-8") as fh:
        while True:
            batch = fetch_page(offset)
            for rec in batch:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fh.flush()
            offset += len(batch)
            print(f"  {offset} incidents")
            if len(batch) < LIMIT:
                break

    print(f"done: {offset} records -> {OUT}")
    _write_hazard_audit()


def _trim_to(n: int):
    lines = OUT.read_text(encoding="utf-8").splitlines()[:n]
    OUT.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def _write_hazard_audit():
    labels = Counter()
    with OUT.open("r", encoding="utf-8") as fh:
        for line in fh:
            r = json.loads(line)
            hz = r.get("hazard")
            label = hz.get("title") if isinstance(hz, dict) else hz
            labels[str(label)] += 1
    (RAW / "bipad_hazards.json").write_text(
        json.dumps(labels.most_common(), ensure_ascii=False, indent=1), encoding="utf-8"
    )
    for label, n in labels.most_common():
        print(f"  {n:7d}  {label}")


if __name__ == "__main__":
    main()
