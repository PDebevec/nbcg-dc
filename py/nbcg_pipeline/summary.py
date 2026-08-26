"""The seam-4 stdout contract: one JSON summary object per run.

Each script defines its own summary dataclass - the fields genuinely differ
between a spread-splitter, a PDF builder and an OCR pass - so this only
standardises the serialization, not the shape.
"""

import dataclasses
import json


def print_summary(summary) -> None:
    """Print a dataclass instance as the run's JSON summary on stdout.

    `ensure_ascii=False` keeps Cyrillic filenames readable rather than
    escaped, matching what the summary is for: a human or another process
    reading real folder/file names back out.
    """
    print(json.dumps(dataclasses.asdict(summary), indent=2, ensure_ascii=False))
