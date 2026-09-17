/**
 * answer-key.js
 * ------------------------------------------------------------------------
 * The answer key is the one place "what is correct" is allowed to live.
 * It is always authored or confirmed by a human (manual entry now,
 * optionally OCR-assisted "suggestion" later) — this module never
 * invents an answer, and it refuses to score a question that has no
 * explicit entry rather than assume a default.
 * ------------------------------------------------------------------------
 */

import { AnswerState } from '../core/confidence.js';

let _autoId = 0;
function nextId(prefix) {
  _autoId += 1;
  return `${prefix}_${Date.now().toString(36)}_${_autoId.toString(36)}`;
}

/** Where a key entry's value came from. AI_SUGGESTED entries must be
 * confirmed by a teacher (see confirmEntry) before they can be used to
 * grade — see isGradable(). */
export const KeyEntrySource = Object.freeze({
  MANUAL: 'MANUAL',
  IMPORTED: 'IMPORTED',
  AI_SUGGESTED: 'AI_SUGGESTED'
});

/**
 * @typedef {object} AnswerKeyEntry
 * @property {number} questionNumber
 * @property {string[]} correctOptions   - one or more correct options
 * @property {boolean} excluded          - true = intentionally not scored
 *   (question voided, ambiguous on the paper, etc.)
 * @property {number|null} marksOverride
 * @property {number|null} negativeMarksOverride
 * @property {string} source             - KeyEntrySource
 * @property {boolean} confirmed         - must be true for AI_SUGGESTED
 *   entries before grading will use them
 */

/**
 * @typedef {object} AnswerKey
 * @property {string} id
 * @property {string} testId
 * @property {number} version
 * @property {Object.<number, AnswerKeyEntry>} entries  - keyed by questionNumber
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} notes
 */

export function createAnswerKey({ testId, version = 1, notes = '' } = {}) {
  if (!testId) throw new RangeError('AnswerKey requires a testId');
  const now = new Date().toISOString();
  return { id: nextId('key'), testId, version, entries: {}, createdAt: now, updatedAt: now, notes };
}

function makeEntry({
  questionNumber,
  correctOptions,
  excluded = false,
  marksOverride = null,
  negativeMarksOverride = null,
  source = KeyEntrySource.MANUAL
}) {
  if (!Number.isInteger(questionNumber) || questionNumber < 1) {
    throw new RangeError(`questionNumber must be a positive integer, got ${questionNumber}`);
  }
  if (!excluded && (!Array.isArray(correctOptions) || correctOptions.length === 0)) {
    throw new RangeError(`Question ${questionNumber} needs at least one correct option, or must be marked excluded`);
  }
  return {
    questionNumber,
    correctOptions: excluded ? [] : [...correctOptions],
    excluded,
    marksOverride,
    negativeMarksOverride,
    source,
    confirmed: source !== KeyEntrySource.AI_SUGGESTED
  };
}

/**
 * Set (or overwrite) the correct answer for one question. Returns a NEW
 * AnswerKey (immutable-update style) so storage.js can diff/version
 * changes if needed.
 *
 * @param {AnswerKey} key
 * @param {object} entryParams - see makeEntry
 * @returns {AnswerKey}
 */
export function setAnswer(key, entryParams) {
  const entry = makeEntry(entryParams);
  return {
    ...key,
    entries: { ...key.entries, [entry.questionNumber]: entry },
    updatedAt: new Date().toISOString()
  };
}

/** Mark a question as intentionally excluded from scoring (voided). */
export function excludeQuestion(key, questionNumber) {
  return setAnswer(key, { questionNumber, correctOptions: [], excluded: true });
}

/**
 * Remove a question's key entry entirely (back to "not yet keyed"),
 * e.g. when a teacher deselects the last correct option in the UI.
 * This is the correct way to clear an entry — passing an empty
 * correctOptions array to setAnswer is rejected unless excluded=true,
 * since an empty non-excluded entry would silently mean "no correct
 * answer", which is never a valid state to save.
 * @param {AnswerKey} key
 * @param {number} questionNumber
 * @returns {AnswerKey}
 */
export function clearAnswer(key, questionNumber) {
  const { [questionNumber]: _removed, ...rest } = key.entries;
  return { ...key, entries: rest, updatedAt: new Date().toISOString() };
}

/**
 * A teacher confirming an AI-suggested key entry. Only confirmed
 * entries are gradable — see isGradable().
 */
export function confirmEntry(key, questionNumber) {
  const existing = key.entries[questionNumber];
  if (!existing) throw new RangeError(`No key entry for question ${questionNumber}`);
  return {
    ...key,
    entries: { ...key.entries, [questionNumber]: { ...existing, confirmed: true } },
    updatedAt: new Date().toISOString()
  };
}

/**
 * Whether question `n` can currently be graded: it must have an entry,
 * and that entry must be confirmed (manual/imported entries are
 * confirmed by construction; AI-suggested ones need an explicit
 * confirmEntry call first).
 * @param {AnswerKey} key
 * @param {number} questionNumber
 * @returns {boolean}
 */
export function isGradable(key, questionNumber) {
  const entry = key.entries[questionNumber];
  return !!entry && entry.confirmed;
}

/**
 * Cross-check an answer key against a test's active questions. Reports
 * anything missing or extraneous rather than silently defaulting.
 * @param {AnswerKey} key
 * @param {import('./test-model.js').TestDefinition} test
 * @returns {{missing: number[], unconfirmed: number[], extraneous: number[]}}
 */
export function validateAgainstTest(key, test) {
  const excludedByTest = new Set(test.excludedQuestions);
  const missing = [];
  const unconfirmed = [];
  for (let n = 1; n <= test.totalQuestions; n += 1) {
    if (excludedByTest.has(n)) continue;
    const entry = key.entries[n];
    if (!entry) {
      missing.push(n);
    } else if (!entry.confirmed) {
      unconfirmed.push(n);
    }
  }
  const extraneous = Object.keys(key.entries)
    .map(Number)
    .filter((n) => n > test.totalQuestions);
  return { missing, unconfirmed, extraneous };
}

/**
 * @typedef {object} QuestionScore
 * @property {number} questionNumber
 * @property {boolean|null} isCorrect  - null when ungradeable/unscored
 * @property {number} pointsAwarded
 * @property {string} reason           - short machine-readable reason code
 */

/**
 * Score exactly one DetectedAnswer against the key. Pure function, no
 * side effects, no storage access — grading.js composes this over a
 * whole sheet.
 *
 * @param {import('./question-model.js').DetectedAnswer} detected
 * @param {AnswerKey} key
 * @param {import('./question-model.js').QuestionDefinition} questionDef
 * @returns {QuestionScore}
 */
export function scoreAnswer(detected, key, questionDef) {
  const base = { questionNumber: detected.questionNumber, isCorrect: null, pointsAwarded: 0 };

  if (detected.state === AnswerState.UNUSED || !questionDef.active) {
    return { ...base, reason: 'UNUSED_QUESTION' };
  }

  const entry = key.entries[detected.questionNumber];
  if (!entry || entry.excluded) {
    return { ...base, reason: entry ? 'EXCLUDED_BY_KEY' : 'NO_KEY_ENTRY' };
  }
  if (!entry.confirmed) {
    return { ...base, reason: 'KEY_ENTRY_UNCONFIRMED' };
  }

  if (detected.state === AnswerState.MISSING) {
    return { ...base, isCorrect: false, pointsAwarded: 0, reason: 'BLANK' };
  }
  if (detected.state === AnswerState.UNCLEAR || detected.state === AnswerState.NOT_DETECTED) {
    // Never guess: an unreadable mark is neither right nor wrong until
    // a human resolves it.
    return { ...base, reason: 'NEEDS_REVIEW' };
  }
  if (detected.state === AnswerState.MULTIPLE && !questionDef.allowsMultiple) {
    // Convention on most OMR sheets: multiple marks on a single-answer
    // question is treated as wrong, not reviewed forever — but we still
    // report why.
    const marks = entry.marksOverride ?? questionDef.marks;
    const neg = entry.negativeMarksOverride ?? questionDef.negativeMarks;
    return { ...base, isCorrect: false, pointsAwarded: neg > 0 ? -neg : 0, reason: 'MULTIPLE_MARKS' };
  }

  const marks = entry.marksOverride ?? questionDef.marks;
  const neg = entry.negativeMarksOverride ?? questionDef.negativeMarks;
  const selected = new Set(detected.selectedOptions);
  const correct = new Set(entry.correctOptions);
  const isCorrect =
    selected.size === correct.size && [...selected].every((o) => correct.has(o));

  return {
    ...base,
    isCorrect,
    pointsAwarded: isCorrect ? marks : (neg > 0 ? -neg : 0),
    reason: isCorrect ? 'CORRECT' : 'INCORRECT'
  };
}
