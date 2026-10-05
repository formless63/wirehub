// WireHub config generator — the page: reads the form, calls the generator
// (generate.js), shows both files and their notes, copies and downloads.
// No network, no storage: the build inlines this script, generate.js and the
// templates into one page (build.mjs).

import { browserRandom, browserSecrets, DEFAULTS, defaultImage, generateCompose, generateEnv, withDefaults } from './generate.js';

/* global TEMPLATES */

const form = document.getElementById('options');
const out = { compose: document.getElementById('compose-out'), env: document.getElementById('env-out') };
const files = { compose: '', env: '' };
let secretCache = {};

function moduleBoxes() {
  const box = document.getElementById('modules');
  for (const module of TEMPLATES.modules) {
    const label = document.createElement('label');
    label.className = 'choice module';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'modules';
    input.value = module.id;
    const name = document.createElement('span');
    name.textContent = module.label;
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = module.description;
    label.append(input, name, hint);
    box.append(label);
  }
}

/** The form as generator options. */
function readOptions() {
  const options = withDefaults();
  for (const element of form.elements) {
    if (!element.name || element.name === 'modules') continue;
    const [group, key] = element.name.includes('.') ? element.name.split('.') : [undefined, element.name];
    let value;
    if (element.type === 'radio') {
      if (!element.checked) continue;
      value = element.value;
    } else if (element.type === 'checkbox') {
      value = element.checked;
    } else {
      value = element.value.trim() === '' ? undefined : element.value;
    }
    if (value === undefined) continue;
    if (group === undefined) options[key] = value;
    else options[group] = { ...options[group], [key]: value };
  }
  options.modules = [...form.querySelectorAll('input[name=modules]:checked')].map((input) => input.value);
  return options;
}

/** Show the sub-fields of the choices that are made. */
function showWhen(options) {
  for (const box of form.querySelectorAll('[data-when]')) {
    const rule = box.dataset.when;
    const [path, wanted] = rule.split(/!?=/);
    const [group, key] = path.includes('.') ? path.split('.') : [undefined, path];
    const actual = group === undefined ? options[key] : options[group][key];
    const shown = !rule.includes('=') ? actual === true : rule.includes('!=') ? String(actual) !== wanted : String(actual) === wanted;
    box.classList.toggle('shown', shown);
  }
}

/** The secrets made here: generated once per name, kept until "New secrets". */
function secretsFor(options) {
  if (options.secrets !== 'browser') return {};
  const fresh = browserSecrets(options, browserRandom);
  const picked = {};
  for (const name of Object.keys(fresh)) {
    if (secretCache[name] === undefined) secretCache[name] = fresh[name];
    picked[name] = secretCache[name];
  }
  return picked;
}

function render() {
  const options = readOptions();
  showWhen(options);
  const env = generateEnv(TEMPLATES, options, secretsFor(options));
  files.compose = generateCompose(TEMPLATES.compose, options);
  files.env = env.text;
  out.compose.textContent = files.compose;
  out.env.textContent = files.env;
  const notes = document.getElementById('notes');
  notes.replaceChildren(
    ...env.notes.map((note) => {
      const li = document.createElement('li');
      li.className = note.level;
      li.textContent = note.text;
      return li;
    }),
  );
}

async function copy(which, button) {
  try {
    await navigator.clipboard.writeText(files[which]);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(out[which]);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('copy');
  }
  button.classList.add('copied');
  button.textContent = 'Copied';
  setTimeout(() => {
    button.classList.remove('copied');
    button.textContent = 'Copy';
  }, 1500);
}

function download(which) {
  const name = which === 'compose' ? 'compose.yaml' : '.env';
  const url = URL.createObjectURL(new Blob([files[which]], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

moduleBoxes();
form.elements.bind.value = DEFAULTS.bind;
form.elements.imageTag.placeholder = defaultImage(TEMPLATES.compose).split(':').pop();
form.addEventListener('input', render);
form.addEventListener('change', render);
form.addEventListener('submit', (event) => event.preventDefault());
document.getElementById('new-secrets').addEventListener('click', () => {
  secretCache = {};
  render();
});
for (const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click', () => void copy(button.dataset.copy, button));
for (const button of document.querySelectorAll('[data-download]')) button.addEventListener('click', () => download(button.dataset.download));
render();
