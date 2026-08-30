'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

/**
 * Loading and rendering eval cases.
 *
 * A case supplies its input in one of three forms, because the useful inputs are not all
 * the same shape:
 *
 *   input:        an inline string, for cases small enough to read in the file
 *   input_file:   a path relative to evals/, for real harvested fixtures too big to inline
 *   input_repeat: a prefix plus a line repeated N times, for length-pressure cases where
 *                 pasting a thousand lines into YAML would make the case unreadable
 *
 * Exactly one must be present. A case with none would silently evaluate the empty string
 * and pass every format assertion for entirely the wrong reason, so that is an error.
 */

function renderInput(spec, evalsDir) {
  const forms = ['input', 'input_file', 'input_repeat'].filter((k) => k in spec);
  if (forms.length === 0) {
    throw new Error(`case "${spec.id}" has no input, input_file, or input_repeat`);
  }
  if (forms.length > 1) {
    throw new Error(`case "${spec.id}" has more than one input form: ${forms.join(', ')}`);
  }

  if ('input' in spec) return spec.input;

  if ('input_file' in spec) {
    const file = path.join(evalsDir, spec.input_file);
    if (!fs.existsSync(file)) {
      throw new Error(
        `case "${spec.id}" references ${spec.input_file}, which does not exist. ` +
        `Run "npm run harvest" to fetch the fixtures.`
      );
    }
    return fs.readFileSync(file, 'utf8');
  }

  const { prefix = '', line, count } = spec.input_repeat;
  if (!line || !count) {
    throw new Error(`case "${spec.id}" input_repeat needs both "line" and "count"`);
  }
  const lines = [];
  for (let i = 1; i <= count; i++) lines.push(line.replace(/\{i\}/g, String(i)));
  return prefix + lines.join('\n') + '\n';
}

function loadCase(caseId, evalsDir) {
  const file = path.join(evalsDir, 'cases', `${caseId}.yaml`);
  const spec = yaml.load(fs.readFileSync(file, 'utf8'));
  if (spec.id !== caseId) {
    throw new Error(`case file ${caseId}.yaml declares id "${spec.id}"; they must match`);
  }

  const assertions = (spec.expects || []).filter((e) => e.type === 'assertion');
  const rubrics = (spec.expects || []).filter((e) => e.type === 'rubric');
  const unknown = (spec.expects || []).filter((e) => !['assertion', 'rubric'].includes(e.type));
  if (unknown.length) {
    throw new Error(`case "${caseId}" has unsupported expectation types: ${unknown.map((u) => u.type).join(', ')}`);
  }

  return {
    id: spec.id,
    description: spec.description,
    input: renderInput(spec, evalsDir),
    assertions,
    rubrics,
  };
}

function loadSuite(evalsDir) {
  const suite = yaml.load(fs.readFileSync(path.join(evalsDir, 'suite.yaml'), 'utf8'));
  return {
    ...suite,
    cases: suite.cases.map((id) => loadCase(id, evalsDir)),
  };
}

/**
 * Render a prompt template the way ORCHESTRA's loader does, so the suite sends the model
 * exactly the string the real judge would send. See backend/prompts/index.js: one trailing
 * newline is dropped, and {{name}} placeholders are substituted with strings.
 */
function renderPrompt(template, vars) {
  return template.replace(/\n$/, '').replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in vars)) {
      throw new Error(`prompt expects variable "${key}" but it was not provided`);
    }
    return vars[key];
  });
}

module.exports = { loadCase, loadSuite, renderInput, renderPrompt };
