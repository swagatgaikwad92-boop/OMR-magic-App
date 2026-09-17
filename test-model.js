/**
 * test-model.js
 * ------------------------------------------------------------------------
 * A TestDefinition is the teacher's one-time description of an exam:
 * what it's called, how many real questions it has, how marks work,
 * and how students are identified on the sheet. It is created once and
 * then reused for every sheet belonging to that test, which is what
 * lets 100+ sheets be checked in one sitting without re-configuring
 * anything per sheet.
 *
 * A TestDefinition intentionally does NOT contain the answers — that
 * lives in answer-key.js — and does NOT contain sheet geometry — that
 * lives in omr-template.js. This file only holds "what the test is".
 * ------------------------------------------------------------------------
 */

import { createQuestionDefinition } from './question-model.js';

/**
 * How a student is identified on a given sheet. NAME_WRITTEN and
 * BARCODE/QR are declared here so Part 2/3 can wire in handwriting-OCR
 * or barcode scanning later without a model change; only
 * ROLL_NUMBER_BUBBLES is something this codebase can already validate
 * structurally (it is just more bubbles).
 * @readonly @enum {string}
 */
export const IdentificationMethod = Object.freeze({
  ROLL_NUMBER_BUBBLES: 'ROLL_NUMBER_BUBBLES',
  ROLL_NUMBER_WRITTEN: 'ROLL_NUMBER_WRITTEN',
  NAME_WRITTEN: 'NAME_WRITTEN',
  BARCODE: 'BARCODE',
  QR_CODE: 'QR_CODE',
  MANUAL: 'MANUAL'
});

let _autoId = 0;
function nextId(prefix) {
  _autoId += 1;
  return `${prefix}_${Date.now().toString(36)}_${_autoId.toString(36)}`;
}

/**
 * @typedef {object} TestSection
 * @property {string} id
 * @property {string} name
 * @property {number} startQuestion  - inclusive
 * @property {number} endQuestion    - inclusive
 * @property {number|null} marksPerQuestion   - overrides test default when set
 * @property {number|null} negativeMarks       - overrides test default when set
 */

/**
 * @param {object} params
 * @param {string} params.name
 * @param {number} params.startQuestion
 * @param {number} params.endQuestion
 * @param {number|null} [params.marksPerQuestion]
 * @param {number|null} [params.negativeMarks]
 * @returns {TestSection}
 */
export function createSection({
  name,
  startQuestion,
  endQuestion,
  marksPerQuestion = null,
  negativeMarks = null
}) {
  if (!name || typeof name !== 'string') throw new RangeError('Section requires a name');
  if (!Number.isInteger(startQuestion) || !Number.isInteger(endQuestion) || endQuestion < startQuestion) {
    throw new RangeError(`Invalid section question range: ${startQuestion}-${endQuestion}`);
  }
  return { id: nextId('sec'), name, startQuestion, endQuestion, marksPerQuestion, negativeMarks };
}

/**
 * @typedef {object} TestDefinition
 * @property {string} id
 * @property {string} name
 * @property {string} subject
 * @property {number} totalQuestions          - the ACTUAL number of scored
 *   questions (never assumed from bubble count — see omr-template.js)
 * @property {number} defaultMarksPerQuestion
 * @property {number} defaultNegativeMarks
 * @property {TestSection[]} sections
 * @property {number[]} excludedQuestions      - question numbers physically
 *   present but deliberately not scored (e.g. a voided question)
 * @property {string} identificationMethod
 * @property {string|null} answerKeyId
 * @property {string|null} templateId
 * @property {string[]} questionOptions        - options used by default,
 *   e.g. ['A','B','C','D']
 * @property {string} createdAt  - ISO timestamp
 * @property {string} updatedAt  - ISO timestamp
 * @property {object} meta
 */

/**
 * @param {object} params
 * @returns {TestDefinition}
 */
export function createTestDefinition({
  name,
  subject = '',
  totalQuestions,
  defaultMarksPerQuestion = 1,
  defaultNegativeMarks = 0,
  sections = [],
  excludedQuestions = [],
  identificationMethod = IdentificationMethod.ROLL_NUMBER_BUBBLES,
  answerKeyId = null,
  templateId = null,
  questionOptions = ['A', 'B', 'C', 'D'],
  meta = {}
} = {}) {
  if (!name || typeof name !== 'string') throw new RangeError('Test requires a name');
  if (!Number.isInteger(totalQuestions) || totalQuestions < 1) {
    throw new RangeError(`totalQuestions must be a positive integer, got ${totalQuestions}`);
  }
  if (!Object.values(IdentificationMethod).includes(identificationMethod)) {
    throw new RangeError(`Invalid identificationMethod: ${identificationMethod}`);
  }

  const now = new Date().toISOString();
  return {
    id: nextId('test'),
    name,
    subject,
    totalQuestions,
    defaultMarksPerQuestion,
    defaultNegativeMarks,
    sections: [...sections],
    excludedQuestions: [...new Set(excludedQuestions)].sort((a, b) => a - b),
    identificationMethod,
    answerKeyId,
    templateId,
    questionOptions: [...questionOptions],
    createdAt: now,
    updatedAt: now,
    meta
  };
}

/**
 * Build the full set of QuestionDefinitions (1..totalQuestions, marked
 * active/inactive per excludedQuestions and per-section marking rules)
 * for a test. This is the bridge from "what the test IS" to the
 * per-question objects grading and review actually operate on.
 *
 * @param {TestDefinition} test
 * @returns {import('./question-model.js').QuestionDefinition[]}
 */
export function buildQuestionDefinitions(test) {
  const excluded = new Set(test.excludedQuestions);
  const defs = [];
  for (let n = 1; n <= test.totalQuestions; n += 1) {
    const section = test.sections.find((s) => n >= s.startQuestion && n <= s.endQuestion) || null;
    defs.push(
      createQuestionDefinition({
        number: n,
        options: test.questionOptions,
        marks: (section && section.marksPerQuestion != null) ? section.marksPerQuestion : test.defaultMarksPerQuestion,
        negativeMarks: (section && section.negativeMarks != null) ? section.negativeMarks : test.defaultNegativeMarks,
        active: !excluded.has(n),
        sectionId: section ? section.id : null
      })
    );
  }
  return defs;
}

/**
 * Validate internal consistency of a TestDefinition: section ranges
 * inside 1..totalQuestions, no overlapping sections, excludedQuestions
 * inside range. Returns a list of human-readable problems (empty = ok).
 * Never throws — this is meant to drive UI feedback, not crash a build.
 *
 * @param {TestDefinition} test
 * @returns {string[]}
 */
export function validateTestDefinition(test) {
  const problems = [];
  if (!test.totalQuestions || test.totalQuestions < 1) {
    problems.push('Total question count must be at least 1.');
  }

  const sorted = [...test.sections].sort((a, b) => a.startQuestion - b.startQuestion);
  for (const s of sorted) {
    if (s.startQuestion < 1 || s.endQuestion > test.totalQuestions) {
      problems.push(`Section "${s.name}" (${s.startQuestion}-${s.endQuestion}) falls outside 1-${test.totalQuestions}.`);
    }
  }
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].startQuestion <= sorted[i - 1].endQuestion) {
      problems.push(`Sections "${sorted[i - 1].name}" and "${sorted[i].name}" overlap.`);
    }
  }
  for (const q of test.excludedQuestions) {
    if (q < 1 || q > test.totalQuestions) {
      problems.push(`Excluded question ${q} is outside 1-${test.totalQuestions}.`);
    }
  }
  return problems;
}

export function touchUpdatedAt(test) {
  return { ...test, updatedAt: new Date().toISOString() };
}
