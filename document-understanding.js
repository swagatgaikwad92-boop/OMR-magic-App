/**
 * document-understanding.js
 * ------------------------------------------------------------------------
 * This module is the seam between "what the teacher has already told
 * the system" (a TestDefinition + OmrTemplate) and "what a real
 * scanner/vision/OCR pipeline will eventually observe from an image".
 *
 * Part 1 has no camera input and does no image processing — building a
 * fake one would violate the brief. Instead this file defines:
 *
 *   1. The DocumentUnderstandingResult shape every analyzer (present or
 *      future) must return, so Part 2/3 can be dropped in without
 *      touching grading, storage, or the UI.
 *   2. An abstract DocumentAnalyzer contract with clearly-unimplemented
 *      methods, so it's obvious at the call site that no real
 *      recognition has happened yet.
 *   3. A small registry so a real analyzer can be plugged in later with
 *      one line, from outside this file.
 *   4. A DeterministicReconciler: the one piece of "understanding" this
 *      codebase CAN honestly do today without a camera — reconciling a
 *      template's physical bubble layout against a test's declared
 *      active questions, so unused bubbles (e.g. Q16-Q50 on a 15-
 *      question test) are already known and excluded before any
 *      scanning exists. This is plain deterministic set logic, not AI.
 * ------------------------------------------------------------------------
 */

import { getPhysicalQuestionNumbers, getIdentityRegions, getQuestionRegions, RegionType } from '../models/omr-template.js';

/**
 * @typedef {object} DocumentUnderstandingResult
 * @property {'OMR'} documentType
 * @property {number} questionsDetected        - count of ACTIVE (scored) questions
 * @property {number} questionsPhysical        - count of bubble slots that exist at all
 * @property {number[]} unusedQuestions        - physical question numbers not scored
 * @property {{type:string,label:string}[]} identityRegions
 * @property {{type:string,label:string}[]} otherRegions
 * @property {number} confidence               - 0..1, honest about how much of
 *   this is verified structure vs. still-unknown geometry
 * @property {string[]} warnings
 */

/**
 * Abstract contract for a real analyzer (deterministic CV, OCR, or an
 * AI model) that Part 2/3 will implement. Calling these directly from
 * Part 1 is a programming error, not a runtime fallback — there is no
 * silent fake result, only a loud, clear exception explaining what's
 * missing.
 */
export class DocumentAnalyzer {
  /**
   * @param {unknown} image - opaque image/scan input, shape TBD by Part 2
   * @param {import('../models/omr-template.js').OmrTemplate} template
   * @returns {Promise<DocumentUnderstandingResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async analyzeStructure(image, template) {
    throw new Error(
      'DocumentAnalyzer.analyzeStructure is not implemented. ' +
      'This is the integration point for Part 2 (scanner / computer vision) or ' +
      'Part 3 (AI-assisted structure understanding) — register a concrete ' +
      'analyzer with registerAnalyzer() instead of calling the base class.'
    );
  }

  /**
   * @param {unknown} image
   * @param {import('../models/omr-template.js').OmrTemplate} template
   * @param {import('../models/test-model.js').TestDefinition} test
   * @returns {Promise<import('../models/question-model.js').DetectedAnswer[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async recognizeAnswers(image, template, test) {
    throw new Error(
      'DocumentAnalyzer.recognizeAnswers is not implemented. ' +
      'Bubble/mark recognition belongs to Part 2 (deterministic CV) with Part 3 ' +
      'AI assistance only for genuinely ambiguous cases — see the exception ' +
      'model in confidence.js. Register a concrete analyzer with registerAnalyzer().'
    );
  }

  /**
   * @param {unknown} image
   * @param {import('../models/omr-template.js').OmrTemplate} template
   * @returns {Promise<import('../models/sheet-model.js').StudentIdentity>}
   */
  // eslint-disable-next-line no-unused-vars
  async recognizeIdentity(image, template) {
    throw new Error(
      'DocumentAnalyzer.recognizeIdentity is not implemented. ' +
      'Roll-number/name/barcode reading belongs to Part 2/3 — register a ' +
      'concrete analyzer with registerAnalyzer().'
    );
  }
}

let _activeAnalyzer = null;

/**
 * Plug in a real analyzer. Part 2/3 call this once at app start; Part 1
 * ships with none registered, which is the honest state of "no scanner
 * yet" rather than a fake one.
 * @param {DocumentAnalyzer} analyzer
 */
export function registerAnalyzer(analyzer) {
  if (!(analyzer instanceof DocumentAnalyzer)) {
    throw new TypeError('registerAnalyzer expects an instance of DocumentAnalyzer');
  }
  _activeAnalyzer = analyzer;
}

export function getActiveAnalyzer() {
  return _activeAnalyzer;
}

export function hasActiveAnalyzer() {
  return _activeAnalyzer !== null;
}

/**
 * The deterministic piece: given ONLY a template and a test (no image),
 * work out which physical bubble slots are actually scored questions
 * and which are unused — plus a structural inventory of every other
 * region on the sheet. This is real, useful "understanding" that does
 * not require a camera, and it's exactly the data Part 2's scanner will
 * need to know what to even look for.
 *
 * @param {import('../models/omr-template.js').OmrTemplate} template
 * @param {import('../models/test-model.js').TestDefinition} test
 * @returns {DocumentUnderstandingResult}
 */
export function reconcileTemplateWithTest(template, test) {
  const warnings = [];
  const physicalNumbers = getPhysicalQuestionNumbers(template);
  const physicalSet = new Set(physicalNumbers);
  const excluded = new Set(test.excludedQuestions);

  const activeNumbers = [];
  for (let n = 1; n <= test.totalQuestions; n += 1) {
    if (!excluded.has(n)) activeNumbers.push(n);
  }

  // Anything physically on the sheet beyond the test's declared active
  // set is unused — this is exactly the "Q16-Q50 on a 15-question test"
  // case from the brief, computed from data, never assumed from bubble
  // count alone.
  const unusedQuestions = physicalNumbers.filter((n) => n > test.totalQuestions || excluded.has(n));

  const activeNotOnSheet = activeNumbers.filter((n) => !physicalSet.has(n));
  if (activeNotOnSheet.length > 0) {
    warnings.push(
      `Test declares ${activeNotOnSheet.length} active question(s) with no matching bubble region on this template: ${activeNotOnSheet.join(', ')}.`
    );
  }

  const identityRegions = getIdentityRegions(template).map((r) => ({ type: r.type, label: r.label }));
  if (identityRegions.length === 0) {
    warnings.push('Template has no identity region — students cannot be automatically matched to a sheet.');
  }

  const otherRegions = template.regions
    .filter((r) => r.type !== RegionType.QUESTION_BLOCK && !getIdentityRegions(template).includes(r))
    .map((r) => ({ type: r.type, label: r.label }));

  // Confidence here reflects structural completeness of the DECLARED
  // data (template + test line up), not any image-derived certainty —
  // it will typically be 1.0 in Part 1 since nothing here is a guess,
  // it's arithmetic over what the teacher entered. It drops only when
  // the declared structures don't agree with each other.
  const confidence = activeNotOnSheet.length === 0 && identityRegions.length > 0 ? 1 : 0.5;

  return {
    documentType: 'OMR',
    questionsDetected: activeNumbers.length,
    questionsPhysical: physicalNumbers.length,
    unusedQuestions,
    identityRegions,
    otherRegions,
    confidence,
    warnings
  };
}
