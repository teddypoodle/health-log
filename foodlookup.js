// ------------------------------------------------------------------
// foodlookup.js — look up calories and macros while adding food.
// Sources (both free, called straight from the browser):
//   - USDA FoodData Central: everyday foods + US packaged foods (needs a free key in config.js)
//   - Open Food Facts: packaged foods and barcodes (no key)
// Every number it fills in stays editable in the form before you save.
// ------------------------------------------------------------------
const FoodLookup = (() => {
  const USDA = 'https://api.nal.usda.gov/fdc/v1';
  const OFF_PRODUCT = 'https://world.openfoodfacts.org/api/v2/product/';
  const OFF_SEARCH = 'https://search.openfoodfacts.org/search';
  const SCANNER_JS = 'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js';
  const KEYS = ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg'];
  // USDA nutrient ids -> our columns. Energy has three possible ids; first one present wins.
  const USDA_IDS = { protein_g: [1003], fat_g: [1004], carbs_g: [1005], fiber_g: [1079],
    sugar_g: [2000, 1063], sodium_mg: [1093], calories: [1008, 2047, 2048] };
  const OZ = 28.3495;

  let results = [];   // last search results
  let picked = null;  // { name, source, per_g: {key: value per gram}, units: [{label, grams}] }
  let scanner = null;
  let searchSeq = 0;

  const key = () => (window.CONFIG && CONFIG.USDA_API_KEY) || 'DEMO_KEY';
  const el = id => document.getElementById(id);
  const r1 = n => Math.round(n * 10) / 10;

  function html() {
    return `
    <div class="lookup">
      <div class="lookup-bar">
        <input id="lk_q" type="search" placeholder="Look up a food or type a barcode" autocomplete="off" enterkeyhint="search">
        <button type="button" class="secondary small" id="lk_go">Search</button>
        <button type="button" class="secondary small" id="lk_scan" aria-label="Scan barcode">&#128247; Scan</button>
      </div>
      <div id="lk_reader" class="lk-reader" hidden></div>
      <div id="lk_status" class="hint lk-status"></div>
      <ul id="lk_results" class="list lk-results"></ul>
      <div id="lk_amount" class="lk-amount" hidden>
        <div class="lk-picked" id="lk_picked"></div>
        <div class="fields-2">
          <div class="field"><label for="lk_qty">Amount</label><input id="lk_qty" type="number" inputmode="decimal" step="any" min="0"></div>
          <div class="field"><label for="lk_unit">Unit</label><select id="lk_unit"></select></div>
        </div>
        <span class="synced">Numbers below are filled in for this amount. You can still change any of them.</span>
      </div>
    </div>`;
  }

  function wire() {
    results = []; picked = null;
    const q = el('lk_q');
    q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); search(q.value); } });
    el('lk_go').onclick = () => search(q.value);
    el('lk_scan').onclick = () => (scanner ? stopScan() : startScan());
    el('lk_results').onclick = e => {
      const li = e.target.closest('li[data-i]');
      if (li) pick(results[Number(li.dataset.i)]);
    };
    el('lk_qty').addEventListener('input', apply);
    el('lk_unit').addEventListener('change', () => {
      const u = picked.units[Number(el('lk_unit').value)];
      el('lk_qty').value = u.grams === 1 ? 100 : u.grams === OZ ? 4 : 1;
      apply();
    });
    const modal = document.getElementById('modal');
    if (!modal._lookupHooked) { modal.addEventListener('close', stopScan); modal._lookupHooked = true; }
  }

  function status(msg, isErr) {
    const s = el('lk_status'); if (!s) return;
    s.textContent = msg || ''; s.classList.toggle('lk-err', !!isErr);
  }

  // ---------------- Search ----------------
  async function search(raw) {
    const q = String(raw || '').trim();
    if (!q) return;
    if (/^\d{8,14}$/.test(q)) return barcode(q);
    const seq = ++searchSeq;
    status('Searching…'); el('lk_results').innerHTML = ''; el('lk_amount').hidden = true;
    const [generic, branded, off] = await Promise.allSettled([
      usdaSearch(q, 'Foundation,SR Legacy,Survey (FNDDS)', 10),
      usdaSearch(q, 'Branded', 6),
      offSearch(q, 6)
    ]);
    if (seq !== searchSeq) return; // a newer search started
    results = [].concat(val(generic), val(branded), val(off));
    const usdaErr = [generic, branded].find(p => p.status === 'rejected');
    if (!results.length) {
      status(usdaErr ? usdaErr.reason.message : 'No matches. Try fewer or different words.', !!usdaErr);
    } else {
      status(usdaErr ? usdaErr.reason.message : 'Tap a match:', !!usdaErr);
    }
    renderResults();
  }
  const val = p => (p.status === 'fulfilled' ? p.value : []);

  function renderResults() {
    el('lk_results').innerHTML = results.map((r, i) => `
      <li data-i="${i}"><div><div>${esc(r.name)}</div>
        <div class="sub">${esc([r.brand, r.source].filter(Boolean).join(' · '))}</div></div>
        <span class="muted lk-kcal">${r.per_g && r.per_g.calories != null ? fmt(r.per_g.calories * 100) + ' kcal/100g' : ''}</span></li>`).join('');
  }

  async function usdaSearch(q, types, size) {
    const url = `${USDA}/foods/search?api_key=${encodeURIComponent(key())}&query=${encodeURIComponent(q)}`
      + `&pageSize=${size}&dataType=${encodeURIComponent(types)}`;
    const res = await fetch(url);
    if (res.status === 429 || res.status === 403) {
      throw new Error(key() === 'DEMO_KEY'
        ? 'USDA lookups are paused: the shared demo key hit its hourly limit. Add your own free key to fix this (packaged foods below still work).'
        : 'USDA lookups hit the hourly limit. Try again in a bit.');
    }
    if (!res.ok) throw new Error('USDA lookup failed (' + res.status + ').');
    const j = await res.json();
    return (j.foods || []).map(usdaItem);
  }

  function usdaItem(f) {
    const per_g = {};
    const byId = {};
    (f.foodNutrients || []).forEach(n => { if (n.value != null) byId[n.nutrientId] = n.value; });
    Object.entries(USDA_IDS).forEach(([k, ids]) => {
      const id = ids.find(i => byId[i] != null);
      if (id != null) per_g[k] = byId[id] / 100; // search results are per 100 g
    });
    const units = [];
    if (f.dataType === 'Branded' && f.servingSize && /^(g|grm|ml|mlt)$/i.test(f.servingSizeUnit || '')) {
      const hh = f.householdServingFullText ? titleCase(f.householdServingFullText) + ', ' : '';
      units.push({ label: `serving (${hh}${fmt(f.servingSize)} ${/^m/i.test(f.servingSizeUnit) ? 'ml' : 'g'})`, grams: f.servingSize });
    }
    (f.foodMeasures || []).forEach(m => {
      if (m.gramWeight && m.disseminationText && !/not specified/i.test(m.disseminationText)) {
        units.push({ label: `${m.disseminationText} (${fmt(m.gramWeight)} g)`, grams: m.gramWeight });
      }
    });
    const branded = f.dataType === 'Branded';
    return {
      name: branded ? titleCase(f.description) : f.description,
      brand: branded ? titleCase(f.brandName || f.brandOwner || '') : '',
      source: branded ? 'USDA packaged' : 'USDA',
      per_g, units, fdcId: f.fdcId, needsPortions: !branded && !units.length
    };
  }

  async function offSearch(q, size) {
    const url = `${OFF_SEARCH}?q=${encodeURIComponent(q)}&page_size=${size}&fields=code,product_name,brands`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const j = await res.json();
    return (j.hits || []).filter(p => p.product_name && p.code).map(p => ({
      name: p.product_name,
      brand: (Array.isArray(p.brands) ? p.brands : String(p.brands || '').split(','))
        .map(b => String(b).replace(/^xx:/, '').trim()).filter(Boolean).slice(0, 1).map(titleCase).join(''),
      source: 'Open Food Facts', code: p.code, per_g: null, units: []
    }));
  }

  // ---------------- Pick a result ----------------
  async function pick(r) {
    if (!r) return;
    try {
      if (r.code && !r.per_g) { // Open Food Facts search hit: fetch the full product for its numbers
        status('Getting nutrition facts…');
        const full = await offProduct(r.code);
        if (!full) { status('Open Food Facts has no nutrition facts for that one. Try another match.', true); return; }
        r = full;
      } else if (r.needsPortions && r.fdcId) {
        status('Getting serving sizes…');
        r.units = await usdaPortions(r.fdcId).catch(() => []);
        r.needsPortions = false;
      }
    } catch (e) { status('Lookup failed: ' + e.message, true); return; }
    picked = { ...r, units: [...r.units, { label: 'grams', grams: 1 }, { label: 'ounces', grams: OZ }] };
    el('lk_unit').innerHTML = picked.units.map((u, i) => `<option value="${i}">${esc(u.label)}</option>`).join('');
    el('lk_unit').value = '0';
    el('lk_qty').value = picked.units[0].grams === 1 ? 100 : 1;
    el('lk_picked').innerHTML = `<strong>${esc(r.name)}</strong><div class="sub muted">${esc([r.brand, r.source].filter(Boolean).join(' · '))}</div>`;
    el('lk_results').innerHTML = '';
    el('lk_amount').hidden = false;
    status('');
    const food = el('f_food'); if (food) food.value = r.brand && !r.name.toLowerCase().includes(r.brand.toLowerCase()) ? `${r.name} (${r.brand})` : r.name;
    apply();
  }

  async function usdaPortions(fdcId) {
    const res = await fetch(`${USDA}/food/${fdcId}?api_key=${encodeURIComponent(key())}&format=full`);
    if (!res.ok) return [];
    const j = await res.json();
    return (j.foodPortions || []).filter(p => p.gramWeight).map(p => {
      const amt = p.amount && p.amount !== 1 ? fmt(p.amount, 2) + ' ' : '1 ';
      const what = p.portionDescription && !/not specified/i.test(p.portionDescription) ? p.portionDescription
        : [p.measureUnit && p.measureUnit.name !== 'undetermined' ? p.measureUnit.name : '', p.modifier].filter(Boolean).join(' ');
      return what ? { label: `${/^\d/.test(what) ? '' : amt}${what} (${fmt(p.gramWeight, 1)} g)`, grams: p.gramWeight } : null;
    }).filter(Boolean).slice(0, 8);
  }

  async function offProduct(code) {
    const res = await fetch(`${OFF_PRODUCT}${encodeURIComponent(code)}.json?fields=code,product_name,brands,serving_size,serving_quantity,nutriments`);
    if (!res.ok) return null;
    const j = await res.json();
    const p = j.product;
    if (!p || !p.nutriments) return null;
    const n = p.nutriments;
    const g = k => (n[k + '_100g'] != null && n[k + '_100g'] !== '' ? Number(n[k + '_100g']) / 100 : undefined);
    let kcal = g('energy-kcal');
    if (kcal === undefined && g('energy') !== undefined) kcal = g('energy') / 4.184; // energy is kJ
    const per_g = { calories: kcal, protein_g: g('proteins'), carbs_g: g('carbohydrates'), fat_g: g('fat'),
      fiber_g: g('fiber'), sugar_g: g('sugars'), sodium_mg: g('sodium') !== undefined ? g('sodium') * 1000 : undefined };
    Object.keys(per_g).forEach(k => per_g[k] === undefined && delete per_g[k]);
    if (per_g.calories === undefined && per_g.protein_g === undefined) return null;
    const units = [];
    const sq = Number(p.serving_quantity);
    if (sq > 0) units.push({ label: `serving (${p.serving_size || fmt(sq) + ' g'})`, grams: sq });
    return {
      name: p.product_name || 'Product ' + code,
      brand: String(p.brands || '').split(',')[0].trim(),
      source: 'Open Food Facts', code, per_g, units
    };
  }

  // ---------------- Fill the form ----------------
  function apply() {
    if (!picked) return;
    const u = picked.units[Number(el('lk_unit').value)] || picked.units[0];
    const qty = num(el('lk_qty').value);
    const grams = qty * u.grams;
    KEYS.forEach(k => {
      const f = el('f_' + k); if (!f) return;
      const v = picked.per_g[k];
      f.value = v === undefined ? '' : (k === 'calories' || k === 'sodium_mg') ? Math.round(v * grams) : r1(v * grams);
    });
    const isPortion = u.grams !== 1 && u.grams !== OZ;
    const sv = el('f_servings'); if (sv) sv.value = isPortion ? qty : 1;
    const notes = el('f_notes');
    if (notes && (!notes.value || notes.dataset.auto === notes.value)) {
      const amount = isPortion ? `${fmt(qty, 2)} × ${u.label}` : `${fmt(qty, 1)} ${u.label === 'grams' ? 'g' : 'oz'}`;
      notes.value = notes.dataset.auto = `${amount} · ${picked.source}`;
    }
  }

  // ---------------- Barcodes ----------------
  async function barcode(code) {
    stopScan();
    el('lk_q').value = code;
    el('lk_results').innerHTML = ''; el('lk_amount').hidden = true;
    status('Looking up barcode ' + code + '…');
    try {
      let r = await offProduct(code);
      if (!r) { // fall back to USDA's packaged foods, which list UPCs
        const hits = await usdaSearch(code, 'Branded', 3).catch(() => []);
        r = hits.find(h => h.per_g && h.per_g.calories != null) || null;
      }
      if (!r) { status('No product found for barcode ' + code + '. Try searching by name.', true); return; }
      pick(r);
    } catch (e) { status('Barcode lookup failed: ' + e.message, true); }
  }

  function loadScript(src) {
    return new Promise((ok, bad) => {
      if (window.Html5Qrcode) return ok();
      const s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = () => bad(new Error('Could not load the scanner. Check your connection.'));
      document.head.appendChild(s);
    });
  }

  async function startScan() {
    const box = el('lk_reader');
    try {
      status('Starting camera…');
      await loadScript(SCANNER_JS);
      const F = Html5QrcodeSupportedFormats;
      box.hidden = false;
      scanner = new Html5Qrcode('lk_reader', {
        formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E],
        experimentalFeatures: { useBarCodeDetectorIfSupported: true }, verbose: false
      });
      el('lk_scan').textContent = 'Stop';
      await scanner.start({ facingMode: 'environment' },
        { fps: 10, qrbox: (w, h) => ({ width: Math.min(w * 0.9, 320), height: Math.min(h * 0.5, 140) }) },
        text => barcode(text.replace(/\D/g, '')), () => {});
      status('Point the camera at the barcode.');
    } catch (e) {
      await stopScan();
      const msg = String((e && e.message) || e);
      status(/permission|notallowed/i.test(msg)
        ? 'Camera access was blocked. Allow the camera for this site in Settings, or type the barcode number.'
        : 'Could not start the camera: ' + msg, true);
    }
  }

  async function stopScan() {
    const s = scanner; scanner = null;
    const btn = el('lk_scan'); if (btn) btn.innerHTML = '&#128247; Scan';
    const box = el('lk_reader'); if (box) box.hidden = true;
    if (s) { try { await s.stop(); } catch (e) { /* already stopped */ } try { s.clear(); } catch (e) { /* ignore */ } }
  }

  function titleCase(s) {
    s = String(s || '');
    if (s !== s.toUpperCase()) return s; // only fix ALL-CAPS names
    return s.toLowerCase().replace(/(^|[\s,(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }

  return { html, wire, stopScan };
})();
