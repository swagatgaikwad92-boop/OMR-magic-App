/**
 * omr-template.js
 * ------------------------------------------------------------------------
 * An OmrTemplate is the system's memory of what a particular sheet
 * LAYOUT looks like: where the student-identity fields are, where the
 * question/bubble blocks are, and where everything else (headers,
 * instructions, marks/negative-marking notices) sits — WITHOUT yet
 * saying anything about what any particular student wrote.
 *
 * Crucially, a template can describe more bubbles than a given test
 * uses (e.g. a generic 50-question sheet printed for a 15-question
 * quiz). The template only records geometry/region types; whether a
 * given question NUMBER is active for a given TEST is decided by
 * test-model.js's excludedQuestions / totalQuestions, and reconciled in
 * document-understanding.js. This module never decides "used vs
 * unused" on its own — that would be assuming test content that isn't
 * its job to know.
 *
 * Geometry is stored normalized (0..1 fractions of sheet width/height)
 * so the same template survives different scan resolutions. Part 2's
 * scanner is expected to populate real geometry; until then, geometry
 * may be null (region exists conceptually, position not yet known).
 * ------------------------------------------------------------------------
 */

/** @readonly @enum {string} */
export const RegionType = Object.freeze({
  HEADER: 'HEADER',
  SUBJECT_INFO: 'SUBJECT_INFO',
  INSTRUCTIONS: 'INSTRUCTIONS',
  MARKS_INFO: 'MARKS_INFO',
  NEGATIVE_MARKING_INFO: 'NEGATIVE_MARKING_INFO',
  STUDENT_NAME: 'STUDENT_NAME',
  ROLL_NUMBER_BUBBLES: 'ROLL_NUMBER_BUBBLES',
  STUDENT_ID_BLOCK: 'STUDENT_ID_BLOCK',
  QUESTION_BLOCK: 'QUESTION_BLOCK',
  UNUSED: 'UNUSED'
});

/** Region types that identify a student rather than record an answer.
 * document-understanding.js and any future recognizer must never treat
 * these as scoreable questions. */
export const IDENTITY_REGION_TYPES = Object.freeze([
  RegionType.STUDENT_NAME,
  RegionType.ROLL_NUMBER_BUBBLES,
  RegionType.STUDENT_ID_BLOCK
]);

export const ORIENTATIONS = Object.freeze(['PORTRAIT', 'LANDSCAPE']);

let _autoId = 0;
function nextId(prefix) {
  _autoId += 1;
  return `${prefix}_${Date.now().toString(36)}_${_autoId.toString(36)}`;
}

/**
 * @typedef {object} NormalizedBox
 * @property {number} x       - 0..1, left edge as a fraction of sheet width
 * @property {number} y       - 0..1, top edge as a fraction of sheet height
 * @property {number} width   - 0..1
 * @property {number} height  - 0..1
 */

/**
 * @typedef {object} TemplateRegion
 * @property {string} id
 * @property {string} type              - RegionType
 * @property {string} label             - human-readable name for the UI
 * @property {NormalizedBox|null} box   - null until a scanner localizes it
 * @property {number|null} startQuestion  - for QUESTION_BLOCK only
 * @property {number|null} endQuestion    - for QUESTION_BLOCK only
 * @property {string[]|null} optionsPerQuestion - for QUESTION_BLOCK only
 * @property {{rows:number, cols:number}|null} bubbleLayout - for QUESTION_BLOCK,
 *   optional hint for how bubbles are arranged inside the block
 * @property {object} meta
 */

/**
 * @param {object} params
 * @returns {TemplateRegion}
 */
export function createRegion({
  type,
  label,
  box = null,
  startQuestion = null,
  endQuestion = null,
  optionsPerQuestion = null,
  bubbleLayout = null,
  meta = {}
}) {
  if (!Object.values(RegionType).includes(type)) {
    throw new RangeError(`Invalid RegionType: ${type}`);
  }
  if (type === RegionType.QUESTION_BLOCK) {
    if (!Number.isInteger(startQuestion) || !Number.isInteger(endQuestion) || endQuestion < startQuestion) {
      throw new RangeError('QUESTION_BLOCK regions require a valid startQuestion/endQuestion range');
    }
  }
  if (box) validateBox(box);
  return {
    id: nextId('region'),
    type,
    label: label || type,
    box,
    startQuestion,
    endQuestion,
    optionsPerQuestion: optionsPerQuestion ? [...optionsPerQuestion] : null,
    bubbleLayout,
    meta
  };
}

function validateBox(box) {
  for (const key of ['x', 'y', 'width', 'height']) {
    const v = box[key];
    if (typeof v !== 'number' || v < 0 || v > 1) {
      throw new RangeError(`Region box.${key} must be a number in 0..1, got ${v}`);
    }
  }
}

/**
 * @typedef {object} OmrTemplate
 * @property {string} id
 * @property {string} name
 * @property {string} orientation      - 'PORTRAIT' | 'LANDSCAPE'
 * @property {{width:number,height:number}|null} sheetBoundary - aspect
 *   reference only (e.g. A4 portrait = {width:210,height:297}); real
 *   pixel boundary detection is a Part 2 (scanner) concern
 * @property {TemplateRegion[]} regions
 * @property {string} createdAt
 * @property {string} updatedAt
 */

export function createTemplate({
  name,
  orientation = 'PORTRAIT',
  sheetBoundary = null,
  regions = []
} = {}) {
  if (!name || typeof name !== 'string') throw new RangeError('Template requires a name');
  if (!ORIENTATIONS.includes(orientation)) throw new RangeError(`Invalid orientation: ${orientation}`);
  const now = new Date().toISOString();
  return { id: nextId('tmpl'), name, orientation, sheetBoundary, regions: [...regions], createdAt: now, updatedAt: now };
}

/** Returns a NEW template with the region appended. */
export function addRegion(template, regionParams) {
  const region = createRegion(regionParams);
  return { ...template, regions: [...template.regions, region], updatedAt: new Date().toISOString() };
}

export function removeRegion(template, regionId) {
  return {
    ...template,
    regions: template.regions.filter((r) => r.id !== regionId),
    updatedAt: new Date().toISOString()
  };
}

/** @param {OmrTemplate} template @returns {TemplateRegion[]} */
export function getQuestionRegions(template) {
  return template.regions.filter((r) => r.type === RegionType.QUESTION_BLOCK);
}

/** @param {OmrTemplate} template @returns {TemplateRegion[]} */
export function getIdentityRegions(template) {
  return template.regions.filter((r) => IDENTITY_REGION_TYPES.includes(r.type));
}

/**
 * The full set of question numbers this template physically has bubbles
 * for — NOT the same as a test's active/scored question count. A 50-
 * question sheet used for a 15-question test will report 1-50 here;
 * test-model.js + document-understanding.js decide which of those are
 * actually scored.
 * @param {OmrTemplate} template
 * @returns {number[]}
 */
export function getPhysicalQuestionNumbers(template) {
  const numbers = new Set();
  for (const region of getQuestionRegions(template)) {
    for (let n = region.startQuestion; n <= region.endQuestion; n += 1) numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b);
}

/**
 * Validate internal consistency of a template: no two QUESTION_BLOCK
 * regions claim the same question number, every QUESTION_BLOCK has an
 * option list, at least one identity region exists. Never throws —
 * returns a list of human-readable problems for the UI.
 * @param {OmrTemplate} template
 * @returns {string[]}
 */
export function validateTemplate(template) {
  const problems = [];
  const seen = new Map(); // questionNumber -> regionId
  for (const region of getQuestionRegions(template)) {
    if (!region.optionsPerQuestion || region.optionsPerQuestion.length < 2) {
      problems.push(`Question block "${region.label}" needs at least 2 options defined.`);
    }
    for (let n = region.startQuestion; n <= region.endQuestion; n += 1) {
      if (seen.has(n)) {
        problems.push(`Question ${n} is claimed by both "${seen.get(n)}" and "${region.label}".`);
      } else {
        seen.set(n, region.label);
      }
    }
  }
  if (getIdentityRegions(template).length === 0) {
    problems.push('Template has no student-identity region (name, roll number, or ID block).');
  }
  return problems;
}
