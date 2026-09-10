"""What this machine can actually run OCR on, decided at startup.

Deliberately small. The rule is: ask whether a GPU is genuinely usable, use it
if so, and fall back to the CPU otherwise - including when "usable" turned out
to be a lie and the engine failed to build. Nothing here tunes or benchmarks;
it only answers "which device, and how many threads".

**GPU is rarer than it looks.** Three things must all hold, and the usual
missing one is the last:

1. an NVIDIA GPU is present (PaddlePaddle's GPU support is CUDA; an Intel or
   AMD integrated GPU does not count, however capable it is);
2. its driver and the CUDA runtime are installed;
3. **paddlepaddle itself is the GPU build.** The plain `paddlepaddle` wheel
   pinned in py/requirements.txt is CPU-only and reports
   `is_compiled_with_cuda() == False` no matter what hardware it is on.
   Switching that to `paddlepaddle-gpu` is a packaging decision (it is several
   GB and drags in CUDA), not something this module can do.

So on a stock install this reports CPU, correctly, and that is not a bug.
`describe()` says *which* of the three was missing, so the answer is
diagnosable rather than a bare "no".

Thread count is deliberately **not** scaled up with core count. Measured on a
22-core machine, one process per configuration:

    threads   1      2      4      6      10     16
    s/page    20.00  20.20  22.37  23.99  25.25  27.57

These are small mobile models; more threads only buys more contention. A big
machine is used by running more *items* at once - which is the job runner's
concurrency cap, not this - so the thread count stays low and steady, and only
drops on a machine too small to give one process two threads.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

# Per-process inference threads on CPU. See the module docstring for the
# measurements: this is a measured plateau, not a conservative guess.
CPU_THREADS = 2

# A GPU runs the whole graph on-device; the CPU thread count then only affects
# pre/post-processing, and PaddleOCR's own default is fine there.
GPU_CPU_THREADS = 4


@dataclass(frozen=True)
class DeviceChoice:
    """The decision, plus enough context to explain it in a log line."""

    device: str          # "gpu" or "cpu"
    cpu_threads: int
    reason: str
    logical_cores: int

    def describe(self) -> str:
        return (
            f"device={self.device}, cpu_threads={self.cpu_threads}, "
            f"cores={self.logical_cores} ({self.reason})"
        )


def logical_cores() -> int:
    return os.cpu_count() or 1


def _gpu_status() -> tuple[bool, str]:
    """(usable, why). Never raises - a probe that throws is just a 'no'."""
    try:
        import paddle
    except Exception as exc:  # paddle missing or broken - CPU it is
        return False, f"paddle unavailable ({type(exc).__name__})"

    try:
        if not paddle.device.is_compiled_with_cuda():
            return False, "paddlepaddle is the CPU-only build"
        count = paddle.device.cuda.device_count()
    except Exception as exc:
        return False, f"CUDA probe failed ({type(exc).__name__})"

    if count < 1:
        return False, "no CUDA device present"
    return True, f"{count} CUDA device(s)"


def detect(prefer_gpu: bool = True) -> DeviceChoice:
    """Pick a device for OCR. `prefer_gpu=False` forces CPU without probing -
    the escape hatch for a machine where the GPU path misbehaves."""
    cores = logical_cores()

    if not prefer_gpu:
        return DeviceChoice("cpu", min(CPU_THREADS, cores), "GPU disabled by request", cores)

    usable, why = _gpu_status()
    if usable:
        return DeviceChoice("gpu", min(GPU_CPU_THREADS, cores), why, cores)
    return DeviceChoice("cpu", min(CPU_THREADS, cores), why, cores)


def cpu_fallback(reason: str) -> DeviceChoice:
    """The choice to use after a GPU engine failed to build or run. Separate
    from `detect` so the caller's log says the GPU was *tried and failed*,
    rather than quietly reporting it was never available."""
    cores = logical_cores()
    return DeviceChoice("cpu", min(CPU_THREADS, cores), f"GPU failed, fell back: {reason}", cores)
