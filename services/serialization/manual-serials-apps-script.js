/**
 * Manual document numbering — Google Apps Script
 * ──────────────────────────────────────────────
 * Puts the next delivery-challan (DC-…) or interstore-sale (AURA-…) number into a hand-filled form
 * in Google Sheets, drawn from the SAME counter the middleware uses.
 *
 * ONE SPREADSHEET = ONE ORIGINATING STORE
 *   The series belongs to the store the document leaves FROM, so the store code is hard-coded once
 *   at the top of this file and every tab in the spreadsheet inherits it. The KA→MH book and the
 *   MH→KA book are separate spreadsheets with separate copies of this script; the only difference
 *   between the two copies is the two lines under CONFIGURATION.
 *
 *   Each tab within the spreadsheet says which SERIES it raises — delivery challan or interstore
 *   sale — because those are two different books out of the same store.
 *
 *     Spreadsheet "KA → MH"            STORE_CODE = 'KA-HSR'
 *       tab "Delivery Challan"   →   delivery_challan   →   DC-KAHSR-0007
 *       tab "Interstore Sale"    →   b2b                →   AURA-KAHSR-0003
 *
 *     Spreadsheet "MH → KA"            STORE_CODE = 'MH-HQ'
 *       tab "Delivery Challan"   →   delivery_challan   →   DC-MHHQ-0004
 *       tab "Interstore Sale"    →   b2b                →   AURA-MHHQ-0002
 *
 *   Any other KA-origin spreadsheet would draw from the same KA-HSR counters, which is correct —
 *   one store, one challan book, however many forms feed it.
 *
 * WHY IT ASKS THE SERVER AT ALL
 *   A challan written at the counter and a challan raised in Shopify are the same series. When a
 *   sheet keeps its own count, the two drift the moment anyone is busy, and the duplicate only
 *   surfaces when someone reads two printed documents side by side. So the sheet never computes a
 *   number: it asks the middleware, and that counter is the only thing that counts.
 *
 * THE TWO STEPS, AND WHY THEY ARE SEPARATE
 *   Refresh  → GET /api/serial/peek         shows what the next number WOULD be. Consumes nothing.
 *   Mint     → POST /api/serial/manual-mint draws it for real: the counter moves and a ledger row
 *                                           is written, so no other document can take it.
 *
 *   A preview is advisory. Two staff can be looking at the same "next" number at once; whoever
 *   mints first gets it, and the other is shown the number they actually got. The cell always ends
 *   up holding what the server returned, never what the preview promised — the only arrangement
 *   that cannot produce a duplicate.
 *
 * SETUP (once per spreadsheet)
 *   1. Set STORE_CODE, DEST_CODE and TABS below for this book.
 *   2. Extensions → Apps Script → paste this file → Save. Reload the sheet.
 *   3. "🔢 Serial → Set the API secret" — paste SHEET_API_SECRET (the value set as a Fly secret on
 *      the middleware). Stored in Script Properties, never in a cell: a cell travels with every
 *      copy, export and screenshot of the sheet.
 *   4. "🔢 Serial → Refresh on every open" once. Optional — refreshNextNumber can also be run from
 *      the menu or wired to an in-sheet button (Insert → Drawing → right-click → Assign script →
 *      refreshNextNumber). It only ever previews; it can never mint.
 *   5. "🔢 Serial → Diagnose" and check the store code and series it reports for each tab.
 */

// ═════════════════════════════════════════════════════════════════════════════
// CONFIGURATION — the only part that differs between the two directions
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The ORIGINATING store: the one whose book these numbers come out of, and the one whose code is
 * printed in the serial (KA-HSR → DC-KAHSR-0007). Hard-coded per spreadsheet on purpose — it is a
 * property of the book, not of a tab, and not something a staff member should be able to retype.
 *
 * KA-HSR (Bengaluru HSR) or MH-HQ (Mumbai HQ).
 */
var STORE_CODE = 'KA-HSR';

/**
 * The destination store for this book. Recorded on the ledger row so the row reads as a movement;
 * it is NOT printed in the number, because the challan series belongs to the origin alone.
 */
var DEST_CODE = 'MH-HQ';

/**
 * Which series each tab raises, and where the number prints.
 *
 *   docType     'delivery_challan' (DC-…) or 'b2b' (AURA-…)
 *   label       the printed caption next to the number field, e.g. "Delivery Challan no."
 *   labelDir    'right' or 'below' — where the number sits relative to that caption
 *   numberCell  fallback cell, used only when the caption cannot be found on the tab
 *   partyCell   optional; a cell whose text is recorded against the number on the ledger
 *
 * The number field is located by its CAPTION rather than by a fixed cell reference, because
 * inserting one row at the top of a form silently moves every cell below it. That is exactly what
 * went wrong on the challan tab: the number was written to B3, which had become part of a merged
 * banner, and a merged block only ever displays its top-left cell — so the value was stored, the
 * refresh reported success, and the form stayed blank. Anchoring on the caption also means the same
 * TABS block serves both spreadsheets even when their rows do not line up.
 *
 * Tab names are matched ignoring case, spaces and any trailing "(…)" — so "Delivery Challan (KA-MH)"
 * and "Delivery Challan (MH-KA)" both match the key 'Delivery Challan', and the SAME TABS block
 * works in both spreadsheets. "Copy of Delivery Challan (KA-MH)" does NOT match, which is what keeps
 * a backup tab out of the numbering.
 *
 * Only tabs listed here are refreshed automatically. A tab that is not listed still works from the
 * menu via keyword matching on its name, and the confirmation dialog always names the series before
 * anything is drawn — so a wrong guess is visible before it costs a number.
 */
var TABS = {
  'Delivery Challan': {
    docType: 'delivery_challan',
    label: 'Delivery Challan no.', labelDir: 'right',   // the number prints to the RIGHT of this caption
    numberCell: 'B4', partyCell: ''                     // used only if the caption is not found
  },
  'Inter Store Sales': {
    docType: 'b2b',
    label: 'Invoice Number', labelDir: 'below',         // the number prints BELOW this caption
    numberCell: 'F3', partyCell: ''
  }
};

/** Where the middleware lives. No trailing slash. */
var MIDDLEWARE_URL = 'https://timanti-middleware.fly.dev';

/** Fallback when a tab is not listed in TABS. First keyword found in the tab name wins. */
var TAB_KEYWORDS = [
  { match: 'challan',  docType: 'delivery_challan' },
  { match: 'dc',       docType: 'delivery_challan' },
  { match: 'sale',     docType: 'b2b' },
  { match: 'invoice',  docType: 'b2b' },
  { match: 'transfer', docType: 'b2b' },
  { match: 'aura',     docType: 'b2b' }
];

/**
 * Tab names carry a direction suffix — "Delivery Challan (KA-MH)" — so an exact match would force a
 * different TABS block per spreadsheet. Stripping "(…)" lets one block serve both directions.
 * "Copy of Delivery Challan (KA-MH)" survives as "copy of delivery challan" and so stays unmatched.
 */
function normalizeTabName_(name) {
  return String(name || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ═════════════════════════════════════════════════════════════════════════════
// Everything below is the same in both copies
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Bumped on every change to this file, and printed by Diagnose.
 *
 * Exists because a paste that did not save — or an old Code.gs left sitting beside a new file, whose
 * duplicate declarations quietly win — is indistinguishable from a bug in the script. If Diagnose
 * does not show the version you pasted, the code you are reading is not the code that is running.
 */
var SCRIPT_VERSION = '2026-09-16.3';

/** Script Property holding the middleware secret. Never put this in a cell. */
var SECRET_PROP = 'SHEET_API_SECRET';

/** The series this script is allowed to number. The server enforces the same list. */
var DOC_TYPES = {
  delivery_challan: { label: 'Delivery Challan',  example: 'DC-KAHSR-0001' },
  b2b:              { label: 'Interstore Sale',   example: 'AURA-KAHSR-0001' }
};

var TZ = 'Asia/Kolkata';

// ─────────────────────────────────────────────────────────────────────────────
// Menu and triggers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple onOpen. This one CANNOT call the middleware — Google runs simple triggers without
 * authorization, so UrlFetchApp is unavailable here. All it can do is build the menu and mark an
 * unrefreshed preview as stale. The on-open refresh is the installable trigger below, and
 * refreshNextNumber is always available from the menu or a button regardless.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🔢 Serial')
    .addItem('Refresh next number', 'refreshNextNumber')
    .addItem('Mint this number (lock it in)', 'mintThisNumber')
    .addSeparator()
    .addItem('Start a new document', 'startNewDocument')
    .addItem('Void this number', 'voidThisNumber')
    .addSeparator()
    .addItem('Set the API secret', 'setApiSecret')
    .addItem('Refresh on every open', 'installOpenRefresh')
    .addItem('Stop refreshing on open', 'removeOpenRefresh')
    .addItem('Diagnose', 'diagnose')
    .addToUi();

  try { markStaleIfPreview_(); } catch (e) { /* not set up yet — nothing to mark */ }
}

/**
 * Installable open trigger: this one IS authorized, so it can reach the middleware. Installed once
 * by any editor; it then runs for everyone who opens the file, as the person who installed it.
 */
function installOpenRefresh() {
  var ss = SpreadsheetApp.getActive();
  removeOpenRefresh();
  ScriptApp.newTrigger('refreshOnOpen').forSpreadsheet(ss).onOpen().create();
  SpreadsheetApp.getUi().alert(
    'Done. The next number will refresh whenever anyone opens this sheet.\n\n' +
    'A document that has already been minted is never overwritten by a refresh.');
}

function removeOpenRefresh() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'refreshOnOpen') ScriptApp.deleteTrigger(triggers[i]);
  }
}

/** Trigger handler. Silent: nobody wants a dialog every time they open the file. */
function refreshOnOpen() {
  try {
    refreshAllTabs_();   // each tab flags its own cell on failure
  } catch (err) {
    try { flagCell_(null, 'Could not reach the server — ' + err.message); } catch (e) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The four things staff actually do
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Menu / button: pull the current next-number from the counter and show it, greyed out.
 *
 * Previews only. There is no path from this function to a mint, which is why it is safe to wire to
 * a button anyone can press.
 */
function refreshNextNumber() {
  var ui = SpreadsheetApp.getUi();
  try {
    var r = refreshAllTabs_();
    var lines = [];
    if (r.done.length)    lines.push('Updated:\n  ' + r.done.join('\n  '));
    if (r.skipped.length) lines.push('Left alone (already minted — run "Start a new document" first):\n  ' + r.skipped.join('\n  '));
    if (r.failed.length)  lines.push('Failed:\n  ' + r.failed.join('\n  '));
    if (!lines.length) {
      lines.push('No numbering tabs found.\n\nTab names are matched against the TABS list at the top ' +
                 'of the script, ignoring anything in brackets.');
    }
    ui.alert('Next numbers', lines.join('\n\n'), ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Could not refresh: ' + err.message);
  }
}

/**
 * Menu: draw the number for real.
 *
 * The order of operations here is the safety property, not an implementation detail. The
 * idempotency reference is written to Document Properties BEFORE the request goes out, so if the
 * request times out — the number possibly drawn, the answer possibly lost — pressing Mint again
 * sends the SAME reference and the server hands back the SAME number instead of drawing a second.
 */
function mintThisNumber() {
  var ui = SpreadsheetApp.getUi();
  var cfg, sheet, state;
  try {
    cfg = config_();
    sheet = SpreadsheetApp.getActiveSheet();
    state = readState_(sheet);
  } catch (err) {
    ui.alert('Setup incomplete: ' + err.message);
    return;
  }

  if (state.phase === 'minted') {
    ui.alert('This document already holds ' + state.serial_code + '.\n\n' +
             'Run "Start a new document" first, or "Void this number" if the form was spoiled.');
    return;
  }

  var series = DOC_TYPES[cfg.docType].label;
  var answer = ui.alert(
    'Mint a ' + series + ' number?',
    'Series:  ' + series + '  (' + cfg.docType + ')\n' +
    'Book:    ' + cfg.storeCode + ' → ' + cfg.destCode + '\n' +
    'Tab:     ' + sheet.getName() + '\n\n' +
    'This takes the next number out of the ' + cfg.storeCode + ' ' + series + ' book and records it ' +
    'as used. It will no longer be available to any other document. Only do this once the form is ' +
    'being filled in for real.',
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;

  // One mint at a time per spreadsheet. Two staff on the same file pressing Mint together would
  // otherwise both pass the "already minted?" check above and draw two numbers for one form.
  var lock = LockService.getDocumentLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    ui.alert('Someone else is minting a number in this sheet right now. Try again in a moment.');
    return;
  }

  try {
    state = readState_(sheet); // re-read under the lock

    // Reuse a reference left behind by an attempt that never came back; only make a new one for a
    // genuinely new document.
    var reference = state.reference || Utilities.getUuid();
    writeState_(sheet, { phase: 'minting', reference: reference });

    var body = {
      docType:      cfg.docType,
      storeCode:    cfg.storeCode,
      deliveryCode: cfg.destCode,
      reference:    reference,
      label:        buildLabel_(sheet, cfg)
    };

    var res = api_(cfg, 'POST', '/api/serial/manual-mint', body);

    writeState_(sheet, {
      phase:       'minted',
      reference:   reference,
      serial_code: res.serial_code,
      serial_no:   res.serial_no,
      minted_at:   new Date().toISOString()
    });

    // Print what the SERVER returned. If someone else took the previewed number in the meantime,
    // this is where the sheet finds out, and it prints the real one.
    var cell = numberCell_(sheet, cfg);
    cell.setValue(res.serial_code);
    cell.setFontColor('#000000').setFontStyle('normal').setFontWeight('bold');
    cell.setNote('Minted ' + stamp_() + '\n' + series + ' · ' + cfg.storeCode + ' → ' + cfg.destCode +
                 '\nRecorded on the middleware ledger. Reference ' + reference);

    ui.alert(res.already_held
      ? 'This document already held ' + res.serial_code + ' — returned unchanged, no second number drawn.'
      : series + ' number ' + res.serial_code + ' is yours.\n\nIt is recorded, and no other document can take it.');
  } catch (err) {
    // The reference stays in Document Properties with phase 'minting' — pressing Mint again is safe
    // and will return the same number if one was in fact drawn.
    ui.alert('Mint failed: ' + err.message +
             '\n\nIf the network dropped, a number may already have been drawn for this form. ' +
             'Press "Mint this number" again — it will return the same number rather than a new one.');
  } finally {
    lock.releaseLock();
  }
}

/** Menu: clear the form's number so the tab can be used for the next document. */
function startNewDocument() {
  var ui = SpreadsheetApp.getUi();
  var cfg, sheet, state;
  try {
    cfg = config_();
    sheet = SpreadsheetApp.getActiveSheet();
    state = readState_(sheet);
  } catch (err) {
    ui.alert('Setup incomplete: ' + err.message);
    return;
  }

  if (state.phase === 'minting' && state.reference) {
    var go = ui.alert(
      'A number may already be drawn',
      'The last mint from this tab did not confirm. Starting a new document abandons that attempt, ' +
      'and if a number WAS drawn it will sit in the ledger with no form against it.\n\n' +
      'Press "Mint this number" first to find out which number you hold. Start a new document anyway?',
      ui.ButtonSet.YES_NO);
    if (go !== ui.Button.YES) return;
  }

  // The minted number is remembered so "Void this number" still works after the form is cleared.
  writeState_(sheet, state.serial_code ? { phase: 'new', last_serial_code: state.serial_code } : { phase: 'new' });

  var cell = numberCell_(sheet, cfg);
  cell.clearNote();
  cell.setFontWeight('normal');
  try { refresh_(); } catch (e) { cell.setValue(''); }
}

/**
 * Menu: retire a number that was drawn but never used on a real document.
 *
 * The number is NOT returned to the counter. A cancelled serial stays cancelled: the drift check
 * counts it as accounted for, so the series shows a gap WITH a reason. Reissuing a printed number
 * to a different document is the thing that cannot be explained afterwards.
 */
function voidThisNumber() {
  var ui = SpreadsheetApp.getUi();
  var cfg, sheet, state;
  try {
    cfg = config_();
    sheet = SpreadsheetApp.getActiveSheet();
    state = readState_(sheet);
  } catch (err) {
    ui.alert('Setup incomplete: ' + err.message);
    return;
  }

  var body = { docType: cfg.docType };
  var what;

  if (state.phase === 'minted' && state.reference) {
    body.reference = state.reference;
    what = state.serial_code;
  } else {
    var prompt = ui.prompt('Void a number',
      'Type the number to void exactly as printed (e.g. ' + DOC_TYPES[cfg.docType].example + ').' +
      (state.last_serial_code ? '\n\nLast minted from this tab: ' + state.last_serial_code : ''),
      ui.ButtonSet.OK_CANCEL);
    if (prompt.getSelectedButton() !== ui.Button.OK) return;
    what = String(prompt.getResponseText() || '').trim().toUpperCase();
    if (!what) return;
    body.serialCode = what;
  }

  var confirm = ui.alert('Void ' + what + '?',
    'The number stays used and is marked cancelled. It will never be issued again, and the series ' +
    'will show it as a voided document.\n\nVoid it?', ui.ButtonSet.YES_NO);
  if (confirm !== ui.Button.YES) return;

  try {
    var res = api_(cfg, 'POST', '/api/serial/manual-void', body);
    if (state.phase === 'minted') {
      writeState_(sheet, { phase: 'new', last_serial_code: res.serial_code });
      var cell = numberCell_(sheet, cfg);
      cell.setValue('');
      cell.setNote('VOIDED ' + res.serial_code + ' on ' + stamp_());
      cell.setFontWeight('normal');
    }
    ui.alert(res.already_cancelled
      ? res.serial_code + ' was already voided.'
      : res.serial_code + ' is voided. It will not be issued again.');
  } catch (err) {
    ui.alert('Void failed: ' + err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull the counter and show the next number, unless this tab already holds a minted one.
 *
 * That exception is the important half. A refresh runs on every open, and a form that has been
 * minted but not yet printed must never have its number replaced by "the next one" — that would
 * silently hand the same number to two documents. Checked before the network call, not after.
 */
function refresh_(sheet) {
  sheet = sheet || SpreadsheetApp.getActiveSheet();
  var cfg = config_(sheet);
  var state = readState_(sheet);

  if (state.phase === 'minted') {
    return { skipped: true, serial_code: state.serial_code };
  }

  // The lookup is per store code AND per series — the two tabs in this spreadsheet read two
  // different counters out of the same store.
  var q = '?docType=' + encodeURIComponent(cfg.docType) + '&state=' + encodeURIComponent(cfg.storeCode);
  var res = api_(cfg, 'GET', '/api/serial/peek' + q, null);

  var cell = numberCell_(sheet, cfg);
  cell.setValue(res.next_code);
  cell.setFontColor('#999999').setFontStyle('italic').setFontWeight('normal');
  cell.setNote('PREVIEW — not yours yet.\n' +
               'Next in the ' + cfg.storeCode + ' ' + DOC_TYPES[cfg.docType].label + ' book as of ' + stamp_() + '.\n' +
               'Someone else can still take it. Run "Mint this number" to claim it.');

  if (state.phase === 'minting' && state.reference) {
    cell.setNote(cell.getNote() + '\n\n⚠ A previous mint from this tab never confirmed. ' +
                 'Press "Mint this number" to find out whether a number was already drawn.');
  }
  return { skipped: false, next_code: res.next_code, tab: sheet.getName() };
}

/**
 * Refresh EVERY tab listed in TABS, not just the one that happens to be in front.
 *
 * getActiveSheet() returns a single tab, so an open-trigger that used it left the other form stale —
 * which is exactly how the challan tab sat empty while the sales tab looked fine. A spreadsheet
 * holding two forms has to refresh both or neither.
 *
 * Only listed tabs are swept. A keyword-matched tab is still usable from the menu, but nothing
 * writes into a tab automatically unless it was named on purpose.
 */
function refreshAllTabs_() {
  var ss = SpreadsheetApp.getActive();
  var sheets = ss.getSheets();
  var done = [], skipped = [], failed = [];

  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    var wanted = normalizeTabName_(sheet.getName());
    var listed = false;
    for (var key in TABS) {
      if (TABS.hasOwnProperty(key) && normalizeTabName_(key) === wanted) { listed = true; break; }
    }
    if (!listed) continue;

    try {
      var r = refresh_(sheet);
      if (r.skipped) skipped.push(sheet.getName() + ' holds ' + r.serial_code);
      else done.push(sheet.getName() + ' → ' + r.next_code);
    } catch (err) {
      // Mark THIS tab, not whichever one happens to be in front, so a stale number never survives
      // a failed refresh by looking current.
      try { flagCell_(sheet, err.message); } catch (e) {}
      failed.push(sheet.getName() + ': ' + err.message);
    }
  }
  return { done: done, skipped: skipped, failed: failed };
}

/** Simple-trigger fallback: say the preview is unrefreshed, so nobody trusts a number from last week. */
function markStaleIfPreview_() {
  var cfg = config_();
  var sheet = SpreadsheetApp.getActiveSheet();
  if (readState_(sheet).phase === 'minted') return;
  var cell = numberCell_(sheet, cfg);
  if (!String(cell.getValue() || '').trim()) return;
  cell.setNote('PREVIEW, not refreshed yet. Run "🔢 Serial → Refresh next number" ' +
               '(or install "Refresh on every open") before trusting this.');
}

function flagCell_(sheet, message) {
  sheet = sheet || SpreadsheetApp.getActiveSheet();
  var cfg = config_(sheet);
  if (readState_(sheet).phase === 'minted') return;
  var cell = numberCell_(sheet, cfg);
  cell.setValue('');
  cell.setNote(message + '\n\nRun "🔢 Serial → Refresh next number" once the connection is back.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Store code and destination come from the constants at the top — one book per spreadsheet.
 * The series comes from the active tab.
 */
function config_(sheet) {
  var storeCode = String(STORE_CODE || '').trim().toUpperCase();
  var destCode  = String(DEST_CODE  || '').trim().toUpperCase();
  if (!storeCode) throw new Error('STORE_CODE is blank at the top of the script');

  sheet = sheet || SpreadsheetApp.getActiveSheet();
  var tab = resolveTab_(sheet.getName());

  var secret = PropertiesService.getScriptProperties().getProperty(SECRET_PROP);
  if (!secret) throw new Error('API secret not set — run "🔢 Serial → Set the API secret"');

  // Caption first, configured cell second.
  var found = findByLabel_(sheet, tab.label, tab.labelDir);
  var cellRef = found || tab.numberCell;
  var cellFrom = found
    ? 'found beside the caption "' + tab.label + '"'
    : 'TABS fallback cell — caption "' + tab.label + '" not found on this tab';
  if (!cellRef) {
    throw new Error('tab "' + sheet.getName() + '" has neither a findable caption nor a numberCell in TABS');
  }

  return {
    storeCode:  storeCode,
    destCode:   destCode,
    docType:    tab.docType,
    cellRef:    cellRef,
    cellFrom:   cellFrom,
    partyRef:   tab.partyCell,
    resolvedBy: tab.resolvedBy,
    baseUrl:    String(MIDDLEWARE_URL || '').trim().replace(/\/+$/, ''),
    secret:     secret
  };
}

/**
 * Which series does this tab raise? Exact name first; keyword fallback so renaming a tab to
 * "Delivery Challan (Mumbai)" does not break it. Whichever way it resolves, the mint dialog names
 * the series before anything is drawn, so a wrong guess costs a cancelled dialog, not a number.
 */
function resolveTab_(name) {
  var wanted = normalizeTabName_(name);

  for (var key in TABS) {
    if (!TABS.hasOwnProperty(key)) continue;
    if (normalizeTabName_(key) === wanted) {
      var t = TABS[key];
      if (!DOC_TYPES[t.docType]) {
        throw new Error('tab "' + name + '" is configured as "' + t.docType + '", which is not a series this sheet can number');
      }
      if (!t.numberCell && !t.label) {
        throw new Error('tab "' + name + '" has neither label nor numberCell set in TABS');
      }
      return {
        docType:    t.docType,
        label:      t.label || '',
        labelDir:   t.labelDir || 'right',
        numberCell: String(t.numberCell || '').toUpperCase(),
        partyCell:  String(t.partyCell || '').toUpperCase(),
        resolvedBy: 'listed in TABS'
      };
    }
  }

  // A tab we recognise by name but that has no entry in TABS gets a clear refusal, never a guessed
  // cell. Guessing put the number in F4 — an empty cell beside "Transportation Mode" — where it was
  // invisible on one tab and landed a row below the real field on the other. An error that names the
  // problem costs a minute; a number written into the wrong cell of a printed form costs more.
  for (var i = 0; i < TAB_KEYWORDS.length; i++) {
    if (wanted.indexOf(TAB_KEYWORDS[i].match) !== -1) {
      throw new Error('tab "' + name + '" looks like a ' + DOC_TYPES[TAB_KEYWORDS[i].docType].label +
        ' but is not in TABS, so the script does not know which cell prints the number. ' +
        'Add it to TABS at the top of the script.');
    }
  }

  var known = [];
  for (var k in TABS) if (TABS.hasOwnProperty(k)) known.push(k);
  throw new Error('tab "' + name + '" is not a numbering tab. Add it to TABS at the top of the script. ' +
                  'Configured tabs: ' + known.join(', '));
}

function numberCell_(sheet, cfg) {
  var cell;
  try {
    cell = sheet.getRange(cfg.cellRef);
  } catch (e) {
    throw new Error('"' + cfg.cellRef + '" is not a valid cell on tab "' + sheet.getName() + '"');
  }
  // A merged block displays ONLY its top-left cell. Writing to any other cell of it succeeds, stores
  // the value, and shows nothing — the failure that hid every DC number under the A3:I3 banner.
  // Refuse rather than write into the void, and name the anchor so the fix is obvious.
  if (cell.isPartOfMerge()) {
    var merged = cell.getMergedRanges();
    if (merged.length) {
      var anchor = merged[0].getCell(1, 1);
      if (anchor.getA1Notation() !== cell.getA1Notation()) {
        throw new Error(cfg.cellRef + ' is inside the merged block ' + merged[0].getA1Notation() +
          ', which only ever displays ' + anchor.getA1Notation() + '. A number written to ' +
          cfg.cellRef + ' would be stored but never shown. Point this tab at ' +
          anchor.getA1Notation() + ', or unmerge the block.');
      }
    }
  }
  return cell;
}

/**
 * Find the number field by the caption printed beside or above it, and return its A1 reference.
 * Returns null when the caption is not on the tab, leaving the configured fallback cell in play.
 *
 * Merges resolve to their top-left cell, because that is the only cell of a merged field that
 * displays anything.
 */
function findByLabel_(sheet, label, dir) {
  if (!label) return null;
  var wanted = String(label).trim().toLowerCase();
  var maxR = Math.min(sheet.getLastRow(), 40);
  var maxC = Math.min(sheet.getLastColumn(), 20);
  if (maxR < 1 || maxC < 1) return null;

  var values = sheet.getRange(1, 1, maxR, maxC).getDisplayValues();
  for (var r = 0; r < maxR; r++) {
    for (var c = 0; c < maxC; c++) {
      if (String(values[r][c]).trim().toLowerCase() !== wanted) continue;
      var tr = r + 1 + (dir === 'below' ? 1 : 0);
      var tc = c + 1 + (dir === 'below' ? 0 : 1);
      if (tr > sheet.getMaxRows() || tc > sheet.getMaxColumns()) return null;
      var target = sheet.getRange(tr, tc);
      if (target.isPartOfMerge()) {
        var m = target.getMergedRanges();
        if (m.length) target = m[0].getCell(1, 1);
      }
      return target.getA1Notation();
    }
  }
  return null;
}

/** What the ledger row will say. Always the movement; the party cell, if set, adds detail. */
function buildLabel_(sheet, cfg) {
  var label = cfg.storeCode + ' → ' + cfg.destCode;
  if (!cfg.partyRef) return label;
  try {
    var party = String(sheet.getRange(cfg.partyRef).getValue() || '').trim();
    return party ? (label + ' · ' + party) : label;
  } catch (e) {
    return label;
  }
}

function setApiSecret() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Middleware API secret',
    'Paste the SHEET_API_SECRET value. It is stored in Script Properties, not in a cell, so it does ' +
    'not travel with copies or exports of this sheet.',
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var v = String(r.getResponseText() || '').trim();
  if (!v) { ui.alert('Nothing saved — the box was empty.'); return; }
  PropertiesService.getScriptProperties().setProperty(SECRET_PROP, v);
  ui.alert('Saved. Try "Refresh next number".');
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-tab state
// ─────────────────────────────────────────────────────────────────────────────
//
// Kept in Document Properties rather than in a cell: staff clear and reformat cells, and the
// idempotency reference is the one thing that must survive that. Keyed by sheet id, so the challan
// tab and the sale tab each track their own document independently.

function stateKey_(sheet) { return 'serial.state.' + sheet.getSheetId(); }

function readState_(sheet) {
  var raw = PropertiesService.getDocumentProperties().getProperty(stateKey_(sheet));
  if (!raw) return { phase: 'new' };
  try { return JSON.parse(raw); } catch (e) { return { phase: 'new' }; }
}

function writeState_(sheet, obj) {
  PropertiesService.getDocumentProperties().setProperty(stateKey_(sheet), JSON.stringify(obj));
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware calls
// ─────────────────────────────────────────────────────────────────────────────

function api_(cfg, method, path, body) {
  var opts = {
    method: method.toLowerCase(),
    muteHttpExceptions: true,
    headers: { 'x-sheet-secret': cfg.secret }
  };
  if (body) {
    opts.contentType = 'application/json';
    opts.payload = JSON.stringify(body);
  }

  var res = UrlFetchApp.fetch(cfg.baseUrl + path, opts);
  var code = res.getResponseCode();
  var text = res.getContentText();

  var json = null;
  try { json = JSON.parse(text); } catch (e) { /* fall through to the raw body below */ }

  if (code === 401) throw new Error('the server rejected the API secret — re-run "Set the API secret"');
  if (code === 503 && json && json.error) throw new Error(json.error);
  if (code !== 200 || !json || json.success !== true) {
    throw new Error((json && json.error) ? json.error : ('HTTP ' + code + ' — ' + text.slice(0, 200)));
  }
  return json;
}

function stamp_() {
  return Utilities.formatDate(new Date(), TZ, 'dd MMM yyyy HH:mm');
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shows what the script believes for the ACTIVE tab, so a wrong store code or a tab resolving to
 * the wrong series is visible before it prints a number.
 */
function diagnose() {
  var ui = SpreadsheetApp.getUi();
  var lines = [];
  try {
    var cfg = config_();
    var sheet = SpreadsheetApp.getActiveSheet();
    var state = readState_(sheet);

    lines.push('Script version ' + SCRIPT_VERSION + '   ← must match the file you pasted');
    lines.push('Book           ' + cfg.storeCode + ' → ' + cfg.destCode + '   (hard-coded in this script)');
    lines.push('Tab            ' + sheet.getName());
    lines.push('Series         ' + DOC_TYPES[cfg.docType].label + '  (' + cfg.docType + ')');
    lines.push('               ' + cfg.resolvedBy);
    lines.push('Number cell    ' + cfg.cellRef + '   (' + cfg.cellFrom + ')');
    lines.push('Party cell     ' + (cfg.partyRef || '(none)'));
    lines.push('Middleware     ' + cfg.baseUrl);
    lines.push('API secret     set');
    lines.push('This document  ' + state.phase +
               (state.serial_code ? ' — ' + state.serial_code : '') +
               (state.reference ? '\n               ref ' + state.reference : ''));

    var q = '?docType=' + encodeURIComponent(cfg.docType) + '&state=' + encodeURIComponent(cfg.storeCode);
    var peek = api_(cfg, 'GET', '/api/serial/peek' + q, null);
    lines.push('');
    lines.push('Counter now at ' + (peek.current_value === null ? 'nothing issued yet' : peek.current_value));
    lines.push('Next number    ' + peek.next_code);
    lines.push('Counter key    ' + peek.counterKey);
    lines.push('Last moved     ' + (peek.updated_at || 'never'));

    var open = false;
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'refreshOnOpen') open = true;
    }
    lines.push('Refresh on open ' + (open ? 'installed' : 'NOT installed — use the menu or a button'));

    // Every tab, so a misresolving one is visible here rather than by noticing a blank form later.
    lines.push('');
    lines.push('All tabs in this spreadsheet:');
    var sheets = SpreadsheetApp.getActive().getSheets();
    for (var s2 = 0; s2 < sheets.length; s2++) {
      var nm = sheets[s2].getName();
      try {
        var c2 = config_(sheets[s2]);
        lines.push('  ' + nm + '  →  ' + c2.docType + ' in ' + c2.cellRef + '  (' + c2.cellFrom + ')');
      } catch (e2) {
        lines.push('  ' + nm + '  →  not numbered');
      }
    }
  } catch (err) {
    lines.push('Script version ' + SCRIPT_VERSION);
    lines.push('Problem: ' + err.message);
  }
  ui.alert('Serial diagnostics', lines.join('\n'), ui.ButtonSet.OK);
}
