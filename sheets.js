// ------------------------------------------------------------------
// sheets.js — Google sign-in + Google Sheets API helpers.
// No libraries: sign-in uses Google's standard OAuth 2.0 redirect,
// which works reliably inside an iPhone home-screen app.
// ------------------------------------------------------------------

// Column order for each tab. Must match apps-script/Code.gs.
const HEADERS = {
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

// Turns a column number (1 = A) into its letter(s).
function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ---------------- Sign-in ----------------
const Auth = {
  KEY: 'hl_token',
  token: null,
  expiresAt: 0,

  redirectUri() {
    // e.g. https://yourname.github.io/health-log/  (must be listed in Cloud Console exactly)
    return location.origin + location.pathname.replace(/index\.html$/, '');
  },

  // Call once on page load. Picks up a token Google just sent back, or a saved one.
  init() {
    if (location.hash.includes('access_token=')) {
      const p = new URLSearchParams(location.hash.slice(1));
      const expected = sessionStorage.getItem('hl_state') || localStorage.getItem('hl_state');
      if (p.get('state') && p.get('state') === expected) {
        this.save(p.get('access_token'), Number(p.get('expires_in') || 3600));
      }
      history.replaceState(null, '', location.pathname + location.search);
    } else if (location.hash.includes('error=')) {
      history.replaceState(null, '', location.pathname + location.search);
    }
    if (!this.token) {
      try {
        const saved = JSON.parse(localStorage.getItem(this.KEY) || 'null');
        if (saved) { this.token = saved.token; this.expiresAt = saved.expiresAt; }
      } catch (e) { /* ignore */ }
    }
  },

  save(token, seconds) {
    this.token = token;
    this.expiresAt = Date.now() + seconds * 1000;
    localStorage.setItem(this.KEY, JSON.stringify({ token: this.token, expiresAt: this.expiresAt }));
  },

  isValid() { return !!this.token && Date.now() < this.expiresAt - 60 * 1000; },

  signIn() {
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem('hl_state', state);
    localStorage.setItem('hl_state', state); // iOS home-screen apps can drop sessionStorage
    const params = new URLSearchParams({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      redirect_uri: this.redirectUri(),
      response_type: 'token',
      scope: CONFIG.SCOPES,
      include_granted_scopes: 'true',
      state
    });
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
  },

  clear() {
    this.token = null; this.expiresAt = 0;
    localStorage.removeItem(this.KEY);
  },

  async signOut() {
    if (this.token) {
      try {
        await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(this.token),
          { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      } catch (e) { /* ignore */ }
    }
    this.clear();
  }
};

class AuthError extends Error {}

// ---------------- Sheets API ----------------
const Sheets = {
  base() { return 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(CONFIG.SPREADSHEET_ID); },

  async call(path, options = {}) {
    if (!Auth.isValid()) throw new AuthError('Please sign in again');
    const res = await fetch(this.base() + path, {
      ...options,
      headers: { Authorization: 'Bearer ' + Auth.token, 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    if (res.status === 401) { Auth.clear(); throw new AuthError('Your Google session expired'); }
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText;
      try { msg = (await res.json()).error.message || msg; } catch (e) { /* ignore */ }
      throw new Error('Google Sheets: ' + msg);
    }
    return res.json();
  },

  /** Reads whole tabs. Returns { TabName: [ {col: value, ..., _row: 2}, ... ] } */
  async readTabs(tabs) {
    const q = tabs.map(t => 'ranges=' + encodeURIComponent(t + '!A:' + colLetter(HEADERS[t].length))).join('&');
    const data = await this.call('/values:batchGet?' + q +
      '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING');
    const out = {};
    data.valueRanges.forEach((vr, i) => {
      const tab = tabs[i];
      const rows = vr.values || [];
      out[tab] = rows.slice(1).map((r, idx) => {
        const o = { _row: idx + 2 };
        HEADERS[tab].forEach((h, c) => { o[h] = r[c] === undefined ? '' : r[c]; });
        return o;
      }).filter(o => HEADERS[tab].some(h => o[h] !== ''));
    });
    return out;
  },

  /** Object -> row array in the tab's column order. */
  toRow(tab, obj) { return HEADERS[tab].map(h => (obj[h] === undefined || obj[h] === null) ? '' : obj[h]); },

  /** Adds rows at the bottom of a tab. */
  async append(tab, objects) {
    const range = encodeURIComponent(tab + '!A1');
    return this.call('/values/' + range + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS', {
      method: 'POST',
      body: JSON.stringify({ values: objects.map(o => this.toRow(tab, o)) })
    });
  },

  /** Overwrites existing rows. Each object must carry its _row number. */
  async updateRows(tab, objects) {
    const data = objects.map(o => ({
      range: tab + '!A' + o._row + ':' + colLetter(HEADERS[tab].length) + o._row,
      values: [this.toRow(tab, o)]
    }));
    return this.call('/values:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data })
    });
  },

  /** Writes specific columns of one row, e.g. updateCells('Activity_Sync', 5, {steps_ovr: 9000}) */
  async updateCells(tab, rowNum, fields) {
    const data = Object.keys(fields).map(k => {
      const c = HEADERS[tab].indexOf(k) + 1;
      if (c < 1) throw new Error('Unknown column ' + k);
      return { range: tab + '!' + colLetter(c) + rowNum, values: [[fields[k] === null ? '' : fields[k]]] };
    });
    return this.call('/values:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data })
    });
  }
};
