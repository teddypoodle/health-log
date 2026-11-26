/**
 * Health_Log — Google Apps Script backend
 * ---------------------------------------------------------------
 * Paste this whole file into Extensions > Apps Script of the
 * "Health_Log" Google Sheet. It does two jobs:
 *
 *   1. setup()  — run once. Creates every tab, header row, date
 *                 format and some sample rows, and makes a secret
 *                 key for the iPhone Shortcut.
 *   2. doPost() — the webhook the Apple Shortcut posts to each night.
 *                 It writes one row per day into Activity_Sync and
 *                 never touches your manual override columns.
 *
 * Nothing here is needed by the web app itself; the web app talks
 * to the sheet through the Google Sheets API.
 */

// ---------- Tab definitions (must match the web app's sheets.js) ----------
var TABS = {
  Goals: ['effective_date', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g',
          'sugar_g_max', 'sodium_mg_max', 'steps', 'active_kcal', 'weekly_run_distance', 'notes'],
  Nutrition: ['entry_id', 'date', 'time', 'meal', 'food', 'servings', 'calories', 'protein_g',
              'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg', 'notes', 'deleted', 'updated_at'],
  Workouts: ['entry_id', 'session_id', 'date', 'schedule_id', 'workout_name', 'exercise_id',
             'exercise_name', 'set_no', 'reps', 'weight', 'rpe', 'notes', 'deleted', 'updated_at'],
  Activity_Sync: ['date', 'active_kcal', 'steps', 'distance', 'run_distance', 'workout_types',
                  'workout_minutes', 'synced_at', 'active_kcal_ovr', 'steps_ovr', 'distance_ovr',
                  'run_distance_ovr', 'workout_types_ovr', 'edited_at', 'notes'],
  Workout_Schedule: ['schedule_id', 'date', 'type', 'title', 'template_id', 'planned_distance',
                     'details', 'status', 'completed_session_id'],
  Workout_Templates: ['template_id', 'order', 'exercise_id', 'target_sets', 'target_reps',
                      'target_weight', 'rest_sec', 'notes'],
  Exercise_Library: ['exercise_id', 'name', 'muscle_group', 'equipment', 'form_cue', 'video_url'],
  Settings: ['key', 'value', 'notes']
};

// Columns (1-based) that hold dates or times, per tab, so they display as yyyy-mm-dd.
var DATE_COLS = { Goals: [1], Nutrition: [2], Workouts: [3], Activity_Sync: [1], Workout_Schedule: [2] };
var TIME_COLS = { Nutrition: [3] };

// ---------- Menu ----------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Health Log')
    .addItem('Run first-time setup', 'setup')
    .addItem('Show Shortcut secret key', 'showSecret')
    .addItem('Make a new secret key', 'rotateSecret')
    .addToUi();
}

// ---------- One-time setup ----------
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(Session.getScriptTimeZone());

  Object.keys(TABS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = TABS[name];
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#e8eef7');
    sh.setFrozenRows(1);
    (DATE_COLS[name] || []).forEach(function (c) {
      sh.getRange(2, c, sh.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd');
    });
    (TIME_COLS[name] || []).forEach(function (c) {
      sh.getRange(2, c, sh.getMaxRows() - 1, 1).setNumberFormat('HH:mm');
    });
  });

  // Remove the default empty "Sheet1" if it is still there.
  var s1 = ss.getSheetByName('Sheet1');
  if (s1 && s1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s1);

  seedIfEmpty_(ss);
  var secret = getOrCreateSecret_();
  SpreadsheetApp.getUi().alert(
    'Health_Log is set up.\n\nShortcut secret key (also under Health Log > Show Shortcut secret key):\n\n' + secret +
    '\n\nSpreadsheet ID for the web app config.js:\n\n' + ss.getId());
}

function seedIfEmpty_(ss) {
  var today = new Date();
  function d(offset) {
    var x = new Date(today); x.setDate(x.getDate() + offset);
    return Utilities.formatDate(x, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  addRowsIfEmpty_(ss, 'Settings', [
    ['weight_unit', 'lb', 'Unit for all weights'],
    ['distance_unit', 'mi', 'Unit for all distances; match your Health app'],
    ['app_version', '1', 'Do not edit']
  ]);
  addRowsIfEmpty_(ss, 'Goals', [
    [d(0), 2200, 170, 220, 70, 30, 50, 2300, 10000, 600, 15, 'Starting targets: edit in the app']
  ]);
  addRowsIfEmpty_(ss, 'Exercise_Library', [
    ['SQ', 'Back Squat', 'Legs', 'Barbell', 'Brace your core, sit between your heels, knees track over toes, drive up through mid-foot.', ''],
    ['BP', 'Bench Press', 'Chest', 'Barbell', 'Shoulder blades pinned, bar to lower chest, feet driving into the floor.', ''],
    ['DL', 'Deadlift', 'Back', 'Barbell', 'Bar over mid-foot, flat back, push the floor away, lock out with glutes.', ''],
    ['OHP', 'Overhead Press', 'Shoulders', 'Barbell', 'Squeeze glutes, press straight up, move your head through at the top.', ''],
    ['ROW', 'Barbell Row', 'Back', 'Barbell', 'Hinge to about 45 degrees, pull to the belly button, no torso swing.', ''],
    ['PU', 'Pull-up', 'Back', 'Bodyweight', 'Start from a dead hang, chest to the bar, control the way down.', ''],
    ['RDL', 'Romanian Deadlift', 'Hamstrings', 'Barbell', 'Soft knees, push hips back until hamstrings stretch, bar stays close.', ''],
    ['LUN', 'Walking Lunge', 'Legs', 'Dumbbell', 'Long step, back knee kisses the floor, front shin stays vertical.', ''],
    ['PLK', 'Plank', 'Core', 'Bodyweight', 'Straight line from head to heels, ribs down, squeeze glutes. Log seconds as reps.', '']
  ]);
  addRowsIfEmpty_(ss, 'Workout_Templates', [
    ['UPPER_A', 1, 'BP', 3, '6-8', '', 120, ''],
    ['UPPER_A', 2, 'ROW', 3, '8-10', '', 90, ''],
    ['UPPER_A', 3, 'OHP', 3, '8', '', 90, ''],
    ['UPPER_A', 4, 'PU', 3, 'Max', '', 90, ''],
    ['LOWER_A', 1, 'SQ', 3, '5', '', 150, ''],
    ['LOWER_A', 2, 'RDL', 3, '8', '', 120, ''],
    ['LOWER_A', 3, 'LUN', 2, '10 each', '', 90, ''],
    ['LOWER_A', 4, 'PLK', 3, '45', '', 60, 'Seconds']
  ]);
  addRowsIfEmpty_(ss, 'Workout_Schedule', [
    ['SCH-0001', d(0), 'Strength', 'Upper A', 'UPPER_A', '', '', 'Planned', ''],
    ['SCH-0002', d(1), 'Run', 'Easy run', '', 3, 'Conversational pace', 'Planned', ''],
    ['SCH-0003', d(2), 'Strength', 'Lower A', 'LOWER_A', '', '', 'Planned', ''],
    ['SCH-0004', d(4), 'Run', 'Tempo run', '', 4, '1 mi warm-up, 2 mi tempo, 1 mi cool-down', 'Planned', ''],
    ['SCH-0005', d(5), 'Strength', 'Upper A', 'UPPER_A', '', '', 'Planned', '']
  ]);
}

function addRowsIfEmpty_(ss, tab, rows) {
  var sh = ss.getSheetByName(tab);
  if (sh.getLastRow() > 1 || !rows.length) return;
  sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

// ---------- Secret key for the Shortcut ----------
function getOrCreateSecret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('SHORTCUT_SECRET');
  if (!s) {
    s = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('SHORTCUT_SECRET', s);
  }
  return s;
}
function showSecret() {
  SpreadsheetApp.getUi().alert('Shortcut secret key:\n\n' + getOrCreateSecret_());
}
function rotateSecret() {
  PropertiesService.getScriptProperties().deleteProperty('SHORTCUT_SECRET');
  SpreadsheetApp.getUi().alert('New secret key (update your Shortcut):\n\n' + getOrCreateSecret_());
}

// ---------- Webhook ----------
/** Quick check you can open in a browser: should say "Health_Log webhook is running". */
function doGet() {
  return ContentService.createTextOutput('Health_Log webhook is running');
}

/**
 * Expected JSON body from the Shortcut:
 * {
 *   "secret": "...",
 *   "date": "2026-11-26",            // yyyy-MM-dd
 *   "active_kcal": 612.4,
 *   "steps": 11234,
 *   "distance": 5.8,
 *   "run_distance": 3.1,
 *   "workout_types": "Running, Traditional Strength Training",
 *   "workout_minutes": 74
 * }
 * Any field except secret and date may be missing; missing fields are left as they are.
 */
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!body.secret || body.secret !== getOrCreateSecret_()) return json_({ ok: false, error: 'bad secret' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ''))) return json_({ ok: false, error: 'date must be yyyy-MM-dd' });

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var row = upsertActivity_(body);
      return json_({ ok: true, date: body.date, row: row });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function upsertActivity_(b) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Activity_Sync');
  var last = sh.getLastRow();
  var rowNum = -1;
  if (last > 1) {
    var tzone = Session.getScriptTimeZone();
    var dates = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < dates.length; i++) {
      var v = dates[i][0];
      var key = v instanceof Date ? Utilities.formatDate(v, tzone, 'yyyy-MM-dd') : String(v).slice(0, 10);
      if (key === b.date) { rowNum = i + 2; break; }
    }
  }
  if (rowNum === -1) rowNum = last + 1;

  // Only columns A..H (Shortcut-owned). Overrides in I..O are never touched.
  var existing = sh.getRange(rowNum, 1, 1, 8).getValues()[0];
  var tz = Session.getScriptTimeZone();
  var out = [
    b.date,
    num_(b.active_kcal, existing[1], 0),
    num_(b.steps, existing[2], 0),
    num_(b.distance, existing[3], 2),
    num_(b.run_distance, existing[4], 2),
    b.workout_types != null ? String(b.workout_types) : existing[5],
    num_(b.workout_minutes, existing[6], 0),
    Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss')
  ];
  sh.getRange(rowNum, 1, 1, 8).setValues([out]);
  sh.getRange(rowNum, 1).setNumberFormat('yyyy-mm-dd');
  return rowNum;
}

/** Shortcuts sometimes sends numbers as text with commas or units; clean them up. */
function num_(v, fallback, decimals) {
  if (v === undefined || v === null || v === '') return fallback;
  var n = parseFloat(String(v).replace(/,/g, '').replace(/[^0-9.\-]/g, ''));
  if (isNaN(n)) return fallback;
  var f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
