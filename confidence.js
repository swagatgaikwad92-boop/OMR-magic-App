/**
 * confidence.js
 * ------------------------------------------------------------------------
 * Shared "exception model" for OMR Magic.
 *
 * Every observation the system makes about a sheet (a bubble, a region,
 * a detected identity field) is uncertain until proven otherwise. This
 * module defines the single vocabulary of states used everywhere else in
 * the codebase, plus small, honest helpers for turning a numeric
 * confidence score into one of those states.
 *
 * Nothing in this file guesses at content. It only classifies numbers
 * and flags that some other module (deterministic CV in Part 2, or a
 * human in the UI) has already produced.
 * ------------------------------------------------------------------------
 */

/**
 * The full set of states an observed answer (or field) can be in.
 * These are intentionally NOT booleans (correct/incorrect) — that
 * judgement happens later, in grading, against an answer key.
 *
 * @readonly
 * @enum {string}
 */
export const AnswerState = Object.freeze({
  /** Exactly one option was marked, and the mark is unambiguous. */
  CLEAR: 'CLEAR',
  /** Something was marked, but it could not be read with confidence
   *  (light shading, stray marks, smudging, low scan quality). */
  UNCLEAR: 'UNCLEAR',
  /** No mark was found where one was expected. */
  MISSING: 'MISSING',
  /** More than one option was marked for a single-answer question. */
  MULTIPLE: 'MULTIPLE',
  /** This question number exists as bubbles on the sheet, but the test
   *  definition does not use it — it must never be scored. */
  UNUSED: 'UNUSED',
  /** The region/question was expected but no observation was made at
   *  all yet (e.g. recognition has not run, or the region was
   *  unreadable at the image level, distinct from a genuine blank). */
  NOT_DETECTED: 'NOT_DETECTED'
});

/** States that represent a genuine attempt to read the bubble, i.e.
 * everything except UNUSED (which was never meant to be read) and
 * NOT_DETECTED (which means "we haven't looked/couldn't look yet"). */
export const OBSERVED_STATES = Object.freeze([
  AnswerState.CLEAR,
  AnswerState.UNCLEAR,
  AnswerState.MISSING,
  AnswerState.MULTIPLE
]);

export function isValidAnswerState(state) {
  return Object.values(AnswerState).includes(state);
}

/**
 * Coarse, human-facing confidence bands. These exist so the UI can show
 * a teacher "Low confidence" instead of "0.42" — they never change what
 * gets graded, only how it is surfaced for review.
 * @readonly
 * @enum {string}
 */
export const ConfidenceLevel = Object.freeze({
  HIGH: 'HIGH',     // >= HIGH_THRESHOLD
  MEDIUM: 'MEDIUM',  // >= MEDIUM_THRESHOLD
  LOW: 'LOW',       // >= 0
  NONE: 'NONE'      // no score available at all (null/undefined)
});

export const CONFIDENCE_THRESHOLDS = Object.freeze({
  HIGH: 0.85,
  MEDIUM: 0.6
});

/**
 * Clamp and validate a raw confidence score.
 * @param {number} score - expected range 0..1
 * @returns {number}
 */
export function normalizeConfidence(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) {
    throw new TypeError(`confidence score must be a number, got ${score}`);
  }
  return Math.max(0, Math.min(1, score));
}

/**
 * Turn a numeric confidence score into a ConfidenceLevel band.
 * @param {number|null|undefined} score
 * @returns {ConfidenceLevel}
 */
export function confidenceLevel(score) {
  if (score === null || score === undefined) return ConfidenceLevel.NONE;
  const s = normalizeConfidence(score);
  if (s >= CONFIDENCE_THRESHOLDS.HIGH) return ConfidenceLevel.HIGH;
  if (s >= CONFIDENCE_THRESHOLDS.MEDIUM) return ConfidenceLevel.MEDIUM;
  return ConfidenceLevel.LOW;
}

/**
 * Decide whether an observation needs a human's eyes before it can be
 * trusted for grading. This is the one gate that keeps the system from
 * ever "inventing" an answer: anything not CLEAR-and-confident is
 * routed to review.
 *
 * @param {{state: string, confidence?: number|null}} observation
 * @returns {boolean}
 */
export function needsReview(observation) {
  if (!observation || !isValidAnswerState(observation.state)) return true;
  if (observation.state !== AnswerState.CLEAR) {
    // UNUSED is fine as-is (nothing to review); everything else that
    // isn't CLEAR is, by definition, something a teacher should see.
    return observation.state !== AnswerState.UNUSED;
  }
  const level = confidenceLevel(observation.confidence);
  return level === ConfidenceLevel.LOW || level === ConfidenceLevel.NONE;
}

/**
 * Build a standard "observation" envelope. Every module that produces
 * an uncertain reading (a bubble, a region classification, an identity
 * field) should shape its output through this so downstream code has
 * one consistent contract.
 *
 * @param {object} params
 * @param {string} params.state - one of AnswerState
 * @param {number|null} [params.confidence] - 0..1, or null if unscored
 * @param {object} [params.meta] - free-form extra detail (e.g. raw pixel
 *   coordinates, which options were marked, notes from the analyzer)
 * @returns {{state:string, confidence:(number|null), meta:object, reviewRequired:boolean}}
 */
export function makeObservation({ state, confidence = null, meta = {} }) {
  if (!isValidAnswerState(state)) {
    throw new RangeError(`Invalid AnswerState: ${state}`);
  }
  const normalizedConfidence =
    confidence === null || confidence === undefined ? null : normalizeConfidence(confidence);
  const observation = { state, confidence: normalizedConfidence, meta };
  observation.reviewRequired = needsReview(observation);
  return observation;
}
