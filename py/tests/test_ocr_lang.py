"""Tests for the per-page script-selection policy (nbcg_pipeline.ocr_lang).

This is where the OCR speed fix's cost *and* its correctness both live: get it
wrong in one direction and every page is OCR'd twice again, get it wrong in
the other and a whole book comes out as garbage.

The second failure is not hypothetical - it was measured on real material in
this archive. On a Church Slavonic page the *Latin* recogniser reported
confidence 0.650 and produced `HLZLXNM + BLZAHM`, while the Cyrillic one
reported 0.457 and produced the actual text. Ranking by confidence therefore
picks the nonsense, which is why the policy ranks by how much was *read*
instead. `test_detection_prefers_the_script_that_read_more_text_not_the_more_confident_one`
pins that with the measured numbers.

Runs anywhere - no paddleocr, no models, no images. `LanguageStrategy` takes
an injected `ocr_one(lang) -> (raw_lines, confidence)`, so these drive it with
a scripted fake engine and assert on both the results and the number of
recognition calls actually made.
"""

import pytest

from nbcg_pipeline import LanguageStrategy, sample_indices
from nbcg_pipeline.ocr_lang import MIN_LETTERS_PER_LINE, read_quality

LANGS = ("rs_latin", "rs_cyrillic")

# Letters per line for a page that was genuinely read versus one the
# recogniser detected but could not read. Real measurements: correct readings
# came in at 13.7-37.8 letters/line, wrong ones at 1.2-1.9.
READ = 20
UNREAD = 1


class FakeEngine:
    """Scripted `(letters_per_line, lines, confidence)` per language, counting
    how many times each language was actually asked - the cost signal.

    Text is modelled rather than only a confidence number, because the
    confidence number is exactly what turned out to be misleading.
    """

    def __init__(self, per_lang):
        self.per_lang = per_lang
        self.calls = []

    def __call__(self, lang):
        self.calls.append(lang)
        letters_per_line, line_count, confidence = self.per_lang[lang]
        return [("poly", "x" * letters_per_line, confidence)] * line_count, confidence

    @property
    def count(self):
        return len(self.calls)


def page(latin, cyrillic):
    """One page: `(letters_per_line, lines, confidence)` for each script."""
    return FakeEngine({"rs_latin": latin, "rs_cyrillic": cyrillic})


def blank():
    return page(latin=(0, 0, 0.0), cyrillic=(0, 0, 0.0))


# --- the reading score ------------------------------------------------------


def test_read_quality_counts_letters_not_characters():
    """Punctuation and whitespace are not evidence that a line was read - the
    wrong recogniser returns plenty of both."""
    reading = read_quality([("poly", "  ,  .  ", 0.9), ("poly", "abcde", 0.9)])

    assert reading.lines == 2
    assert reading.letters == 5
    assert reading.letters_per_line == pytest.approx(2.5)


def test_read_quality_weights_letters_by_their_own_line_confidence():
    reading = read_quality([("poly", "abcd", 1.0), ("poly", "abcd", 0.5)])

    assert reading.letters == 8
    assert reading.confident_letters == pytest.approx(6.0)


def test_an_empty_reading_is_unread_rather_than_dividing_by_zero():
    reading = read_quality([])

    assert reading.lines == 0
    assert reading.letters_per_line == 0.0
    assert reading.looks_unread is True


# --- sampling ---------------------------------------------------------------


def test_sampling_avoids_the_covers_at_both_ends():
    """Page 1 of a real book is a cover and recognizes almost nothing, which
    is exactly the page a naive "first N" sample would decide on."""
    picked = sample_indices(391, sample_size=5)

    assert 0 not in picked
    assert 390 not in picked
    assert picked == sorted(picked), "sampling should stay in reading order"
    assert len(picked) == 5


def test_sampling_a_document_shorter_than_the_sample_takes_every_page():
    assert sample_indices(3, sample_size=5) == [0, 1, 2]
    assert sample_indices(0) == []


# --- detection --------------------------------------------------------------


def test_detection_prefers_the_script_that_read_more_text_not_the_more_confident_one():
    """The regression test for the bug this policy was rewritten to fix.

    Numbers are the real ones from ОКТОИХ петогласник p200: the Latin
    recogniser is *more* confident (0.650 vs 0.457) while reading 1.2
    letters/line against 14.8. Ranking on confidence chooses Latin and writes
    a 522-page file of nonsense; ranking on text read chooses Cyrillic.
    """
    samples = [
        page(latin=(1, 66, 0.650), cyrillic=(15, 66, 0.457)) for _ in range(3)
    ]

    strategy = LanguageStrategy(LANGS)

    assert strategy.detect(samples) == "rs_cyrillic"


def test_detection_still_picks_latin_on_a_latin_book():
    """The other direction, from Cèrnagora p50 - where the correct model is
    both more confident *and* reads more, so the two signals agree."""
    samples = [page(latin=(38, 30, 0.967), cyrillic=(36, 30, 0.929)) for _ in range(3)]

    strategy = LanguageStrategy(LANGS)

    assert strategy.detect(samples) == "rs_latin"


def test_detection_ignores_blank_pages_instead_of_letting_them_vote():
    """A blank page yields nothing for every script; letting it vote is how a
    book gets decided off a page with no text on it."""
    samples = [blank(), page(latin=(1, 50, 0.90), cyrillic=(25, 50, 0.60))]

    strategy = LanguageStrategy(LANGS)

    assert strategy.detect(samples) == "rs_cyrillic"


def test_detection_on_an_entirely_blank_sample_keeps_the_first_language():
    strategy = LanguageStrategy(LANGS)

    assert strategy.detect([blank(), blank()]) == LANGS[0]


def test_a_single_language_never_samples_at_all():
    """--lang with one value should skip detection entirely, not pay for it."""
    strategy = LanguageStrategy(("rs_latin",))
    sample = page(latin=(READ, 40, 0.95), cyrillic=(0, 0, 0.0))

    assert strategy.detect([sample]) == "rs_latin"
    assert sample.count == 0, "detection must not run for a single language"


# --- per-page behaviour -----------------------------------------------------


def test_a_page_that_reads_well_costs_one_recognition_pass():
    """The whole speed win: a page that yields text is never run twice."""
    strategy = LanguageStrategy(LANGS)
    good = page(latin=(READ, 40, 0.95), cyrillic=(UNREAD, 40, 0.40))

    _lines, score, used, retried = strategy.run_page(good)

    assert (used, retried) == ("rs_latin", False)
    assert score == pytest.approx(0.95)
    assert good.calls == ["rs_latin"], "a page that read well must not be retried"
    assert strategy.pages_retried == 0


def test_a_page_that_reads_well_is_not_retried_even_at_low_confidence():
    """Faint print and stains lower confidence without meaning the script is
    wrong. Retrying those was pure waste - the old threshold did exactly that,
    firing on a page scoring 0.748 where the retry could not help."""
    strategy = LanguageStrategy(LANGS)
    hard = page(latin=(READ, 48, 0.748), cyrillic=(READ - 2, 48, 0.680))

    _lines, _score, used, retried = strategy.run_page(hard)

    assert (used, retried) == ("rs_latin", False)
    assert hard.count == 1


def test_a_detected_but_unread_page_is_retried_and_the_better_reading_kept():
    strategy = LanguageStrategy(LANGS)
    odd_one_out = page(latin=(UNREAD, 44, 0.65), cyrillic=(READ, 44, 0.46))

    lines, _score, used, retried = strategy.run_page(odd_one_out)

    assert (used, retried) == ("rs_cyrillic", True)
    assert len(lines) == 44, "the winning script's lines must be the ones returned"
    assert strategy.pages_retried == 1


def test_a_retry_that_reads_no_better_keeps_the_primary_result():
    """A photo plate or a blank reads badly in every script. It still costs
    the retry, but must not flip the language on an equally poor alternative."""
    strategy = LanguageStrategy(LANGS)
    poor = page(latin=(UNREAD, 10, 0.40), cyrillic=(UNREAD, 10, 0.22))

    _lines, _score, used, retried = strategy.run_page(poor)

    assert (used, retried) == ("rs_latin", True)
    assert strategy.primary == "rs_latin"


def test_a_single_language_page_is_never_retried_however_badly_it_reads():
    strategy = LanguageStrategy(("rs_latin",))
    awful = page(latin=(0, 5, 0.05), cyrillic=(0, 0, 0.0))

    _lines, _score, used, retried = strategy.run_page(awful)

    assert (used, retried) == ("rs_latin", False)
    assert awful.count == 1
    assert strategy.pages_retried == 0


def test_the_retry_trigger_is_the_documented_letters_per_line_threshold():
    """Guards the calibration: the constant sits in a measured gap (1.2-1.9
    letters/line when wrong, 13.7+ when right), so a silent edit should fail a
    test rather than quietly change how often pages cost double."""
    strategy = LanguageStrategy(LANGS)
    just_above = page(
        latin=(int(MIN_LETTERS_PER_LINE) + 1, 10, 0.5), cyrillic=(READ, 10, 0.99)
    )
    just_below = page(
        latin=(int(MIN_LETTERS_PER_LINE) - 1, 10, 0.5), cyrillic=(READ, 10, 0.99)
    )

    assert strategy.run_page(just_above)[3] is False
    assert strategy.run_page(just_below)[3] is True


# --- adapting to a document that changes script halfway ---------------------


def test_the_primary_switches_after_repeated_retry_wins():
    """A book that is Latin then Cyrillic must not pay the retry on every page
    of the second half - after a few consecutive wins the other script becomes
    primary and pages cost one pass again."""
    strategy = LanguageStrategy(LANGS, switch_after=3)

    for _ in range(3):
        strategy.run_page(page(latin=(UNREAD, 40, 0.65), cyrillic=(READ, 40, 0.46)))

    assert strategy.primary == "rs_cyrillic"
    assert strategy.switches == 1

    after_switch = page(latin=(UNREAD, 40, 0.65), cyrillic=(READ, 40, 0.46))
    _lines, _score, used, retried = strategy.run_page(after_switch)

    assert (used, retried) == ("rs_cyrillic", False)
    assert after_switch.calls == ["rs_cyrillic"], "should cost one pass again"


def test_isolated_retry_wins_do_not_switch_the_primary():
    """One odd page in a Latin book - a Cyrillic quotation, a stamp - must not
    flip the whole document; only a run of them should."""
    strategy = LanguageStrategy(LANGS, switch_after=3)

    strategy.run_page(page(latin=(UNREAD, 40, 0.65), cyrillic=(READ, 40, 0.46)))
    strategy.run_page(page(latin=(READ, 40, 0.95), cyrillic=(UNREAD, 40, 0.20)))
    strategy.run_page(page(latin=(UNREAD, 40, 0.65), cyrillic=(READ, 40, 0.46)))

    assert strategy.primary == "rs_latin"
    assert strategy.switches == 0


def test_pages_retried_counts_only_pages_that_paid_for_two_passes():
    """Reported in the seam-4 summary as the cost signal, so it has to mean
    exactly that - not "pages where the other script won"."""
    strategy = LanguageStrategy(LANGS, switch_after=99)

    strategy.run_page(page(latin=(READ, 40, 0.95), cyrillic=(UNREAD, 40, 0.2)))
    strategy.run_page(page(latin=(UNREAD, 40, 0.65), cyrillic=(READ, 40, 0.46)))
    strategy.run_page(page(latin=(UNREAD, 10, 0.40), cyrillic=(UNREAD, 10, 0.22)))

    assert strategy.pages_retried == 2


def test_rejects_an_empty_language_list():
    with pytest.raises(ValueError):
        LanguageStrategy(())
