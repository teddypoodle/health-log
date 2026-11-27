// ------------------------------------------------------------------
// app.js — screens and logic for Health Log.
// Data lives in your Google Sheet; this file only reads and writes it.
// ------------------------------------------------------------------

const S = {
  data: {},            // { TabName: [rowObjects] }
  view: 'dashboard',
  navDate: todayStr(), // date shown on the Nutrition screen
  histTab: 'activity',
  logger: null         // strength session in progress
};

const DATE_FIELDS = {
  Goals: ['effective_date'], Nutrition: ['date'], Workouts: ['date'],
  Activity_Sync: ['date'], Workout_Schedule: ['date']
};
const MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
const DEFAULT_GOALS = { calories: 2200, protein_g: 150, carbs_g: 220, fat_g: 70, fiber_g: 30,
  sugar_g_max: 50, sodium_mg_max: 2300, steps: 10000, active_kcal: 500, weekly_run_distance: 10 };
const ACTIVITY_METRICS = [
  { key: 'active_kcal', label: 'Active calories', unit: 'kcal', type: 'number' },
  { key: 'steps', label: 'Steps', unit: '', type: 'number' },
  { key: 'distance', label: 'Walk + run distance', unit: 'dist', type: 'number' },
  { key: 'run_distance', label: 'Run distance', unit: 'dist', type: 'number' },
  { key: 'workout_types', label: 'Workout types', unit: '', type: 'text' }
];

// ---------------- Small helpers ----------------
function pad(n) { return String(n).padStart(2, '0'); }
function todayStr(d = new Date()) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function nowTime() { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function nowStamp() { return todayStr() + ' ' + nowTime() + ':' + pad(new Date().getSeconds()); }
function addDays(dateStr, n) { const d = new Date(dateStr + 'T12:00:00'); d.setDate(d.getDate() + n); return todayStr(d); }
function prettyDate(s) {
  if (!s) return '';
  const d = new Date(s + 'T12:00:00');
  if (s === todayStr()) return 'Today';
  if (s === addDays(todayStr(), 1)) return 'Tomorrow';
  if (s === addDays(todayStr(), -1)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function normDate(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number') { // Sheets serial date, in case a cell lost its date format
    const ms = Date.UTC(1899, 11, 30) + Math.round(v * 864e5);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(d) ? s : todayStr(d);
}
function num(v) { const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? 0 : n; }
function blank(v) { return v === '' || v === null || v === undefined; }
function fmt(n, dp = 0) { return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: dp, minimumFractionDigits: 0 }); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function uid(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); }
function isTrue(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
const $ = sel => document.querySelector(sel);

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------------- Derived data ----------------
function settings() {
  const o = { weight_unit: 'lb', distance_unit: 'mi' };
  (S.data.Settings || []).forEach(r => { if (r.key) o[r.key] = String(r.value); });
  return o;
}
function distUnit() { return settings().distance_unit; }
function wtUnit() { return settings().weight_unit; }

function currentGoals() {
  const today = todayStr();
  const rows = (S.data.Goals || []).filter(r => r.effective_date && r.effective_date <= today)
    .sort((a, b) => b.effective_date.localeCompare(a.effective_date));
  const g = rows[0];
  if (!g) return { ...DEFAULT_GOALS };
  const out = { ...g };
  Object.keys(DEFAULT_GOALS).forEach(k => { if (blank(out[k])) out[k] = DEFAULT_GOALS[k]; });
  return out;
}

function nutritionFor(date) {
  return (S.data.Nutrition || []).filter(r => r.date === date && !isTrue(r.deleted))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
}
function totals(entries) {
  const t = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 0 };
  entries.forEach(e => Object.keys(t).forEach(k => { t[k] += num(e[k]); }));
  return t;
}

function activityRow(date) { return (S.data.Activity_Sync || []).find(r => r.date === date); }
/** The value to show: your override if you entered one, otherwise the synced value. */
function eff(row, key) {
  if (!row) return '';
  return !blank(row[key + '_ovr']) ? row[key + '_ovr'] : row[key];
}
function isOverridden(row) { return !!row && ACTIVITY_METRICS.some(m => !blank(row[m.key + '_ovr'])); }

function libraryById(id) { return (S.data.Exercise_Library || []).find(e => String(e.exercise_id) === String(id)); }
function templateExercises(templateId) {
  return (S.data.Workout_Templates || []).filter(t => String(t.template_id) === String(templateId))
    .sort((a, b) => num(a.order) - num(b.order))
    .map(t => ({ ...t, lib: libraryById(t.exercise_id) || { name: t.exercise_id, form_cue: '' } }));
}
function liveSets() { return (S.data.Workouts || []).filter(r => !isTrue(r.deleted)); }
function lastWeight(exerciseId) {
  const sets = liveSets().filter(r => String(r.exercise_id) === String(exerciseId) && !blank(r.weight))
    .sort((a, b) => (b.date + b.updated_at).localeCompare(a.date + a.updated_at));
  return sets.length ? sets[0].weight : '';
}
function upcoming() {
  const from = addDays(todayStr(), -7);
  return (S.data.Workout_Schedule || [])
    .filter(r => r.date && r.date >= from && !['Done', 'Skipped'].includes(String(r.status)))
    .sort((a, b) => a.date.localeCompare(b.date));
}
function sessions() {
  const map = {};
  liveSets().forEach(r => {
    (map[r.session_id] = map[r.session_id] || { session_id: r.session_id, date: r.date, name: r.workout_name, sets: [] }).sets.push(r);
  });
  return Object.values(map).sort((a, b) => b.date.localeCompare(a.date));
}
function weekRunTotal() {
  // Monday-start week
  const d = new Date(); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day);
  const start = todayStr(d);
  return (S.data.Activity_Sync || []).filter(r => r.date >= start && r.date <= todayStr())
    .reduce((s, r) => s + num(eff(r, 'run_distance')), 0);
}

// ---------------- Loading & errors ----------------
async function load() {
  const data = await Sheets.readTabs(Object.keys(HEADERS));
  Object.keys(DATE_FIELDS).forEach(tab => (data[tab] || []).forEach(r => DATE_FIELDS[tab].forEach(f => { r[f] = normDate(r[f]); })));
  (data.Nutrition || []).forEach(r => {
    const m = String(r.time).match(/^(\d{1,2}):(\d{2})/);
    r.time = m ? pad(m[1]) + ':' + m[2] : '';
  });
  S.data = data;
}

async function run(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
    return true;
  } catch (err) {
    console.error(err);
    if (err instanceof AuthError) { showSignIn(); toast('Please sign in again'); }
    else toast(err.message || 'Something went wrong');
    return false;
  }
}

async function saveAndReload(fn, okMsg) {
  const ok = await run(async () => { await fn(); await load(); }, okMsg);
  if (ok) render();
  return ok;
}

// ---------------- UI pieces ----------------
function bar(label, value, target, unit, mode = 'min') {
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  const over = mode === 'max' && value > target;
  return `<div class="bar ${over ? 'over' : ''}">
    <div class="top"><span>${esc(label)}</span><span>${fmt(value)} / ${fmt(target)} ${esc(unit)}${mode === 'max' ? ' max' : ''}</span></div>
    <div class="track"><div class="fill" style="width:${pct}%"></div></div></div>`;
}
function macroBars(t, g) {
  return bar('Protein', t.protein_g, num(g.protein_g), 'g') +
    bar('Carbs', t.carbs_g, num(g.carbs_g), 'g') +
    bar('Fat', t.fat_g, num(g.fat_g), 'g') +
    bar('Fiber', t.fiber_g, num(g.fiber_g), 'g') +
    bar('Sugar', t.sugar_g, num(g.sugar_g_max), 'g', 'max') +
    bar('Sodium', t.sodium_mg, num(g.sodium_mg_max), 'mg', 'max');
}

// ----- Generic form modal -----
function fieldHtml(f) {
  if (Array.isArray(f)) return `<div class="fields-2">${f.map(fieldHtml).join('')}</div>`;
  if (f.type === 'heading') return `<h4 style="margin:14px 0 6px">${esc(f.label)}</h4>`;
  const id = 'f_' + f.key.replace(/[^a-z0-9_]/gi, '_');
  const val = blank(f.value) ? '' : f.value;
  let input;
  if (f.type === 'select') {
    input = `<select id="${id}" name="${esc(f.key)}">${f.options.map(o => `<option ${String(o) === String(val) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea id="${id}" name="${esc(f.key)}" rows="2">${esc(val)}</textarea>`;
  } else if (f.type === 'checkbox') {
    input = `<input type="checkbox" id="${id}" name="${esc(f.key)}" ${val ? 'checked' : ''} style="width:auto">`;
  } else {
    const mode = f.type === 'number' ? ' inputmode="decimal" step="any"' : '';
    input = `<input id="${id}" name="${esc(f.key)}" type="${f.type || 'text'}" value="${esc(val)}"${mode}
      ${f.placeholder !== undefined ? `placeholder="${esc(f.placeholder)}"` : ''} ${f.list ? `list="${f.list}"` : ''} ${f.required ? 'required' : ''}>`;
  }
  return `<div class="field"><label for="${id}">${esc(f.label)}</label>${input}${f.note ? `<span class="synced">${esc(f.note)}</span>` : ''}</div>`;
}

function openForm({ title, fields, onSave, onDelete, saveLabel = 'Save', extraHtml = '', afterOpen }) {
  const modal = $('#modal');
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = extraHtml + fields.map(fieldHtml).join('');
  $('#modalSave').textContent = saveLabel;
  $('#modalDelete').hidden = !onDelete;
  $('#modalCancel').onclick = () => modal.close();
  $('#modalDelete').onclick = async () => {
    if (!confirm('Delete this entry?')) return;
    if (await saveAndReload(onDelete, 'Deleted')) modal.close();
  };
  $('#modalForm').onsubmit = async e => {
    e.preventDefault();
    const vals = {};
    $('#modalBody').querySelectorAll('[name]').forEach(el => { vals[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim(); });
    $('#modalSave').disabled = true;
    const ok = await saveAndReload(() => onSave(vals), 'Saved');
    $('#modalSave').disabled = false;
    if (ok) modal.close();
  };
  modal.showModal();
  if (afterOpen) afterOpen();
}

// ---------------- Screens ----------------
const TITLES = { dashboard: 'Dashboard', nutrition: 'Nutrition', workouts: 'Workouts', history: 'History & Sync', logger: 'Log workout' };

function render() {
  $('#viewTitle').textContent = TITLES[S.view] || 'Health Log';
  document.querySelectorAll('.bottomnav button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === S.view || (S.view === 'logger' && b.dataset.view === 'workouts')));
  const v = $('#view');
  if (S.view === 'dashboard') v.innerHTML = viewDashboard();
  if (S.view === 'nutrition') v.innerHTML = viewNutrition();
  if (S.view === 'workouts') v.innerHTML = viewWorkouts();
  if (S.view === 'logger') v.innerHTML = viewLogger();
  if (S.view === 'history') v.innerHTML = viewHistory();
}

// ----- Dashboard -----
function viewDashboard() {
  const today = todayStr();
  const g = currentGoals();
  const t = totals(nutritionFor(today));
  const a = activityRow(today);
  const du = distUnit();
  const next = upcoming()[0];
  const left = num(g.calories) - t.calories;
  return `
  <div class="card">
    <h2>Today's nutrition</h2>
    <div class="row"><div><div class="big">${fmt(t.calories)}</div><div class="muted">of ${fmt(g.calories)} kcal</div></div>
      <div style="text-align:right"><div class="big" style="color:${left < 0 ? 'var(--bad)' : 'var(--accent)'}">${fmt(Math.abs(left))}</div>
      <div class="muted">${left < 0 ? 'over' : 'left'}</div></div></div>
    ${bar('Calories', t.calories, num(g.calories), 'kcal', 'max')}
    ${macroBars(t, g)}
  </div>
  <div class="card" data-action="edit-activity" data-date="${today}" style="cursor:pointer">
    <h2>Today's activity ${isOverridden(a) ? '<span class="badge">edited</span>' : ''}</h2>
    <div class="grid2 grid4">
      <div class="stat"><div class="label">Active kcal</div><div class="value">${a ? fmt(eff(a, 'active_kcal')) : '–'}</div><div class="label">goal ${fmt(g.active_kcal)}</div></div>
      <div class="stat"><div class="label">Steps</div><div class="value">${a ? fmt(eff(a, 'steps')) : '–'}</div><div class="label">goal ${fmt(g.steps)}</div></div>
      <div class="stat"><div class="label">Distance</div><div class="value">${a ? fmt(eff(a, 'distance'), 2) : '–'}</div><div class="label">${esc(du)}</div></div>
      <div class="stat"><div class="label">Run this week</div><div class="value">${fmt(weekRunTotal(), 1)}</div><div class="label">of ${fmt(g.weekly_run_distance)} ${esc(du)}</div></div>
    </div>
    <p class="hint" style="margin:10px 0 0">${a && a.synced_at ? 'Synced from iPhone ' + esc(a.synced_at) : 'No iPhone sync yet today'} · tap to edit</p>
  </div>
  <div class="card">
    <h2>Next workout</h2>
    ${next ? `<div class="row"><div><strong>${esc(next.title)}</strong><div class="sub muted">${prettyDate(next.date)} · ${esc(next.type)}${next.planned_distance ? ' · ' + esc(next.planned_distance) + ' ' + esc(du) : ''}</div></div>
      <button class="primary small" data-action="open-schedule" data-id="${esc(next.schedule_id)}">${next.type === 'Strength' ? 'Start' : 'Open'}</button></div>`
      : '<p class="muted">Nothing scheduled. Add rows to the Workout_Schedule tab.</p>'}
  </div>`;
}

// ----- Nutrition -----
function viewNutrition() {
  const d = S.navDate;
  const entries = nutritionFor(d);
  const t = totals(entries);
  const g = currentGoals();
  const byMeal = MEALS.map(m => ({ meal: m, items: entries.filter(e => e.meal === m) }));
  const other = entries.filter(e => !MEALS.includes(e.meal));
  if (other.length) byMeal.push({ meal: 'Other', items: other });
  return `
  <div class="datenav">
    <button class="secondary small" data-action="day" data-delta="-1">&larr;</button>
    <input type="date" value="${d}" data-action="pick-date">
    <button class="secondary small" data-action="day" data-delta="1">&rarr;</button>
  </div>
  <div class="card">
    <div class="row"><h2 style="margin:0">${prettyDate(d)}</h2><button class="text-btn" data-action="targets">Targets</button></div>
    ${bar('Calories', t.calories, num(g.calories), 'kcal', 'max')}
    ${macroBars(t, g)}
  </div>
  ${byMeal.map(m => `
    <div class="card"><div class="row"><h2 style="margin:0">${m.meal}</h2><span class="muted">${fmt(totals(m.items).calories)} kcal</span></div>
    <ul class="list">${m.items.map(e => `
      <li data-action="edit-food" data-id="${esc(e.entry_id)}">
        <div><div>${esc(e.food)}${num(e.servings) && num(e.servings) !== 1 ? ' × ' + esc(e.servings) : ''}</div>
        <div class="sub">P ${fmt(e.protein_g)} · C ${fmt(e.carbs_g)} · F ${fmt(e.fat_g)}${e.time ? ' · ' + esc(e.time) : ''}</div></div>
        <strong>${fmt(e.calories)}</strong></li>`).join('') || '<li class="muted" style="cursor:default">Nothing logged</li>'}
    </ul></div>`).join('')}
  <button class="primary full" data-action="add-food">+ Add food</button>`;
}

function foodFields(e = {}) {
  return [
    [{ key: 'date', label: 'Date', type: 'date', value: e.date || S.navDate, required: true },
     { key: 'time', label: 'Time', type: 'time', value: e.time || nowTime() }],
    [{ key: 'meal', label: 'Meal', type: 'select', options: MEALS, value: e.meal || guessMeal() },
     { key: 'servings', label: 'Servings', type: 'number', value: e.servings || 1 }],
    { key: 'food', label: 'Food (pick a recent one to copy its numbers)', value: e.food, list: 'recentFoods', required: true },
    [{ key: 'calories', label: 'Calories (kcal)', type: 'number', value: e.calories },
     { key: 'protein_g', label: 'Protein (g)', type: 'number', value: e.protein_g }],
    [{ key: 'carbs_g', label: 'Carbs (g)', type: 'number', value: e.carbs_g },
     { key: 'fat_g', label: 'Fat (g)', type: 'number', value: e.fat_g }],
    [{ key: 'fiber_g', label: 'Fiber (g)', type: 'number', value: e.fiber_g },
     { key: 'sugar_g', label: 'Sugar (g)', type: 'number', value: e.sugar_g }],
    [{ key: 'sodium_mg', label: 'Sodium (mg)', type: 'number', value: e.sodium_mg },
     { key: 'notes', label: 'Notes', value: e.notes }]
  ];
}
function guessMeal() { const h = new Date().getHours(); return h < 11 ? 'Breakfast' : h < 15 ? 'Lunch' : h < 21 ? 'Dinner' : 'Snack'; }
function recentFoodsHtml() {
  const seen = new Map();
  (S.data.Nutrition || []).filter(r => !isTrue(r.deleted)).slice().reverse().forEach(r => { if (r.food && !seen.has(r.food)) seen.set(r.food, r); });
  recentFoodsHtml.map = seen;
  return `<datalist id="recentFoods">${[...seen.keys()].slice(0, 200).map(f => `<option value="${esc(f)}">`).join('')}</datalist>`;
}
function wireFoodAutofill() {
  const food = $('#f_food');
  food.addEventListener('change', () => {
    const r = recentFoodsHtml.map && recentFoodsHtml.map.get(food.value);
    if (!r) return;
    ['servings', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg'].forEach(k => {
      const el = $('#f_' + k); if (el && !blank(r[k])) el.value = r[k];
    });
  });
}

function addFood() {
  openForm({
    title: 'Add food', fields: foodFields(), extraHtml: recentFoodsHtml(), afterOpen: wireFoodAutofill,
    onSave: v => Sheets.append('Nutrition', [{ ...v, entry_id: uid('n'), deleted: false, updated_at: nowStamp() }])
  });
}
function editFood(id) {
  const e = (S.data.Nutrition || []).find(r => r.entry_id === id);
  if (!e) return;
  openForm({
    title: 'Edit food', fields: foodFields(e), extraHtml: recentFoodsHtml(), afterOpen: wireFoodAutofill,
    onSave: v => Sheets.updateRows('Nutrition', [{ ...e, ...v, updated_at: nowStamp() }]),
    onDelete: () => Sheets.updateRows('Nutrition', [{ ...e, deleted: true, updated_at: nowStamp() }])
  });
}
function editTargets() {
  const g = currentGoals();
  const du = distUnit();
  openForm({
    title: 'Daily targets',
    fields: [
      [{ key: 'calories', label: 'Calories (kcal)', type: 'number', value: g.calories },
       { key: 'protein_g', label: 'Protein (g)', type: 'number', value: g.protein_g }],
      [{ key: 'carbs_g', label: 'Carbs (g)', type: 'number', value: g.carbs_g },
       { key: 'fat_g', label: 'Fat (g)', type: 'number', value: g.fat_g }],
      [{ key: 'fiber_g', label: 'Fiber, at least (g)', type: 'number', value: g.fiber_g },
       { key: 'sugar_g_max', label: 'Sugar, at most (g)', type: 'number', value: g.sugar_g_max }],
      [{ key: 'sodium_mg_max', label: 'Sodium, at most (mg)', type: 'number', value: g.sodium_mg_max },
       { key: 'steps', label: 'Steps', type: 'number', value: g.steps }],
      [{ key: 'active_kcal', label: 'Active calories', type: 'number', value: g.active_kcal },
       { key: 'weekly_run_distance', label: `Weekly run (${du})`, type: 'number', value: g.weekly_run_distance }],
      { key: 'notes', label: 'Notes', value: '' }
    ],
    onSave: v => {
      const today = todayStr();
      const existing = (S.data.Goals || []).find(r => r.effective_date === today);
      return existing
        ? Sheets.updateRows('Goals', [{ ...existing, ...v, effective_date: today }])
        : Sheets.append('Goals', [{ ...v, effective_date: today }]);
    }
  });
}

// ----- Workouts -----
function viewWorkouts() {
  const du = distUnit();
  const list = upcoming();
  const recent = sessions().slice(0, 5);
  const draft = S.logger;
  return `
  ${draft ? `<div class="card"><div class="row"><div><strong>Workout in progress</strong><div class="sub muted">${esc(draft.title)} · ${prettyDate(draft.date)}</div></div>
    <button class="primary small" data-action="resume">Resume</button></div></div>` : ''}
  <div class="card"><h2>Upcoming</h2>
    <ul class="list">${list.map(s => `
      <li data-action="open-schedule" data-id="${esc(s.schedule_id)}">
        <div><div>${esc(s.title)} <span class="badge">${esc(s.type)}</span></div>
        <div class="sub">${prettyDate(s.date)}${s.date < todayStr() ? ' (missed)' : ''}${s.planned_distance ? ' · ' + esc(s.planned_distance) + ' ' + esc(du) : ''}${s.details ? ' · ' + esc(s.details) : ''}</div></div>
        <span class="muted">&rsaquo;</span></li>`).join('') || '<li class="muted" style="cursor:default">Nothing scheduled. Add rows to the Workout_Schedule tab.</li>'}
    </ul></div>
  <button class="secondary full" data-action="adhoc">Log an unscheduled strength workout</button>
  <div class="card" style="margin-top:12px"><h2>Recently logged</h2>
    <ul class="list">${recent.map(s => `<li data-action="edit-session" data-id="${esc(s.session_id)}">
      <div><div>${esc(s.name)}</div><div class="sub">${prettyDate(s.date)} · ${s.sets.length} sets</div></div><span class="muted">Edit</span></li>`).join('')
      || '<li class="muted" style="cursor:default">No sessions yet</li>'}</ul></div>`;
}

function openSchedule(id) {
  const s = (S.data.Workout_Schedule || []).find(r => String(r.schedule_id) === String(id));
  if (!s) return;
  if (s.type === 'Strength' && s.template_id) return startLogger(s.template_id, s.title, s.schedule_id, s.date > todayStr() ? todayStr() : s.date);
  openForm({
    title: s.title,
    extraHtml: `<p class="muted">${prettyDate(s.date)} · ${esc(s.type)}${s.planned_distance ? ' · ' + esc(s.planned_distance) + ' ' + esc(distUnit()) : ''}</p>
      ${s.details ? `<p>${esc(s.details)}</p>` : ''}<p class="hint">Your run's distance arrives from the iPhone Shortcut. Mark it done here.</p>`,
    fields: [{ key: 'status', label: 'Status', type: 'select', options: ['Planned', 'Done', 'Skipped'], value: s.status || 'Planned' }],
    onSave: v => Sheets.updateCells('Workout_Schedule', s._row, { status: v.status })
  });
}

function startLogger(templateId, title, scheduleId, date) {
  const ex = templateExercises(templateId);
  if (!ex.length) { toast('Template ' + templateId + ' has no exercises in Workout_Templates'); return; }
  S.logger = {
    schedule_id: scheduleId || '', template_id: templateId, title: title || templateId, date: date || todayStr(),
    exercises: ex.map(t => {
      const w = blank(t.target_weight) ? lastWeight(t.exercise_id) : t.target_weight;
      const n = Math.max(1, num(t.target_sets) || 3);
      return {
        exercise_id: t.exercise_id, name: t.lib.name, cue: t.lib.form_cue, video: t.lib.video_url,
        target: `${n} × ${t.target_reps || '?'}${blank(t.target_weight) ? '' : ' @ ' + t.target_weight + ' ' + wtUnit()}${t.rest_sec ? ' · rest ' + t.rest_sec + 's' : ''}`,
        notes: t.notes || '', repsHint: String(t.target_reps || ''),
        sets: Array.from({ length: n }, () => ({ reps: '', weight: w, rpe: '' }))
      };
    })
  };
  saveDraft();
  S.view = 'logger'; render(); window.scrollTo(0, 0);
}
function saveDraft() { try { S.logger ? localStorage.setItem('hl_logger', JSON.stringify(S.logger)) : localStorage.removeItem('hl_logger'); } catch (e) { /* ignore */ } }

function viewLogger() {
  const L = S.logger;
  if (!L) { S.view = 'workouts'; return viewWorkouts(); }
  return `
  <div class="card"><div class="row"><strong>${esc(L.title)}</strong><input type="date" value="${L.date}" data-action="logger-date"></div></div>
  ${L.exercises.map((x, i) => `
    <div class="card exercise">
      <div class="row"><strong>${esc(x.name)}</strong><span class="muted" style="font-size:13px">${esc(x.target)}</span></div>
      ${x.cue ? `<div class="cue">${esc(x.cue)}${x.video ? ` <a href="${esc(x.video)}" target="_blank" rel="noopener">video</a>` : ''}</div>` : ''}
      ${x.notes ? `<div class="cue">${esc(x.notes)}</div>` : ''}
      <table class="sets"><thead><tr><th>Set</th><th>Reps</th><th>Weight (${esc(wtUnit())})</th><th>RPE</th><th></th></tr></thead><tbody>
      ${x.sets.map((s, j) => `<tr>
        <td>${j + 1}</td>
        <td><input inputmode="numeric" data-ex="${i}" data-set="${j}" data-f="reps" value="${esc(s.reps)}" placeholder="${esc(x.repsHint)}"></td>
        <td><input inputmode="decimal" data-ex="${i}" data-set="${j}" data-f="weight" value="${esc(s.weight)}"></td>
        <td><input inputmode="decimal" data-ex="${i}" data-set="${j}" data-f="rpe" value="${esc(s.rpe)}"></td>
        <td><button class="x" data-action="rm-set" data-ex="${i}" data-set="${j}" aria-label="Remove set">&times;</button></td></tr>`).join('')}
      </tbody></table>
      <div class="row"><button class="text-btn" data-action="add-set" data-ex="${i}">+ Add set</button>
        <button class="text-btn" style="color:var(--muted)" data-action="rm-exercise" data-ex="${i}">Remove exercise</button></div>
    </div>`).join('') || '<div class="card"><p class="muted" style="margin:0">No exercises yet. Tap "Add exercise" to start.</p></div>'}
  <button class="secondary full" data-action="add-exercise" style="margin-bottom:12px">+ Add exercise</button>
  <button class="primary full" data-action="save-session">Save workout</button>
  <button class="text-btn full" style="margin-top:8px" data-action="discard-session">Discard</button>`;
}

async function saveSession() {
  const L = S.logger;
  const sessionId = uid('w');
  const stamp = nowStamp();
  const rows = [];
  L.exercises.forEach(x => {
    let n = 0;
    x.sets.forEach(s => {
      if (blank(s.reps) && blank(s.weight)) return;
      if (blank(s.reps)) return; // a set without reps wasn't done
      n += 1;
      rows.push({ entry_id: uid('s'), session_id: sessionId, date: L.date, schedule_id: L.schedule_id,
        workout_name: L.title, exercise_id: x.exercise_id, exercise_name: x.name, set_no: n,
        reps: s.reps, weight: s.weight, rpe: s.rpe, notes: '', deleted: false, updated_at: stamp });
    });
  });
  if (!rows.length) { toast('Enter reps for at least one set'); return; }
  const ok = await saveAndReload(async () => {
    await Sheets.append('Workouts', rows);
    const sched = (S.data.Workout_Schedule || []).find(r => L.schedule_id && String(r.schedule_id) === String(L.schedule_id));
    if (sched) await Sheets.updateCells('Workout_Schedule', sched._row, { status: 'Done', completed_session_id: sessionId });
  }, `Saved ${rows.length} sets`);
  if (ok) { S.logger = null; saveDraft(); S.view = 'workouts'; render(); }
}

const BLANK_TEMPLATE = 'None: I\'ll add my own exercises';
function adhocWorkout() {
  const ids = [...new Set((S.data.Workout_Templates || []).map(t => String(t.template_id)))];
  openForm({
    title: 'Unscheduled workout', saveLabel: 'Start',
    fields: [
      { key: 'title', label: 'Workout name', placeholder: 'e.g. Upper body', value: '' },
      { key: 'template_id', label: 'Start from a template', type: 'select', options: [BLANK_TEMPLATE, ...ids], value: BLANK_TEMPLATE }
    ],
    onSave: async v => {
      setTimeout(() => {
        if (v.template_id === BLANK_TEMPLATE) startBlankLogger(v.title || 'Workout', todayStr());
        else startLogger(v.template_id, v.title || v.template_id, '', todayStr());
      }, 0);
    }
  });
}
function startBlankLogger(title, date) {
  S.logger = { schedule_id: '', template_id: '', title, date: date || todayStr(), exercises: [] };
  saveDraft();
  S.view = 'logger'; render(); window.scrollTo(0, 0);
}

// ----- Adding your own exercises -----
function exerciseNamesHtml() {
  const names = new Map();
  (S.data.Exercise_Library || []).forEach(e => { if (e.name) names.set(String(e.name).trim().toLowerCase(), String(e.name).trim()); });
  liveSets().forEach(r => {
    const n = String(r.exercise_name || '').trim();
    if (n && !names.has(n.toLowerCase())) names.set(n.toLowerCase(), n);
  });
  return `<datalist id="exerciseNames">${[...names.values()].sort().map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;
}
/** Matches a typed name to your Exercise_Library (or past logs) so history and last-used weight line up. */
function resolveExercise(name) {
  const clean = String(name).trim(), lc = clean.toLowerCase();
  const lib = (S.data.Exercise_Library || []).find(e => String(e.name).trim().toLowerCase() === lc);
  if (lib) return { exercise_id: lib.exercise_id, name: String(lib.name).trim(), cue: lib.form_cue || '', video: lib.video_url || '' };
  const prev = liveSets().find(r => String(r.exercise_name).trim().toLowerCase() === lc);
  if (prev) return { exercise_id: prev.exercise_id, name: String(prev.exercise_name).trim(), cue: '', video: '' };
  return { exercise_id: 'custom-' + (lc.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'exercise'), name: clean, cue: '', video: '' };
}
function setCount(v) { return Math.min(20, Math.max(1, Math.round(num(v)) || 3)); }
function wireLastWeight() {
  const nameEl = $('#f_name'), wEl = $('#f_weight');
  if (!nameEl || !wEl) return;
  nameEl.addEventListener('change', () => {
    if (!nameEl.value.trim() || wEl.value) return;
    const w = lastWeight(resolveExercise(nameEl.value).exercise_id);
    if (!blank(w)) wEl.value = w;
  });
  nameEl.focus();
}
function addExerciseToLogger() {
  openForm({
    title: 'Add exercise', saveLabel: 'Add',
    extraHtml: exerciseNamesHtml() + '<p class="hint">Pick from your list or type any new exercise.</p>',
    fields: [
      { key: 'name', label: 'Exercise', list: 'exerciseNames', required: true, placeholder: 'e.g. Bench press' },
      [{ key: 'sets', label: 'Sets', type: 'number', value: 3 },
       { key: 'reps', label: 'Target reps', type: 'number', placeholder: 'e.g. 10' }],
      { key: 'weight', label: `Weight (${wtUnit()})`, type: 'number', placeholder: 'optional' }
    ],
    afterOpen: wireLastWeight,
    onSave: async v => {
      if (!v.name) throw new Error('Enter an exercise name');
      const ex = resolveExercise(v.name);
      const w = blank(v.weight) ? lastWeight(ex.exercise_id) : v.weight;
      const n = setCount(v.sets);
      S.logger.exercises.push({ ...ex,
        target: `${n} × ${v.reps || '?'}${blank(v.weight) ? '' : ' @ ' + v.weight + ' ' + wtUnit()}`,
        notes: '', repsHint: String(v.reps || ''),
        sets: Array.from({ length: n }, () => ({ reps: '', weight: w, rpe: '' })) });
      saveDraft();
      setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 50);
    }
  });
}
/** Adds an exercise to a workout you already saved (from "Recently logged"). */
function addExerciseToSession(id) {
  const sets = liveSets().filter(r => r.session_id === id);
  if (!sets.length) return;
  const first = sets[0];
  openForm({
    title: 'Add exercise to ' + first.workout_name, saveLabel: 'Add',
    extraHtml: exerciseNamesHtml() + `<p class="hint">${prettyDate(first.date)}. Adds this many sets, all with the same reps and weight. You can change single sets afterwards with Edit.</p>`,
    fields: [
      { key: 'name', label: 'Exercise', list: 'exerciseNames', required: true, placeholder: 'e.g. Bench press' },
      [{ key: 'sets', label: 'Sets', type: 'number', value: 3 },
       { key: 'reps', label: 'Reps', type: 'number', required: true }],
      [{ key: 'weight', label: `Weight (${wtUnit()})`, type: 'number' },
       { key: 'rpe', label: 'RPE', type: 'number', placeholder: 'optional' }]
    ],
    afterOpen: wireLastWeight,
    onSave: v => {
      if (!v.name) throw new Error('Enter an exercise name');
      if (blank(v.reps)) throw new Error('Enter reps');
      const ex = resolveExercise(v.name);
      const stamp = nowStamp();
      const startNo = sets.filter(s => String(s.exercise_id) === String(ex.exercise_id)).length;
      const rows = Array.from({ length: setCount(v.sets) }, (_, k) => ({
        entry_id: uid('s'), session_id: id, date: first.date, schedule_id: first.schedule_id,
        workout_name: first.workout_name, exercise_id: ex.exercise_id, exercise_name: ex.name, set_no: startNo + k + 1,
        reps: v.reps, weight: v.weight, rpe: v.rpe, notes: '', deleted: false, updated_at: stamp }));
      return Sheets.append('Workouts', rows);
    }
  });
}

function editSession(id) {
  const sets = liveSets().filter(r => r.session_id === id).sort((a, b) => a._row - b._row);
  if (!sets.length) return;
  const fields = [{ key: 'date', label: 'Date', type: 'date', value: sets[0].date }];
  sets.forEach(s => {
    fields.push({ type: 'heading', label: `${s.exercise_name}, set ${s.set_no}` });
    fields.push([{ key: 'reps__' + s.entry_id, label: 'Reps', type: 'number', value: s.reps },
                 { key: 'weight__' + s.entry_id, label: `Weight (${wtUnit()})`, type: 'number', value: s.weight }]);
    fields.push([{ key: 'rpe__' + s.entry_id, label: 'RPE', type: 'number', value: s.rpe },
                 { key: 'del__' + s.entry_id, label: 'Delete this set', type: 'checkbox', value: false }]);
  });
  openForm({
    title: sets[0].workout_name + ' · ' + prettyDate(sets[0].date), fields,
    extraHtml: `<button type="button" class="secondary full" data-action="session-add-ex" data-id="${esc(id)}" style="margin-bottom:8px">+ Add an exercise to this workout</button>`,
    onSave: v => {
      const stamp = nowStamp();
      return Sheets.updateRows('Workouts', sets.map(s => ({ ...s, date: v.date,
        reps: v['reps__' + s.entry_id], weight: v['weight__' + s.entry_id], rpe: v['rpe__' + s.entry_id],
        deleted: v['del__' + s.entry_id] === true, updated_at: stamp })));
    },
    onDelete: () => Sheets.updateRows('Workouts', sets.map(s => ({ ...s, deleted: true, updated_at: nowStamp() })))
  });
}

// ----- History & Sync -----
function viewHistory() {
  const du = distUnit();
  const tabs = `<div class="seg"><button data-action="hist" data-tab="activity" class="${S.histTab === 'activity' ? 'active' : ''}">Activity</button>
    <button data-action="hist" data-tab="workouts" class="${S.histTab === 'workouts' ? 'active' : ''}">Strength</button></div>`;
  if (S.histTab === 'workouts') {
    return tabs + `<div class="card"><ul class="list">${sessions().slice(0, 60).map(s => {
      const vol = s.sets.reduce((t, r) => t + num(r.reps) * num(r.weight), 0);
      return `<li data-action="edit-session" data-id="${esc(s.session_id)}"><div><div>${esc(s.name)}</div>
        <div class="sub">${prettyDate(s.date)} · ${s.sets.length} sets · ${fmt(vol)} ${esc(wtUnit())} volume</div></div><span class="muted">Edit</span></li>`;
    }).join('') || '<li class="muted" style="cursor:default">No sessions yet</li>'}</ul></div>`;
  }
  const rows = (S.data.Activity_Sync || []).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60);
  return tabs + `<button class="secondary full" data-action="edit-activity" data-date="">+ Add or fix a day</button>
  <div class="card" style="margin-top:12px"><ul class="list">${rows.map(r => `
    <li data-action="edit-activity" data-date="${r.date}"><div><div>${prettyDate(r.date)} ${isOverridden(r) ? '<span class="badge">edited</span>' : ''}</div>
      <div class="sub">${fmt(eff(r, 'active_kcal'))} kcal · ${fmt(eff(r, 'steps'))} steps · ${fmt(eff(r, 'distance'), 2)} ${esc(du)}${num(eff(r, 'run_distance')) ? ' · run ' + fmt(eff(r, 'run_distance'), 2) : ''}</div>
      ${eff(r, 'workout_types') ? `<div class="sub">${esc(eff(r, 'workout_types'))}</div>` : ''}</div><span class="muted">&rsaquo;</span></li>`).join('')
    || '<li class="muted" style="cursor:default">No synced days yet. Set up the iPhone Shortcut (build plan step 8).</li>'}</ul></div>`;
}

function editActivity(date) {
  const du = distUnit();
  const row = date ? activityRow(date) : null;
  const fields = [];
  if (!date) fields.push({ key: 'date', label: 'Date', type: 'date', value: todayStr(), required: true });
  ACTIVITY_METRICS.forEach(m => {
    const synced = row ? row[m.key] : '';
    fields.push({
      key: m.key + '_ovr', label: `${m.label}${m.unit === 'dist' ? ' (' + du + ')' : m.unit ? ' (' + m.unit + ')' : ''}`,
      type: m.type, value: row ? row[m.key + '_ovr'] : '', placeholder: blank(synced) ? '' : String(synced),
      note: blank(synced) ? 'Nothing synced. Your entry will be used.' : `Synced: ${synced}. Leave blank to use it.`
    });
  });
  fields.push({ key: 'notes', label: 'Notes', value: row ? row.notes : '' });
  openForm({
    title: date ? 'Activity · ' + prettyDate(date) : 'Add or fix a day', fields,
    extraHtml: '<p class="hint">Your numbers sit beside the synced ones, so a later sync never erases them.</p>',
    onSave: async v => {
      const d = date || v.date;
      const target = activityRow(d);
      const fieldsOut = { edited_at: nowStamp(), notes: v.notes };
      ACTIVITY_METRICS.forEach(m => { fieldsOut[m.key + '_ovr'] = v[m.key + '_ovr']; });
      if (target) return Sheets.updateCells('Activity_Sync', target._row, fieldsOut);
      return Sheets.append('Activity_Sync', [{ date: d, ...fieldsOut }]);
    }
  });
}

// ---------------- Events ----------------
document.addEventListener('click', e => {
  const nav = e.target.closest('.bottomnav button');
  if (nav) {
    S.view = nav.dataset.view;
    render(); window.scrollTo(0, 0); return;
  }
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  const a = el.dataset.action;
  if (a === 'day') { S.navDate = addDays(S.navDate, Number(el.dataset.delta)); render(); }
  else if (a === 'add-food') addFood();
  else if (a === 'edit-food') editFood(el.dataset.id);
  else if (a === 'targets') editTargets();
  else if (a === 'open-schedule') openSchedule(el.dataset.id);
  else if (a === 'resume') { S.view = 'logger'; render(); }
  else if (a === 'adhoc') adhocWorkout();
  else if (a === 'edit-session') editSession(el.dataset.id);
  else if (a === 'hist') { S.histTab = el.dataset.tab; render(); }
  else if (a === 'edit-activity') editActivity(el.dataset.date);
  else if (a === 'add-set') {
    const x = S.logger.exercises[Number(el.dataset.ex)];
    const prev = x.sets[x.sets.length - 1] || { weight: '' };
    x.sets.push({ reps: '', weight: prev.weight, rpe: '' }); saveDraft(); render();
  } else if (a === 'rm-set') {
    S.logger.exercises[Number(el.dataset.ex)].sets.splice(Number(el.dataset.set), 1); saveDraft(); render();
  } else if (a === 'add-exercise') addExerciseToLogger();
  else if (a === 'rm-exercise') {
    const i = Number(el.dataset.ex), x = S.logger.exercises[i];
    if (x.sets.some(s => !blank(s.reps)) && !confirm('Remove ' + x.name + ' and its sets?')) return;
    S.logger.exercises.splice(i, 1); saveDraft(); render();
  } else if (a === 'session-add-ex') {
    $('#modal').close(); addExerciseToSession(el.dataset.id);
  } else if (a === 'save-session') saveSession();
  else if (a === 'discard-session') {
    if (confirm('Discard this workout?')) { S.logger = null; saveDraft(); S.view = 'workouts'; render(); }
  }
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.f && S.logger) {
    S.logger.exercises[Number(t.dataset.ex)].sets[Number(t.dataset.set)][t.dataset.f] = t.value;
    saveDraft();
  }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.action === 'pick-date' && t.value) { S.navDate = t.value; render(); }
  if (t.dataset.action === 'logger-date' && t.value && S.logger) { S.logger.date = t.value; saveDraft(); }
});

// ---------------- Start-up ----------------
function showSignIn() {
  $('#signin').hidden = false;
  $('#view').innerHTML = '';
  $('#bottomnav').hidden = true;
  $('#refreshBtn').hidden = true;
  $('#signOutBtn').hidden = true;
  $('#configHint').hidden = !CONFIG.GOOGLE_CLIENT_ID.startsWith('PASTE');
}

async function start() {
  Auth.init();
  try { S.logger = JSON.parse(localStorage.getItem('hl_logger') || 'null'); } catch (e) { S.logger = null; }
  if (!Auth.isValid()) { showSignIn(); return; }
  $('#signin').hidden = true;
  $('#bottomnav').hidden = false;
  $('#refreshBtn').hidden = false;
  $('#signOutBtn').hidden = false;
  $('#view').innerHTML = '<div class="loading">Loading your Health_Log…</div>';
  const ok = await run(load);
  if (ok) render();
}

$('#signInBtn').addEventListener('click', () => Auth.signIn());
$('#signOutBtn').addEventListener('click', async () => { await Auth.signOut(); showSignIn(); });
$('#refreshBtn').addEventListener('click', async () => { if (await run(load, 'Up to date')) render(); });
// Re-read the sheet when you come back to the app (e.g. after the nightly sync).
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && Auth.isValid() && !$('#modal').open && S.view !== 'logger') {
    if (await run(load)) render();
  } else if (document.visibilityState === 'visible' && !Auth.isValid() && $('#signin').hidden) {
    showSignIn();
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
start();
