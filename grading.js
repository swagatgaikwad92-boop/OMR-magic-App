/**
 * grading.js
 * ------------------------------------------------------------------------
 * Turns (TestDefinition + AnswerKey + ScannedSheet) into a full result.
 * Pure and deterministic: same inputs always produce the same output,
 * no AI, no randomness. Anything the system isn't sure about (UNCLEAR,
 * MULTIPLE-on-single, unconfirmed key entries) is surfaced as a
 * needsReview item rather than folded into the score.
 * ------------------------------------------------------------------------
 */

import { buildQuestionDefinitions } from '../models/test-model.js';
import { scoreAnswer } from '../models/answer-key.js';
import { reconcileAnswers } from '../models/question-model.js';

/**
 * @typedef {object} SheetGradeResult
 * @property {string} sheetId
 * @property {number} totalPoints
 * @property {number} maxPossiblePoints
 * @property {number} correctCount
 * @property {number} incorrectCount
 * @property {number} blankCount
 * @property {number} unusedCount
 * @property {import('../models/answer-key.js').QuestionScore[]} perQuestion
 * @property {import('../models/answer-key.js').QuestionScore[]} needsReview
 *   - subset of perQuestion whose reason is NEEDS_REVIEW / KEY_ENTRY_UNCONFIRMED
 */

/**
 * @param {import('../models/test-model.js').TestDefinition} test
 * @param {import('../models/answer-key.js').AnswerKey} key
 * @param {import('../models/sheet-model.js').ScannedSheet} sheet
 * @returns {SheetGradeResult}
 */
export function gradeSheet(test, key, sheet) {
  const questionDefs = buildQuestionDefinitions(test);
  const reconciled = reconcileAnswers(questionDefs, sheet.answers);
  const defsByNumber = new Map(questionDefs.map((q) => [q.number, q]));

  const perQuestion = reconciled.map((detected) =>
    scoreAnswer(detected, key, defsByNumber.get(detected.questionNumber))
  );

  let totalPoints = 0;
  let maxPossiblePoints = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let blankCount = 0;
  let unusedCount = 0;

  for (const qDef of questionDefs) {
    if (qDef.active) maxPossiblePoints += qDef.marks;
  }
  for (const result of perQuestion) {
    totalPoints += result.pointsAwarded;
    if (result.reason === 'UNUSED_QUESTION') unusedCount += 1;
    else if (result.reason === 'BLANK') blankCount += 1;
    else if (result.isCorrect === true) correctCount += 1;
    else if (result.isCorrect === false) incorrectCount += 1;
  }

  const needsReview = perQuestion.filter((r) =>
    r.reason === 'NEEDS_REVIEW' || r.reason === 'KEY_ENTRY_UNCONFIRMED' || r.reason === 'NO_KEY_ENTRY'
  );

  return {
    sheetId: sheet.id,
    totalPoints,
    maxPossiblePoints,
    correctCount,
    incorrectCount,
    blankCount,
    unusedCount,
    perQuestion,
    needsReview
  };
}

/**
 * Grade every sheet belonging to a test in one pass. Useful for the
 * "check 100+ papers in one night" workflow: this function itself does
 * no I/O — the caller fetches sheets from storage.js and passes them in.
 *
 * @param {import('../models/test-model.js').TestDefinition} test
 * @param {import('../models/answer-key.js').AnswerKey} key
 * @param {import('../models/sheet-model.js').ScannedSheet[]} sheets
 * @returns {SheetGradeResult[]}
 */
export function gradeAllSheets(test, key, sheets) {
  return sheets.map((sheet) => gradeSheet(test, key, sheet));
}
