"""Best-effort resource limits, safe to call on any platform."""


def apply_memory_cap(max_bytes: int) -> bool:
    """Best-effort virtual-memory cap for the current process.

    Returns whether the cap was actually applied. A no-op (not an error) on
    platforms without POSIX rlimits - notably Windows, this app's target OS -
    since the archive relies on the job runner's own concurrency limit as the
    real memory control, not a per-process hard cap.
    """
    try:
        import resource
    except ImportError:
        return False
    try:
        resource.setrlimit(resource.RLIMIT_AS, (max_bytes, max_bytes))
        return True
    except (ValueError, OSError):
        return False
