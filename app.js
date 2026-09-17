/**
 * app.js
 * ------------------------------------------------------------------------
 * UI orchestrator for OMR Magic — Part 1.
 *
 * This file deliberately contains NO recognition logic. Every answer a
 * "sheet" gets in this UI is entered by a human clicking bubbles, which
 * stands in for the scanner feed Part 2 will provide through the exact
 * same DetectedAnswer/ScannedSheet data shapes (see
 * js/core/document-understanding.js for the integration seam). That is
 * what lets this be real, working software today without faking a
 * camera or an AI model.
 * ------------------------------------------------------------------------
 */

import * as storage from './core/storage.js';
import { AnswerState, confidenceLevel } from './core/confidence.js';
import { reconcileTemplateWithTest } from './core/document-understanding.js';
import { gradeSheet } from './core/grading.js';

import {
  createTestDefinition, validateTestDefinition, createSection,
  IdentificationMethod, buildQuestionDefinitions
} from './models/test-model.js';
import {
  createTemplate, addRegion, removeRegion, validateTemplate, RegionType
} from './models/omr-template.js';
import {
  createAnswerKey, setAnswer, excludeQuestion, clearAnswer, validateAgainstTest
} from './models/answer-key.js';
import { createDetectedAnswer, reconcileAnswers } from './models/question-model.js';
import { createScannedSheet, createStudentIdentity, IdentityState, answersNeedingReview } from './models/sheet-model.js';

// ---------------------------------------------------------------------
// In-memory app state (a thin cache over IndexedDB; storage.js remains
// the source of truth across reloads).
// ---------------------------------------------------------------------
const state = {
  view: 'dashboard',
  tests: [],
  templates: [],
  draftTemplate: null,      // template currently being built in the editor
  draftTest: null,          // test currently being built in the editor
  draftSections: [],
  answerKeyTestId: null,
  draftKey: null,
  gradeSheetTestId: null,
  gradeRows: new Map(),     // questionNumber -> { selected: Set<string>, flag: string|null }
  gradeIdentity: { rollNumber: '', name: '' },
  sheetsGradedThisSession: 0,
  reviewTestId: null,
  reviewSheetId: null
};

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function byId(id) { return document.getElementById(id); }

// ---------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------
function switchView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.rail__nav button').forEach((el) => el.classList.remove('active'));
  byId(`view-${view}`).classList.add('active');
  document.querySelector(`.rail__nav button[data-view="${view}"]`).classList.add('active');
  render();
}

function wireNav() {
  document.querySelectorAll('.rail__nav button').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
}

// ---------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------
async function loadAll() {
  [state.tests, state.templates] = await Promise.all([storage.getAllTests(), storage.getAllTemplates()]);
}

function getTest(id) { return state.tests.find((t) => t.id === id); }
function getTemplate(id) { return state.templates.find((t) => t.id === id); }

// ---------------------------------------------------------------------
// Render dispatcher
// ---------------------------------------------------------------------
function render() {
  if (state.view === 'dashboard') renderDashboard();
  if (state.view === 'templates') renderTemplates();
  if (state.view === 'tests') renderTests();
  if (state.view === 'answer-key') renderAnswerKey();
  if (state.view === 'grade-sheet') renderGradeSheet();
  if (state.view === 'review') renderReview();
}

// =======================================================================
// DASHBOARD
// =======================================================================
async function renderDashboard() {
  const el = byId('view-dashboard');
  const sheetCounts = await Promise.all(state.tests.map((t) => storage.getSheetsForTest(t.id)));
  const totalSheets = sheetCounts.reduce((sum, arr) => sum + arr.length, 0);

  el.innerHTML = `
    <div class="view__header">
      <div>
        <h1>Good to see you</h1>
        <p>Understand the sheet once, remember it forever, and only ever review what's actually uncertain.</p>
      </div>
    </div>
    ${state.tests.length === 0 ? `
      <div class="empty-state">
        <h3>No tests set up yet</h3>
        <p>Start with a sheet template, then define a test and its answer key.</p>
        <button class="btn" id="dash-new-template">Create a sheet template</button>
      </div>
    ` : `
      <div class="sheet">
        <div class="score-hero"><span class="big">${state.tests.length}</span><span class="of">test${state.tests.length === 1 ? '' : 's'} set up</span></div>
        <p class="list-item__meta">${totalSheets} sheet${totalSheets === 1 ? '' : 's'} graded and stored so far.</p>
      </div>
      <h2>Your tests</h2>
      ${state.tests.map((t) => `
        <div class="list-item" data-open-test="${t.id}">
          <div>
            <strong>${esc(t.name)}</strong>
            <div class="list-item__meta">${esc(t.subject || 'No subject set')} · ${t.totalQuestions} questions</div>
          </div>
          <span class="state-chip state-chip--clear">Open</span>
        </div>
      `).join('')}
    `}
  `;

  byId('dash-new-template')?.addEventListener('click', () => switchView('templates'));
  el.querySelectorAll('[data-open-test]').forEach((row) => {
    row.addEventListener('click', () => {
      state.reviewTestId = row.dataset.openTest;
      switchView('review');
    });
  });
}

// =======================================================================
// TEMPLATES  (omr-template.js)
// =======================================================================
function ensureDraftTemplate() {
  if (!state.draftTemplate) {
    state.draftTemplate = createTemplate({ name: 'Untitled sheet template' });
  }
  return state.draftTemplate;
}

function renderTemplates() {
  const el = byId('view-templates');
  const draft = ensureDraftTemplate();
  const problems = validateTemplate(draft);

  el.innerHTML = `
    <div class="view__header">
      <div><h1>Sheet templates</h1><p>Describe what exists on the physical sheet — not what the test scores. Unused bubbles are sorted out later, per test.</p></div>
    </div>

    <div class="sheet">
      <div class="field-row">
        <div class="field">
          <label for="tpl-name">Template name</label>
          <input type="text" id="tpl-name" value="${esc(draft.name)}" placeholder="e.g. Standard 50-question answer sheet">
        </div>
        <div class="field">
          <label for="tpl-orientation">Orientation</label>
          <select id="tpl-orientation">
            <option value="PORTRAIT" ${draft.orientation === 'PORTRAIT' ? 'selected' : ''}>Portrait</option>
            <option value="LANDSCAPE" ${draft.orientation === 'LANDSCAPE' ? 'selected' : ''}>Landscape</option>
          </select>
        </div>
      </div>

      <hr class="sheet-divider">
      <h3>Regions on this sheet</h3>
      ${draft.regions.length === 0 ? '<p class="list-item__meta">No regions added yet.</p>' : draft.regions.map((r) => `
        <div class="list-item">
          <div>
            <strong>${esc(r.label)}</strong>
            <div class="list-item__meta">${r.type}${r.type === 'QUESTION_BLOCK' ? ` · Q${r.startQuestion}–${r.endQuestion} · options: ${r.optionsPerQuestion.join(', ')}` : ''}</div>
          </div>
          <button class="btn btn--danger btn--small" data-remove-region="${r.id}">Remove</button>
        </div>
      `).join('')}

      <hr class="sheet-divider">
      <h3>Add a region</h3>
      <div class="field-row">
        <div class="field">
          <label for="region-type">Region type</label>
          <select id="region-type">
            ${Object.values(RegionType).filter((t) => t !== 'UNUSED').map((t) => `<option value="${t}">${t.replace(/_/g, ' ')}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="region-label">Label</label>
          <input type="text" id="region-label" placeholder="e.g. Roll number grid">
        </div>
      </div>
      <div class="field-row" id="question-block-fields">
        <div class="field">
          <label for="region-start">First question #</label>
          <input type="number" id="region-start" min="1" value="1">
        </div>
        <div class="field">
          <label for="region-end">Last question #</label>
          <input type="number" id="region-end" min="1" value="50">
        </div>
        <div class="field">
          <label for="region-options">Options (comma-separated)</label>
          <input type="text" id="region-options" value="A,B,C,D">
        </div>
      </div>
      <button class="btn btn--secondary" id="add-region-btn">Add region</button>

      ${problems.length ? `<div class="warning-box"><strong>Before saving:</strong><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}

      <hr class="sheet-divider">
      <button class="btn" id="save-template-btn" ${problems.length ? 'disabled' : ''}>Save template</button>
      <button class="btn btn--secondary" id="new-template-btn">Start a new template</button>
    </div>

    <h2>Saved templates</h2>
    ${state.templates.length === 0 ? '<p class="list-item__meta">None saved yet.</p>' : state.templates.map((t) => `
      <div class="list-item" data-edit-template="${t.id}">
        <div><strong>${esc(t.name)}</strong><div class="list-item__meta">${t.regions.length} region(s)</div></div>
        <span class="state-chip state-chip--clear">Edit</span>
      </div>
    `).join('')}
  `;

  byId('tpl-name').addEventListener('input', (e) => { state.draftTemplate = { ...draft, name: e.target.value }; });
  byId('tpl-orientation').addEventListener('change', (e) => { state.draftTemplate = { ...draft, orientation: e.target.value }; });

  const typeSelect = byId('region-type');
  const toggleQuestionFields = () => {
    byId('question-block-fields').style.display = typeSelect.value === 'QUESTION_BLOCK' ? 'flex' : 'none';
  };
  typeSelect.addEventListener('change', toggleQuestionFields);
  toggleQuestionFields();

  byId('add-region-btn').addEventListener('click', () => {
    const type = typeSelect.value;
    const label = byId('region-label').value.trim() || type.replace(/_/g, ' ');
    const params = { type, label };
    if (type === 'QUESTION_BLOCK') {
      params.startQuestion = parseInt(byId('region-start').value, 10);
      params.endQuestion = parseInt(byId('region-end').value, 10);
      params.optionsPerQuestion = byId('region-options').value.split(',').map((s) => s.trim()).filter(Boolean);
    }
    try {
      state.draftTemplate = addRegion(state.draftTemplate, params);
      renderTemplates();
    } catch (err) {
      alert(err.message);
    }
  });

  el.querySelectorAll('[data-remove-region]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.draftTemplate = removeRegion(state.draftTemplate, btn.dataset.removeRegion);
      renderTemplates();
    });
  });

  byId('save-template-btn').addEventListener('click', async () => {
    await storage.saveTemplate(state.draftTemplate);
    await loadAll();
    state.draftTemplate = null;
    renderTemplates();
  });
  byId('new-template-btn').addEventListener('click', () => { state.draftTemplate = null; renderTemplates(); });

  el.querySelectorAll('[data-edit-template]').forEach((row) => {
    row.addEventListener('click', () => {
      state.draftTemplate = getTemplate(row.dataset.editTemplate);
      renderTemplates();
      window.scrollTo(0, 0);
    });
  });
}

// =======================================================================
// TESTS  (test-model.js)
// =======================================================================
function ensureDraftTest() {
  if (!state.draftTest) {
    state.draftTest = createTestDefinition({ name: 'Untitled test', totalQuestions: 10 });
    state.draftSections = [];
  }
  return state.draftTest;
}

function renderTests() {
  const el = byId('view-tests');
  const draft = ensureDraftTest();
  const testForValidation = { ...draft, sections: state.draftSections };
  const problems = validateTestDefinition(testForValidation);

  el.innerHTML = `
    <div class="view__header">
      <div><h1>Tests</h1><p>What the test actually is: real question count, marking scheme, and how students are identified.</p></div>
    </div>

    <div class="sheet">
      <div class="field-row">
        <div class="field"><label for="test-name">Test name</label><input type="text" id="test-name" value="${esc(draft.name)}"></div>
        <div class="field"><label for="test-subject">Subject</label><input type="text" id="test-subject" value="${esc(draft.subject)}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="test-total">Actual number of questions</label><input type="number" id="test-total" min="1" value="${draft.totalQuestions}"></div>
        <div class="field"><label for="test-marks">Marks per question (default)</label><input type="number" id="test-marks" min="0" step="0.5" value="${draft.defaultMarksPerQuestion}"></div>
        <div class="field"><label for="test-negative">Negative marking (default)</label><input type="number" id="test-negative" min="0" step="0.25" value="${draft.defaultNegativeMarks}"></div>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="test-id-method">Student identification</label>
          <select id="test-id-method">
            ${Object.values(IdentificationMethod).map((m) => `<option value="${m}" ${draft.identificationMethod === m ? 'selected' : ''}>${m.replace(/_/g, ' ')}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="test-template">Sheet template</label>
          <select id="test-template">
            <option value="">Not linked yet</option>
            ${state.templates.map((t) => `<option value="${t.id}" ${draft.templateId === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="test-options">Answer options (comma-separated)</label>
          <input type="text" id="test-options" value="${draft.questionOptions.join(',')}">
        </div>
      </div>

      <hr class="sheet-divider">
      <h3>Sections (optional)</h3>
      ${state.draftSections.length === 0 ? '<p class="list-item__meta">No sections — the whole test uses the default marking above.</p>' : state.draftSections.map((s) => `
        <div class="list-item">
          <div><strong>${esc(s.name)}</strong><div class="list-item__meta">Q${s.startQuestion}–${s.endQuestion}${s.marksPerQuestion != null ? ` · ${s.marksPerQuestion} mark(s)` : ''}${s.negativeMarks != null ? ` · −${s.negativeMarks} negative` : ''}</div></div>
          <button class="btn btn--danger btn--small" data-remove-section="${s.id}">Remove</button>
        </div>
      `).join('')}
      <div class="field-row">
        <div class="field"><label for="sec-name">Section name</label><input type="text" id="sec-name" placeholder="e.g. Part B — Chemistry"></div>
        <div class="field"><label for="sec-start">Start Q#</label><input type="number" id="sec-start" min="1"></div>
        <div class="field"><label for="sec-end">End Q#</label><input type="number" id="sec-end" min="1"></div>
        <div class="field"><label for="sec-marks">Marks override</label><input type="number" id="sec-marks" step="0.5" placeholder="default"></div>
        <div class="field"><label for="sec-negative">Negative override</label><input type="number" id="sec-negative" step="0.25" placeholder="default"></div>
      </div>
      <button class="btn btn--secondary" id="add-section-btn">Add section</button>

      <hr class="sheet-divider">
      <h3>Excluded questions</h3>
      <p class="list-item__meta">Question numbers physically on the sheet that should never be scored (voided, dropped, etc.) — separate from questions simply beyond your sheet's printed range.</p>
      <div class="pill-list">
        ${draft.excludedQuestions.map((q) => `<span class="pill">Q${q}<button data-remove-excluded="${q}">×</button></span>`).join('')}
      </div>
      <div class="field-row">
        <div class="field"><label for="exclude-input">Add excluded question #</label><input type="number" id="exclude-input" min="1"></div>
      </div>
      <button class="btn btn--secondary" id="add-exclude-btn">Add</button>

      ${problems.length ? `<div class="warning-box"><strong>Before saving:</strong><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}

      <hr class="sheet-divider">
      <button class="btn" id="save-test-btn" ${problems.length ? 'disabled' : ''}>Save test</button>
      <button class="btn btn--secondary" id="new-test-btn">Start a new test</button>
    </div>

    <h2>Saved tests</h2>
    ${state.tests.length === 0 ? '<p class="list-item__meta">None saved yet.</p>' : state.tests.map((t) => `
      <div class="list-item" data-edit-test="${t.id}">
        <div><strong>${esc(t.name)}</strong><div class="list-item__meta">${t.totalQuestions} questions · ${esc(t.subject || 'no subject')}</div></div>
        <span class="state-chip state-chip--clear">Edit</span>
      </div>
    `).join('')}
  `;

  const syncDraft = (patch) => { state.draftTest = { ...state.draftTest, ...patch }; };

  byId('test-name').addEventListener('input', (e) => syncDraft({ name: e.target.value }));
  byId('test-subject').addEventListener('input', (e) => syncDraft({ subject: e.target.value }));
  byId('test-total').addEventListener('input', (e) => syncDraft({ totalQuestions: parseInt(e.target.value, 10) || 0 }));
  byId('test-marks').addEventListener('input', (e) => syncDraft({ defaultMarksPerQuestion: parseFloat(e.target.value) || 0 }));
  byId('test-negative').addEventListener('input', (e) => syncDraft({ defaultNegativeMarks: parseFloat(e.target.value) || 0 }));
  byId('test-id-method').addEventListener('change', (e) => syncDraft({ identificationMethod: e.target.value }));
  byId('test-template').addEventListener('change', (e) => syncDraft({ templateId: e.target.value || null }));
  byId('test-options').addEventListener('input', (e) => syncDraft({ questionOptions: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }));

  byId('add-section-btn').addEventListener('click', () => {
    try {
      const section = createSection({
        name: byId('sec-name').value.trim() || 'Untitled section',
        startQuestion: parseInt(byId('sec-start').value, 10),
        endQuestion: parseInt(byId('sec-end').value, 10),
        marksPerQuestion: byId('sec-marks').value === '' ? null : parseFloat(byId('sec-marks').value),
        negativeMarks: byId('sec-negative').value === '' ? null : parseFloat(byId('sec-negative').value)
      });
      state.draftSections = [...state.draftSections, section];
      renderTests();
    } catch (err) { alert(err.message); }
  });

  el.querySelectorAll('[data-remove-section]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.draftSections = state.draftSections.filter((s) => s.id !== btn.dataset.removeSection);
      renderTests();
    });
  });

  byId('add-exclude-btn').addEventListener('click', () => {
    const n = parseInt(byId('exclude-input').value, 10);
    if (Number.isInteger(n) && n > 0) {
      syncDraft({ excludedQuestions: [...new Set([...state.draftTest.excludedQuestions, n])].sort((a, b) => a - b) });
      renderTests();
    }
  });
  el.querySelectorAll('[data-remove-excluded]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const n = parseInt(btn.dataset.removeExcluded, 10);
      syncDraft({ excludedQuestions: state.draftTest.excludedQuestions.filter((q) => q !== n) });
      renderTests();
    });
  });

  byId('save-test-btn').addEventListener('click', async () => {
    const toSave = { ...state.draftTest, sections: state.draftSections };
    await storage.saveTest(toSave);
    await loadAll();
    state.draftTest = null;
    state.draftSections = [];
    renderTests();
  });
  byId('new-test-btn').addEventListener('click', () => { state.draftTest = null; state.draftSections = []; renderTests(); });

  el.querySelectorAll('[data-edit-test]').forEach((row) => {
    row.addEventListener('click', () => {
      const t = getTest(row.dataset.editTest);
      state.draftTest = t;
      state.draftSections = [...t.sections];
      renderTests();
      window.scrollTo(0, 0);
    });
  });
}

// =======================================================================
// ANSWER KEY  (answer-key.js)
// =======================================================================
async function renderAnswerKey() {
  const el = byId('view-answer-key');

  if (state.tests.length === 0) {
    el.innerHTML = `<div class="view__header"><h1>Answer key</h1></div><div class="empty-state">Create a test first.</div>`;
    return;
  }
  if (!state.answerKeyTestId) state.answerKeyTestId = state.tests[0].id;
  const test = getTest(state.answerKeyTestId);

  if (!state.draftKey || state.draftKey.testId !== test.id) {
    const existing = await storage.getAnswerKeysForTest(test.id);
    state.draftKey = existing.length > 0 ? existing[existing.length - 1] : createAnswerKey({ testId: test.id });
  }

  const template = test.templateId ? getTemplate(test.templateId) : null;
  const understanding = template ? reconcileTemplateWithTest(template, test) : null;
  const questionDefs = buildQuestionDefinitions(test);
  const validation = validateAgainstTest(state.draftKey, test);

  el.innerHTML = `
    <div class="view__header">
      <div><h1>Answer key</h1><p>Tap the correct bubble for each question. Nothing is filled in for you — an unanswered row simply stays unanswered.</p></div>
      <select id="key-test-select">${state.tests.map((t) => `<option value="${t.id}" ${t.id === test.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
    </div>

    ${!template ? '<div class="warning-box">This test has no sheet template linked yet — link one from the Tests tab so unused bubble regions can be reconciled automatically.</div>' :
      understanding.unusedQuestions.length ? `<div class="warning-box">The linked template has ${understanding.unusedQuestions.length} bubble slot(s) beyond this test's ${test.totalQuestions} questions — they're excluded automatically and never appear below.</div>` : ''}
    ${validation.missing.length ? `<div class="warning-box"><strong>Missing key entries:</strong> Q${validation.missing.join(', Q')}</div>` : ''}

    <div class="sheet">
      ${questionDefs.filter((q) => q.active).map((q) => {
        const entry = state.draftKey.entries[q.number];
        const correct = new Set(entry?.correctOptions || []);
        const excluded = !!entry?.excluded;
        return `
        <div class="bubble-row">
          <span class="bubble-row__number">Q${q.number}</span>
          <div class="bubble-options">
            ${q.options.map((opt) => `<button class="bubble ${correct.has(opt) ? 'selected' : ''}" data-key-q="${q.number}" data-key-opt="${opt}" ${excluded ? 'disabled' : ''}>${opt}</button>`).join('')}
          </div>
          <button class="flag-btn ${excluded ? 'active-missing' : ''}" data-key-exclude="${q.number}">${excluded ? 'Excluded' : 'Exclude'}</button>
        </div>
      `;
      }).join('')}
    </div>

    <button class="btn" id="save-key-btn">Save answer key</button>
  `;

  byId('key-test-select').addEventListener('change', (e) => {
    state.answerKeyTestId = e.target.value;
    state.draftKey = null;
    renderAnswerKey();
  });

  el.querySelectorAll('[data-key-q]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const qNum = parseInt(btn.dataset.keyQ, 10);
      const opt = btn.dataset.keyOpt;
      const entry = state.draftKey.entries[qNum];
      const current = new Set(entry?.correctOptions || []);
      if (current.has(opt)) current.delete(opt); else current.add(opt);
      state.draftKey = current.size === 0
        ? clearAnswer(state.draftKey, qNum)
        : setAnswer(state.draftKey, { questionNumber: qNum, correctOptions: [...current] });
      renderAnswerKey();
    });
  });

  el.querySelectorAll('[data-key-exclude]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const qNum = parseInt(btn.dataset.keyExclude, 10);
      const entry = state.draftKey.entries[qNum];
      state.draftKey = entry?.excluded
        ? clearAnswer(state.draftKey, qNum)
        : excludeQuestion(state.draftKey, qNum);
      renderAnswerKey();
    });
  });

  byId('save-key-btn').addEventListener('click', async () => {
    await storage.saveAnswerKey(state.draftKey);
    if (test.answerKeyId !== state.draftKey.id) {
      const updatedTest = { ...test, answerKeyId: state.draftKey.id, updatedAt: new Date().toISOString() };
      await storage.saveTest(updatedTest);
      await loadAll();
    }
    alert('Answer key saved.');
    renderAnswerKey();
  });
}

// =======================================================================
// GRADE A SHEET  (manual entry standing in for the Part 2 scanner feed)
// =======================================================================
function ensureGradeRow(qNum) {
  if (!state.gradeRows.has(qNum)) state.gradeRows.set(qNum, { selected: new Set(), flag: null });
  return state.gradeRows.get(qNum);
}

function rowToDetectedAnswer(qNum, row) {
  if (row.flag === 'unclear') {
    return createDetectedAnswer({ questionNumber: qNum, selectedOptions: [...row.selected], state: AnswerState.UNCLEAR });
  }
  if (row.selected.size === 0) return createDetectedAnswer({ questionNumber: qNum, state: AnswerState.MISSING });
  if (row.selected.size === 1) return createDetectedAnswer({ questionNumber: qNum, selectedOptions: [...row.selected], state: AnswerState.CLEAR, confidence: 1 });
  return createDetectedAnswer({ questionNumber: qNum, selectedOptions: [...row.selected], state: AnswerState.MULTIPLE });
}

async function renderGradeSheet() {
  const el = byId('view-grade-sheet');
  if (state.tests.length === 0) {
    el.innerHTML = `<div class="view__header"><h1>Grade a sheet</h1></div><div class="empty-state">Create a test first.</div>`;
    return;
  }
  if (!state.gradeSheetTestId) state.gradeSheetTestId = state.tests[0].id;
  const test = getTest(state.gradeSheetTestId);
  const template = test.templateId ? getTemplate(test.templateId) : null;
  const questionDefs = buildQuestionDefinitions(test);
  const activeDefs = questionDefs.filter((q) => q.active);
  const unusedCount = questionDefs.length - activeDefs.length;

  el.innerHTML = `
    <div class="view__header">
      <div><h1>Grade a sheet</h1><p>${state.sheetsGradedThisSession} sheet${state.sheetsGradedThisSession === 1 ? '' : 's'} entered this session.</p></div>
      <select id="grade-test-select">${state.tests.map((t) => `<option value="${t.id}" ${t.id === test.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
    </div>

    ${!template ? '<div class="warning-box">No sheet template linked to this test — the bubble grid below will still work using the test\'s own question count and options, but unused-region reconciliation is unavailable.</div>' :
      unusedCount > 0 ? `<div class="warning-box">This template has ${unusedCount} bubble slot(s) beyond this test's ${test.totalQuestions} questions — they'll be recorded as unused automatically, never scored.</div>` : ''}

    <div class="sheet">
      <h3>Student identity</h3>
      <div class="field-row">
        ${test.identificationMethod === 'NAME_WRITTEN' ? `
          <div class="field"><label for="ident-name">Student name</label><input type="text" id="ident-name" value="${esc(state.gradeIdentity.name)}"></div>
        ` : `
          <div class="field"><label for="ident-roll">Roll number</label><input type="text" id="ident-roll" value="${esc(state.gradeIdentity.rollNumber)}"></div>
        `}
      </div>
    </div>

    <div class="sheet">
      <h3>Answers</h3>
      ${activeDefs.map((q) => {
        const row = ensureGradeRow(q.number);
        return `
        <div class="bubble-row">
          <span class="bubble-row__number">Q${q.number}</span>
          <div class="bubble-options">
            ${q.options.map((opt) => `<button class="bubble ${row.selected.has(opt) ? (row.selected.size > 1 ? 'selected state-multiple' : 'selected') : ''}" data-grade-q="${q.number}" data-grade-opt="${opt}">${opt}</button>`).join('')}
          </div>
          <div class="flag-btns">
            <button class="flag-btn ${row.flag === 'unclear' ? 'active-unclear' : ''}" data-grade-unclear="${q.number}">Unclear</button>
          </div>
        </div>
      `;
      }).join('')}
    </div>

    <button class="btn" id="save-sheet-btn">Save sheet &amp; grade</button>
    <button class="btn btn--secondary" id="clear-sheet-btn">Clear form</button>
    <div id="grade-result"></div>
  `;

  byId('grade-test-select').addEventListener('change', (e) => {
    state.gradeSheetTestId = e.target.value;
    state.gradeRows = new Map();
    renderGradeSheet();
  });

  el.querySelectorAll('[data-grade-q]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const qNum = parseInt(btn.dataset.gradeQ, 10);
      const opt = btn.dataset.gradeOpt;
      const row = ensureGradeRow(qNum);
      if (row.selected.has(opt)) row.selected.delete(opt); else row.selected.add(opt);
      renderGradeSheet();
    });
  });

  el.querySelectorAll('[data-grade-unclear]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const qNum = parseInt(btn.dataset.gradeUnclear, 10);
      const row = ensureGradeRow(qNum);
      row.flag = row.flag === 'unclear' ? null : 'unclear';
      renderGradeSheet();
    });
  });

  const identInput = byId('ident-roll') || byId('ident-name');
  identInput?.addEventListener('input', (e) => {
    if (test.identificationMethod === 'NAME_WRITTEN') state.gradeIdentity.name = e.target.value;
    else state.gradeIdentity.rollNumber = e.target.value;
  });

  byId('clear-sheet-btn').addEventListener('click', () => {
    state.gradeRows = new Map();
    state.gradeIdentity = { rollNumber: '', name: '' };
    renderGradeSheet();
  });

  byId('save-sheet-btn').addEventListener('click', async () => {
    const detected = activeDefs.map((q) => rowToDetectedAnswer(q.number, ensureGradeRow(q.number)));
    const reconciled = reconcileAnswers(questionDefs, detected);

    const hasIdentity = test.identificationMethod === 'NAME_WRITTEN' ? !!state.gradeIdentity.name.trim() : !!state.gradeIdentity.rollNumber.trim();
    const identity = createStudentIdentity({
      method: test.identificationMethod,
      rollNumber: state.gradeIdentity.rollNumber.trim() || null,
      name: state.gradeIdentity.name.trim() || null,
      state: hasIdentity ? IdentityState.CLEAR : IdentityState.MISSING,
      confidence: hasIdentity ? 1 : null
    });

    const fingerprint = await storage.computeFingerprint({ testId: test.id, identity, answers: reconciled.map((a) => ({ q: a.questionNumber, s: a.selectedOptions, st: a.state })) });
    const duplicates = await storage.getSheetsByFingerprint(fingerprint);

    const sheet = createScannedSheet({
      testId: test.id,
      templateId: test.templateId || 'unlinked',
      identity,
      answers: reconciled,
      scanFingerprint: fingerprint
    });
    await storage.saveSheet(sheet);

    const keys = await storage.getAnswerKeysForTest(test.id);
    const resultEl = byId('grade-result');
    if (keys.length > 0) {
      const result = gradeSheet(test, keys[keys.length - 1], sheet);
      resultEl.innerHTML = `
        <div class="sheet">
          <div class="score-hero"><span class="big">${result.totalPoints}</span><span class="of">/ ${result.maxPossiblePoints}</span></div>
          <p class="list-item__meta">${result.correctCount} correct · ${result.incorrectCount} incorrect · ${result.blankCount} blank ${result.needsReview.length ? `· <strong>${result.needsReview.length} need review</strong>` : ''}</p>
          ${duplicates.length > 1 ? '<div class="warning-box">This looks like a re-scan of a sheet already stored (matching fingerprint) — check Review before double-counting it.</div>' : ''}
        </div>
      `;
    } else {
      resultEl.innerHTML = `<div class="warning-box">Sheet saved. Add an answer key for this test to see a score.</div>`;
    }

    state.sheetsGradedThisSession += 1;
    state.gradeRows = new Map();
    state.gradeIdentity = { rollNumber: '', name: '' };
    renderGradeSheet();
    byId('grade-result').innerHTML = resultEl.innerHTML;
  });
}

// =======================================================================
// REVIEW & RESULTS
// =======================================================================
async function renderReview() {
  const el = byId('view-review');
  if (state.tests.length === 0) {
    el.innerHTML = `<div class="view__header"><h1>Review &amp; results</h1></div><div class="empty-state">Create a test first.</div>`;
    return;
  }
  if (!state.reviewTestId) state.reviewTestId = state.tests[0].id;
  const test = getTest(state.reviewTestId);
  const [sheets, keys] = await Promise.all([storage.getSheetsForTest(test.id), storage.getAnswerKeysForTest(test.id)]);
  const key = keys.length > 0 ? keys[keys.length - 1] : null;

  const graded = sheets.map((s) => ({ sheet: s, result: key ? gradeSheet(test, key, s) : null }));
  const scored = graded.filter((g) => g.result);
  const avg = scored.length ? (scored.reduce((sum, g) => sum + g.result.totalPoints, 0) / scored.length).toFixed(1) : null;
  const pendingReview = graded.filter((g) => (g.result && g.result.needsReview.length > 0) || answersNeedingReview(g.sheet).length > 0).length;

  el.innerHTML = `
    <div class="view__header">
      <div><h1>Review &amp; results</h1><p>${sheets.length} sheet${sheets.length === 1 ? '' : 's'} stored for this test.</p></div>
      <select id="review-test-select">${state.tests.map((t) => `<option value="${t.id}" ${t.id === test.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
    </div>

    ${!key ? '<div class="warning-box">No answer key saved for this test yet — sheets are stored, but can\'t be scored until one exists.</div>' : `
      <div class="sheet">
        <div class="field-row">
          <div><div class="list-item__meta">Average score</div><div class="score-hero"><span class="big">${avg}</span><span class="of">/ ${key ? buildQuestionDefinitions(test).filter((q) => q.active).length : ''}</span></div></div>
          <div><div class="list-item__meta">Needs a teacher's eyes</div><div class="score-hero"><span class="big">${pendingReview}</span><span class="of">of ${sheets.length}</span></div></div>
        </div>
      </div>
    `}

    ${sheets.length === 0 ? '<div class="empty-state">No sheets graded yet for this test.</div>' : `
      <table>
        <thead><tr><th>Student</th><th>Score</th><th>Flags</th><th>Scanned</th></tr></thead>
        <tbody>
          ${graded.map(({ sheet, result }) => `
            <tr class="list-item" data-open-sheet="${sheet.id}" style="cursor:pointer">
              <td>${esc(sheet.identity.rollNumber || sheet.identity.name || '—')}</td>
              <td>${result ? `${result.totalPoints} / ${result.maxPossiblePoints}` : '<span class="list-item__meta">no key yet</span>'}</td>
              <td>${result && result.needsReview.length ? `<span class="state-chip state-chip--unclear">${result.needsReview.length} review</span>` : result ? '<span class="state-chip state-chip--clear">clear</span>' : '—'}</td>
              <td>${new Date(sheet.timestamp).toLocaleString()}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `}

    <div id="sheet-detail"></div>
  `;

  byId('review-test-select').addEventListener('change', (e) => {
    state.reviewTestId = e.target.value;
    state.reviewSheetId = null;
    renderReview();
  });

  el.querySelectorAll('[data-open-sheet]').forEach((row) => {
    row.addEventListener('click', () => {
      state.reviewSheetId = row.dataset.openSheet;
      renderSheetDetail(test, key, graded.find((g) => g.sheet.id === state.reviewSheetId));
    });
  });

  if (state.reviewSheetId) {
    const match = graded.find((g) => g.sheet.id === state.reviewSheetId);
    if (match) renderSheetDetail(test, key, match);
  }
}

function stateChipClass(s) { return `state-chip state-chip--${s.toLowerCase()}`; }

function renderSheetDetail(test, key, graded) {
  if (!graded) return;
  const { sheet, result } = graded;
  const detailEl = byId('sheet-detail');
  detailEl.innerHTML = `
    <div class="sheet">
      <h3>${esc(sheet.identity.rollNumber || sheet.identity.name || 'Unidentified student')}</h3>
      <p class="list-item__meta">Identity: <span class="${stateChipClass(sheet.identity.state)}">${sheet.identity.state}</span></p>
      ${!result ? '<p class="list-item__meta">No answer key saved yet — showing detected answers only, no scoring.</p>' : ''}
      ${sheet.answers.map((a) => {
        const scoreRow = result ? result.perQuestion.find((r) => r.questionNumber === a.questionNumber) : null;
        return `
        <div class="bubble-row">
          <span class="bubble-row__number">Q${a.questionNumber}</span>
          <span>${a.selectedOptions.join(', ') || '—'}</span>
          <span class="${stateChipClass(a.state)}">${a.state}</span>
          <span class="flag-btns list-item__meta">${scoreRow ? scoreRow.reason.replace(/_/g, ' ').toLowerCase() : ''}</span>
        </div>
      `;
      }).join('')}
    </div>
  `;
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
async function boot() {
  wireNav();
  await loadAll();
  render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is best-effort */ });
  }
}

boot();
