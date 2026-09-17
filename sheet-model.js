/**
 * sheet-model.js
 * ------------------------------------------------------------------------
 * A ScannedSheet is the record of ONE student's paper: who they (appear
 * to) be, what was detected for each question, and how trustworthy the
 * scan overall was. It is intentionally a thin, storage-shaped wrapper
 * around question-model.js's DetectedAnswer[] — the actual bubble-level
 * exception logic lives there and in confidence.js; this module is
 * about assembling and summarizing a full sheet.
 * ------------------------------------------------------------------------
 */

import { AnswerState } from '../core/confidence.js';

let _autoId = 0;
function nextId(prefix) {
  _autoId += 1;
  return `${prefix}_${Date.now().toString(36)}_${_autoId.toString(36)}`;
}

/** @readonly @enum {string} */
export const IdentityState = Object.freeze({
  CLEAR: 'CLEAR',
  UNCLEAR: 'UNCLEAR',
  MISSING: 'MISSING',
  NOT_DETECTED: 'NOT_DETECTED'
});

/**
 * @typedef {object} StudentIdentity
 * @property {string} method       - test-model.js IdentificationMethod
 * @property {string|null} rollNumber
 * @property {string|null} name
 * @property {string} state        - IdentityState
 * @property {number|null} confidence
 */

export function createStudentIdentity({
  method,
  rollNumber = null,
  name = null,
  state = IdentityState.NOT_DETECTED,
  confidence = null
} = {}) {
  if (!Object.values(IdentityState).includes(state)) {
    throw new RangeError(`Invalid IdentityState: ${state}`);
  }
  return { method, rollNumber, name, state, confidence };
}

/**
 * @typedef {object} ScanQuality
 * @property {number|null} overallConfidence  - 0..1, aggregate across sheet
 * @property {boolean} skewed
 * @property {boolean} lowContrast
 * @property {string[]} warnings              - free-text, human readable
 */

export function createScanQuality({ overallConfidence = null, skewed = false, lowContrast = false, warnings = [] } = {}) {
  return { overallConfidence, skewed, lowContrast, warnings: [...warnings] };
}

/**
 * @typedef {object} ScannedSheet
 * @property {string} id
 * @property {string} testId
 * @property {string} templateId
 * @property {StudentIdentity} identity
 * @property {import('./question-model.js').DetectedAnswer[]} answers
 * @property {ScanQuality} quality
 * @property {string} timestamp        - ISO
 * @property {string} scanFingerprint  - hash used to detect re-scans of
 *   the same physical sheet (see storage.js:computeFingerprint)
 * @property {string} source           - 'MANUAL_ENTRY' | 'SCANNER' (Part 2+)
 */

export function createScannedSheet({
  testId,
  templateId,
  identity,
  answers,
  quality = createScanQuality(),
  scanFingerprint = null,
  source = 'MANUAL_ENTRY'
}) {
  if (!testId || !templateId) throw new RangeError('ScannedSheet requires testId and templateId');
  if (!Array.isArray(answers)) throw new RangeError('ScannedSheet requires an answers array');
  return {
    id: nextId('sheet'),
    testId,
    templateId,
    identity,
    answers: [...answers],
    quality,
    timestamp: new Date().toISOString(),
    scanFingerprint,
    source
  };
}

/**
 * Summarize a sheet's answers into counts per AnswerState, useful for
 * the teacher's review queue ("12 clear, 1 unclear, 2 blank") without
 * re-walking the full answer list in the UI layer.
 * @param {ScannedSheet} sheet
 * @returns {Object.<string, number>}
 */
export function summarizeAnswerStates(sheet) {
  const counts = {};
  for (const state of Object.values(AnswerState)) counts[state] = 0;
  for (const a of sheet.answers) counts[a.state] = (counts[a.state] || 0) + 1;
  return counts;
}

/** @param {ScannedSheet} sheet @returns {import('./question-model.js').DetectedAnswer[]} */
export function answersNeedingReview(sheet) {
  return sheet.answers.filter((a) => a.reviewRequired);
}

/** True if the identity itself needs a teacher's eyes before storing/grading. */
export function identityNeedsReview(sheet) {
  return sheet.identity.state !== IdentityState.CLEAR;
}
