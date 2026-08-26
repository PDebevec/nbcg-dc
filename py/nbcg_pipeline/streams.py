"""Cross-platform stdout/stderr handling.

Windows consoles default to a legacy ANSI code page (cp1250 on the machine
that first hit this), which cannot encode Cyrillic - so printing a JSON
summary containing a Cyrillic folder name raises `UnicodeEncodeError` and
kills the process after the real work is already done. Since the summary on
stdout is the machine-readable half of the seam-4 contract, and Montenegrin
material is routinely Cyrillic, the streams are pinned to UTF-8 rather than
left to the environment.
"""

import sys


def force_utf8_streams() -> None:
    """Make stdout/stderr UTF-8 regardless of the console's code page.

    stderr additionally uses `backslashreplace` so a log line can never take
    the process down, even if the stream ends up somewhere stricter.
    """
    for stream, errors in ((sys.stdout, "strict"), (sys.stderr, "backslashreplace")):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors=errors)
            except (ValueError, OSError):
                # A stream that refuses reconfiguration (already detached, or a
                # non-text wrapper) is not worth failing the run over.
                pass
