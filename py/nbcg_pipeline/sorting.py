"""Sort keys shared across the pipeline scripts."""

import re
from pathlib import Path


def natural_key(path: Path) -> list:
    """Sort key that reads digit runs as numbers, so `2` precedes `10`."""
    return [
        int(part) if part.isdigit() else part.lower()
        for part in re.split(r"(\d+)", path.name)
    ]
