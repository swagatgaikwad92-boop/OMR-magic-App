/**
 * question-model.js
 * ------------------------------------------------------------------------
 * Two related, but distinct, data structures live here:
 *
 * 1. QuestionDefinition  — describes a question SLOT as it exists in the
 *    test ("question 7 has options A-D, is worth 2 marks, is active").
 *    This is authored once per test and reused across every sheet.
 *
 * 2. DetectedAnswer      — describes what was actually observed for one
 *    student, for one question, on one sheet. It carries an
 *    AnswerState + confidence (see confidence.js) and never a bare
 *    boolean "correct" — correctness is computed later against an
 *    answer key (see answer-key.js / grading.js).
 *
 * Keeping these separate is what lets the same QuestionDefinition be
 * reused across 100+ sheets while every sheet gets its own independent
 * DetectedAnswer per question.
 * ------------------------------------------------------------------------
 */

import { AnswerState, isValidAnswerState, makeObservation } from '../core/confidence.js';

/** Default option set used when a test doesn't specify its own. */
export const DEFAULT_OPTIONS = Object.freeze(['A', 'B', 'C', 'D']);

let _autoId = 0;
function nextId(prefix) {
  _autoId += 1;
  return `${prefix}_${Date.now().toString(36)}_${_autoId.toString(36)}`;
}

/**
 * @typedef {object} QuestionDefinition
 * @property {string} id
 * @property {number} number            - the printed question number (1-based)
 * @property {string[]} options         - e.g. ['A','B','C','D']
 * @property {boolean} allowsMultiple   - true if more than one option can
 *   legitimately be correct (rare, but some tests allow it)
 * @property {number} marks             - marks awarded for a correct answer
 * @property {number} negativeMarks     - marks deducted for a wrong answer
 *   (positive number meaning "subtract this much"), 0 if none
 * @property {boolean} active           - false if this bubble slot exists
 *   on the physical sheet but is NOT part of this test (see UNUSED)
 * @property {string|null} sectionId
 */

/**
 * Create a QuestionDefinition. Nothing here inspects an image — this is
 * purely the teacher's (or an imported answer key's) declaration of what
 * question `number` means.
 *
 * @param {object} params
 * @param {number} params.number
 * @param {string[]} [params.options]
 * @param {boolean} [params.allowsMultiple]
 * @param {number} [params.marks]
 * @param {number} [params.negativeMarks]
 * @param {boolean} [params.active]
 * @param {string|null} [params.sectionId]
 * @returns {QuestionDefinition}
 */
export function createQuestionDefinition({
  number,
  options = DEFAULT_OPTIONS,
  allowsMultiple = false,
  marks = 1,
  negativeMarks = 0,
  active = true,
  sectionId = null
} = {}) {
  if (!Number.isInteger(number) || number < 1) {
    throw new RangeError(`Question number must be a positive integer, got ${number}`);
  }
  if (!Array.isArray(options) || options.length < 2) {
    throw new RangeError('Question must define at least 2 options');
  }
  if (marks < 0 || negativeMarks < 0) {
    throw new RangeError('marks and negativeMarks must be >= 0 (negativeMarks is a magnitude to subtract)');
  }
  return {
    id: nextId('q'),
    number,
    options: [...options],
    allowsMultiple,
    marks,
    negativeMarks,
    active,
    sectionId
  };
}

/**
 * @typedef {object} DetectedAnswer
 * @property {string} id
 * @property {number} questionNumber
 * @property {string[]} selectedOptions  - zero or more of the question's options
 * @property {string} state              - AnswerState
 * @property {number|null} confidence    - 0..1 or null
 * @property {boolean} reviewRequired
 * @property {object} meta                - analyzer-specific detail (bubble
 *   fill ratios, coordinates, etc.) — opaque to this module
 */

/**
 * Build a DetectedAnswer from a raw observation. This is the single
 * choke point every recognition path (manual entry now, real CV/AI
 * later) must go through, so the exception rules in confidence.js are
 * always enforced consistently.
 *
 * @param {object} params
 * @param {number} params.questionNumber
 * @param {string[]} [params.selectedOptions]
 * @param {string} params.state - one of AnswerState
 * @param {number|null} [params.confidence]
 * @param {object} [params.meta]
 * @returns {DetectedAnswer}
 */
export function createDetectedAnswer({
  questionNumber,
  selectedOptions = [],
  state,
  confidence = null,
  meta = {}
} = {}) {
  if (!Number.isInteger(questionNumber) || questionNumber < 1) {
    throw new RangeError(`questionNumber must be a positive integer, got ${questionNumber}`);
  }
  if (!isValidAnswerState(state)) {
    throw new RangeError(`Invalid AnswerState: ${state}`);
  }

  // Guard against silently-wrong combinations — better to throw during
  // development than to let a mis-tagged observation reach grading.
  if (state === AnswerState.CLEAR && selectedOptions.length !== 1) {
    throw new RangeError('AnswerState.CLEAR requires exactly one selected option');
  }
  if (state === AnswerState.MULTIPLE && selectedOptions.length < 2) {
    throw new RangeError('AnswerState.MULTIPLE requires two or more selected options');
  }
  if ((state === AnswerState.MISSING || state === AnswerState.UNUSED) && selectedOptions.length !== 0) {
    throw new RangeError(`AnswerState.${state} must not carry selected options`);
  }

  const observation = makeObservation({ state, confidence, meta });

  return {
    id: nextId('ans'),
    questionNumber,
    selectedOptions: [...selectedOptions],
    state: observation.state,
    confidence: observation.confidence,
    reviewRequired: observation.reviewRequired,
    meta: observation.meta
  };
}

/**
 * Convenience constructor for the common "no mark was made here at all,
 * because this question isn't part of the test" case.
 * @param {number} questionNumber
 * @returns {DetectedAnswer}
 */
export function createUnusedAnswer(questionNumber) {
  return createDetectedAnswer({ questionNumber, state: AnswerState.UNUSED });
}

/**
 * Reconciles a list of QuestionDefinitions against a list of
 * DetectedAnswers for one sheet, guaranteeing every active question has
 * exactly one DetectedAnswer entry (defaulting missing ones to
 * NOT_DETECTED rather than silently dropping them) and every inactive
 * question is forced to UNUSED regardless of what a scanner may have
 * observed on that bubble.
 *
 * @param {QuestionDefinition[]} questionDefs
 * @param {DetectedAnswer[]} detectedAnswers
 * @returns {DetectedAnswer[]} one entry per questionDef, in questionDef order
 */
export function reconcileAnswers(questionDefs, detectedAnswers) {
  const byNumber = new Map(detectedAnswers.map((a) => [a.questionNumber, a]));
  return questionDefs.map((qDef) => {
    if (!qDef.active) {
      // Active status always wins: never grade a bubble the test says
      // isn't a real question, even if something was physically marked.
      return createUnusedAnswer(qDef.number);
    }
    const existing = byNumber.get(qDef.number);
    if (existing) return existing;
    return createDetectedAnswer({
      questionNumber: qDef.number,
      state: AnswerState.NOT_DETECTED
    });
  });
}
