"""Which script to OCR each page as, and when to pay for a second attempt.

`ocr.py` used to run *every* configured language over *every* page and keep
the best-scoring result - an exact 2x on the dominant cost of a run, on the
assumption that any page might be either script. A book is normally one
script throughout, so that is nearly all waste; but some documents in this
archive genuinely do mix Latin and Cyrillic, so simply picking one script per
document would silently lose the pages that differ.

This module holds the compromise: detect the dominant script from a sample of
pages, run only that, and retry a page with another script only when it reads
badly enough to suggest it is one of the odd ones out. Pages that recognize
confidently cost 1x; only genuinely ambiguous ones cost 2x.

It lives here, rather than in `ocr.py`, for the same reason `pdf_text` does:
`ocr.py` cannot be imported at all without paddleocr installed, and this is
pure policy - no engine, no models, no recognition - so keeping it separate
means the part where the cost and the correctness both live is unit testable
anywhere. Unlike `pdf_text` it pulls in no third-party dependency at all, so
it *is* re-exported from the package's `__init__`.
"""
from __future__ import annotations

from dataclasses import dataclass

# Pages sampled to decide the dominant script. Both languages run on these, so
# this is the fixed 2x cost of a run; everything after it is 1x on confident
# pages.
LANG_SAMPLE_PAGES = 5

# How much text a page has to yield before its reading is believed.
#
# **Confidence is not that signal, and using it gets the answer backwards.**
# Measured on two real books from this archive - a Church Slavonic one
# (ОКТОИХ петогласник) and a Latin one (Cèrnagora):
#
#     ОКТОИХ p200   latin rec:  conf 0.650   81 letters    1.2 letters/line
#                   cyril rec:  conf 0.457  980 letters   14.8 letters/line
#
# The Latin recogniser is *more* confident on a Cyrillic page and produces
# `HLZLXNM + BLZAHM`; the Cyrillic one is less confident and produces the real
# text. Ranking by confidence picks the garbage. A recogniser facing an
# alphabet it cannot read still *detects* the lines - the line counts are
# identical, 66 either way - it just returns them nearly empty. So the signal
# is how much was actually read, not how sure the model was about it.
#
# Correct readings measured 13.7-37.8 letters/line; wrong ones 1.2-1.9. This
# threshold sits in that gap with room on both sides.
MIN_LETTERS_PER_LINE = 5.0

# After this many consecutive pages where the retry beat the primary, the retry
# language becomes the primary. Handles the common "Latin first half, Cyrillic
# second half" shape without paying the retry on every page of the second half.
LANG_SWITCH_AFTER = 3


@dataclass(frozen=True)
class Reading:
    """What one recogniser actually got off one page.

    `confident_letters` - letters weighted by the confidence of the line they
    came from - is the ranking score. It rewards reading a lot of text *and*
    being sure of it, and collapses for a recogniser that returns empty lines
    however confident it claims to be. On the pages measured above it
    separates the correct model by 5x on the Cyrillic book, where raw
    confidence ranked the wrong model first.
    """

    lines: int
    letters: int
    confident_letters: float
    avg_confidence: float

    @property
    def letters_per_line(self) -> float:
        return self.letters / self.lines if self.lines else 0.0

    @property
    def looks_unread(self) -> bool:
        """True when this page came back as detected-but-not-read - the
        fingerprint of the wrong script."""
        return self.lines == 0 or self.letters_per_line < MIN_LETTERS_PER_LINE


def read_quality(raw_lines) -> Reading:
    """Score one recogniser's output for a page.

    `raw_lines` is whatever the caller's `ocr_one` returns per line; only
    `line[1]` (the text) and `line[2]` (that line's confidence) are read, which
    is the shape `ocr.py` already passes through from PaddleOCR.
    """
    lines = len(raw_lines)
    letters = 0
    confident = 0.0
    total_conf = 0.0
    for line in raw_lines:
        text = line[1] if len(line) > 1 else ""
        score = float(line[2]) if len(line) > 2 else 0.0
        n = sum(1 for c in str(text) if c.isalpha())
        letters += n
        confident += n * score
        total_conf += score
    return Reading(
        lines=lines,
        letters=letters,
        confident_letters=confident,
        avg_confidence=(total_conf / lines) if lines else 0.0,
    )


def sample_indices(page_count: int, sample_size: int = LANG_SAMPLE_PAGES) -> list[int]:
    """Evenly spread page indices to sample for script detection.

    Deliberately interior. Covers, title pages and blanks recognize few or no
    lines, so sampling from the front - the obvious choice - is exactly the one
    that carries no signal: page 2 of the first book this was measured on
    returns zero lines in either script.
    """
    if page_count <= 0:
        return []
    if page_count <= sample_size:
        return list(range(page_count))

    step = page_count / (sample_size + 1)
    picked: list[int] = []
    for i in range(sample_size):
        index = min(page_count - 1, int(step * (i + 1)))
        if index not in picked:
            picked.append(index)
    return picked


class LanguageStrategy:
    """Chooses the script to run per page, and tracks what that cost.

    Knows nothing about PaddleOCR: every recognition goes through an injected
    ``ocr_one(lang) -> (raw_lines, avg_confidence)``, where ``raw_lines`` is
    whatever the caller wants back for a winning page (``ocr.py`` passes the
    ``(poly, text, score)`` triples). Logging is injected the same way, so this
    module stays free of both the engine and a logger.
    """

    def __init__(
        self,
        langs,
        min_letters_per_line: float = MIN_LETTERS_PER_LINE,
        switch_after: int = LANG_SWITCH_AFTER,
        log=None,
    ):
        if not langs:
            raise ValueError("at least one language is required")
        self.langs = tuple(langs)
        self.min_letters_per_line = min_letters_per_line
        self.switch_after = switch_after
        self.primary = self.langs[0]
        self.pages_retried = 0
        self.switches = 0
        self._log = log or (lambda _message: None)
        self._consecutive_retry_wins = 0

    @property
    def multilingual(self) -> bool:
        return len(self.langs) > 1

    def detect(self, samples) -> str:
        """Pick the dominant script from `samples`, an iterable of `ocr_one`.

        Ranked by `confident_letters` summed across the sampled pages - how
        much text each recogniser actually read, weighted by how sure it was.
        Not by confidence: a recogniser facing the wrong alphabet reports high
        confidence about near-empty lines, so ranking on confidence alone
        picked the wrong model on this archive's Church Slavonic book and
        would have written a 522-page file of nonsense.
        """
        if not self.multilingual:
            return self.primary

        totals = {lang: 0.0 for lang in self.langs}
        letters = {lang: 0 for lang in self.langs}
        for ocr_one in samples:
            for lang in self.langs:
                raw_lines, _score = ocr_one(lang)
                reading = read_quality(raw_lines)
                totals[lang] += reading.confident_letters
                letters[lang] += reading.letters

        if not any(letters[lang] for lang in self.langs):
            self._log(
                f"No text found in any sampled page; defaulting to {self.primary} "
                "(the per-page retry still applies)"
            )
            return self.primary

        # max() keeps the first language on a tie, matching self.langs order.
        self.primary = max(self.langs, key=lambda lang: totals[lang])
        self._log(
            "Dominant script: "
            + ", ".join(
                f"{lang}={totals[lang]:.0f} confident letters "
                f"({letters[lang]} read)"
                for lang in self.langs
            )
            + f" -> using {self.primary}"
        )
        return self.primary

    def run_page(self, ocr_one):
        """OCR one page, retrying with another script only if it reads badly.

        Returns ``(raw_lines, confidence, lang_used, retried)``.

        "Reads badly" means the page came back detected but not *read* - lines
        found, almost no letters in them - which is what the wrong script looks
        like. A page that is simply hard (faint print, a stain) still yields
        letters and is left alone, so it does not pay for a retry that cannot
        help it.
        """
        raw_lines, score = ocr_one(self.primary)
        used = self.primary
        best = read_quality(raw_lines)

        if not self.multilingual or best.letters_per_line >= self.min_letters_per_line:
            self._consecutive_retry_wins = 0
            return raw_lines, score, used, False

        self.pages_retried += 1
        for lang in self.langs:
            if lang == self.primary:
                continue
            other_lines, other_score = ocr_one(lang)
            other = read_quality(other_lines)
            if other.confident_letters > best.confident_letters:
                raw_lines, score, used, best = other_lines, other_score, lang, other

        if used != self.primary:
            self._consecutive_retry_wins += 1
            if self._consecutive_retry_wins >= self.switch_after:
                self._log(
                    f"{self._consecutive_retry_wins} consecutive pages read better "
                    f"as {used}; switching primary script {self.primary} -> {used}"
                )
                self.primary = used
                self.switches += 1
                self._consecutive_retry_wins = 0
        else:
            self._consecutive_retry_wins = 0

        return raw_lines, score, used, True
