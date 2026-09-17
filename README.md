# OMR Magic — Part 1

Smart OMR checking for teachers: understand the sheet → remember the
structure → read answers → check → store → help the teacher. This part
builds the data model, storage, grading engine, and a manual-entry UI.
**No scanning and no AI recognition are implemented or faked** — those
are Part 2 (computer vision / scanner) and Part 3 (AI-assisted
understanding). Everything here is real, working, deterministic
software that Part 2/3 plug into without any rewrites.

## Running it

Static site, no backend, no build step. Either:

- Open `index.html` directly in a modern browser, or
- Serve the folder (recommended, so the service worker + IndexedDB
  behave like they will on GitHub Pages): `python3 -m http.server` from
  inside this folder, then visit `http://localhost:8000`.

Deploy as-is to GitHub Pages — it's a static PWA.

## Project layout

```
index.html               app shell (nav rail + view containers)
css/style.css             design tokens + styles
manifest.json / sw.js      PWA installability + offline app-shell cache
js/app.js                 UI orchestrator — wires the modules below to the DOM
js/models/
  question-model.js        QuestionDefinition + DetectedAnswer + reconcileAnswers()
  test-model.js             TestDefinition, sections, buildQuestionDefinitions()
  answer-key.js             AnswerKey, setAnswer/exclude/clearAnswer, scoreAnswer()
  omr-template.js           OmrTemplate, RegionType, region validation
  sheet-model.js            ScannedSheet, StudentIdentity, ScanQuality
js/core/
  confidence.js             AnswerState enum + confidence-band helpers (the
                             one shared "exception model" everything else uses)
  document-understanding.js DocumentAnalyzer interface + registerAnalyzer() —
                             THE Part 2/3 integration seam — plus a
                             deterministic template/test reconciler
  grading.js                composes answer-key.js's scoreAnswer() over a
                             whole sheet/test, pure and deterministic
  storage.js                IndexedDB wrapper (tests, templates, answer
                             keys, sheets) + computeFingerprint()
```

## The core idea, in data

- An **OmrTemplate** describes what's physically on a sheet (regions:
  identity fields, question blocks, headers, etc.) — it can describe
  more bubbles than any one test uses.
- A **TestDefinition** declares what a specific test actually scores:
  real question count, marking scheme, sections, excluded questions.
- `reconcileTemplateWithTest(template, test)` (in
  `document-understanding.js`) is the deterministic logic that compares
  the two and works out which physical bubbles are unused — e.g. a
  50-bubble sheet used for a 15-question quiz reports Q16-Q50 as
  `unusedQuestions`, computed from data, never assumed from "every
  circle is a question."
- An **AnswerKey** holds correct options per question, entered by a
  teacher (or, later, AI-suggested and explicitly confirmed before
  it's ever used to grade — see `KeyEntrySource` / `isGradable()`).
  It never invents an answer for a question with no entry.
- A **ScannedSheet** holds one student's `DetectedAnswer[]`, each with
  an `AnswerState` (`CLEAR / UNCLEAR / MISSING / MULTIPLE / UNUSED /
  NOT_DETECTED`) and a confidence score — never a bare "right/wrong."
  `needsReview()` in `confidence.js` is the single gate that decides
  whether an observation is trustworthy enough to grade automatically
  or needs a teacher's eyes.
- `gradeSheet(test, key, sheet)` in `grading.js` turns all of the above
  into a score plus a `needsReview` list — pure, deterministic,
  no I/O.

## Integrating Part 2 (scanner / computer vision)

Implement `DocumentAnalyzer` from `js/core/document-understanding.js`
(`analyzeStructure`, `recognizeAnswers`, `recognizeIdentity`), call
`registerAnalyzer(yourAnalyzer)` once at startup, and produce
`DetectedAnswer` / `StudentIdentity` objects through the same
constructors `app.js`'s manual entry uses
(`createDetectedAnswer`, `createStudentIdentity`). Everything
downstream — reconciliation, grading, storage, review UI — already
works against those shapes and needs no changes.

## Integrating Part 3 (AI assistance)

AI output must land as a `DocumentUnderstandingResult` (structured
fields, not conversational text) or as `AI_SUGGESTED` answer-key
entries that stay unconfirmed (and therefore ungradable, see
`isGradable()`) until a teacher confirms them via `confirmEntry()`.
Ambiguous bubbles stay `UNCLEAR`/`MULTIPLE`/`NOT_DETECTED` for a human
to resolve — AI never overwrites an exception state with a guess.
