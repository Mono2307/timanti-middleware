// ============================================================
// Timanti WhatsApp Templates — Google Sheets Setup Script v9
//
// HOW TO USE:
//   1. Open Apps Script: https://script.google.com/home/projects/
//      1JFe8DhhZIP042U0IfaokQYdm0Lhss7v2Hb5Qc07R_uW8jNzESwQ0wk-A/edit
//   2. Ctrl+A → Delete all existing code
//   3. Ctrl+V → Paste this file
//   4. Ctrl+S → Save
//   5. Dropdown shows setupTimantiWhatsApp → click Run → Authorise
//
// ── CHANGES IN v9 ───────────────────────────────────────────
//   1. NEW Sheet 5 — Pricing Estimate. Draft-order PDF, hash
//      6fb7c284e3dd71764a10, Draft Order ID x 8810.
//   2. NEW Store Staff Name field on EVERY sheet. Optional: the
//      signature drops the line entirely when it is blank, so a
//      message never goes out with a dangling empty line.
//   3. The script NO LONGER DELETES unrecognised sheets. v8 removed
//      every tab not in its own list on each run, which would have
//      destroyed a hand-made tab the moment anyone re-ran setup.
//      It now only ever touches the five sheets it builds.
//
//   Adding the staff field pushed the auto-generated rows down one.
//   All addresses below are the CURRENT ones.
//
// WHAT EACH SHEET NEEDS FOR AUTO-GENERATED PDFs:
//   Sheet 2: C7=Draft Order Name (#1063)  C8=Draft Order ID (1429984444673)
//            C9 = Store Staff Name (optional)
//            C12 = drafts/91013a1d4c9b2beea028/{C8x5255}/1063.pdf
//
//   Sheet 3: C7=Order Number (#1063)  C8=Shopify Order ID (7197127278849)
//            C9 = Store Staff Name (optional)
//            C12 = orders/00f6f4bcc547f05bf47f/{C8x8909}/1063.pdf  [Tax Invoice]
//            C13 = orders/91013a1d4c9b2beea028/{C8x5255}/1063.pdf  [Payment Receipt]
//            Version A → C13 | Version B → C12 | Version C → C12
//
//   Sheet 4: No PDF. C10 = Store Staff Name (optional)
//            C13 = Tracking URL built from Tracking No (C8) + Courier (C9)
//
//   Sheet 5: C7=Draft Order Name (#1063)  C8=Draft Order ID (1429984444673)
//            C9 = Store Staff Name (optional)
//            C12 = drafts/6fb7c284e3dd71764a10/{C8x8810}/1063.pdf  [Pricing Estimate]
//
//   NOTE: if the cost-breakup tab already in the spreadsheet is named
//   anything other than "5 - Pricing Estimate", this script leaves it
//   untouched and inserts a new tab beside it. Rename it first if you
//   want the script to take it over.
// ============================================================

var SS_ID = '1l0tRGEBVc3_SVODSMfnTntmsC9iDj-DtweiXjRNlzkU';

// Stamped into the finish alert. If the popup does not say v9, the Apps Script project is still
// running an older paste and nothing in this file has taken effect.
var VERSION = 'v9';

var NAV='#111827', WHITE='#FFFFFF', WAG='#25D366';
var Y_BG='#FFFBEB', Y_FG='#1E3A8A', Y_BD='#D97706';
var R_BG='#FEF2F2', R_FG='#DC2626', R_BD='#DC2626';
var SEC_BG='#F3F4F6', GRAY_BG='#F9FAFB', AUTO_BG='#ECFDF5';
var URL_BG='#EFF6FF', URL_FG='#1D4ED8';

// Signature. The staff name sits between "Warm regards," and "Team Timanti" — the person signs,
// the team follows. IF() collapses the whole line when the cell is blank rather than emitting an
// empty line, which is what makes the field safely optional.
function sign(staffCell){
  return '"Warm regards,"&CHAR(10)&'
    + 'IF('+staffCell+'="","",'+staffCell+'&CHAR(10))&'
    + '"Team Timanti"&CHAR(10)&"+91 77109 38305"';
}

function setupTimantiWhatsApp() {
  var ss = SpreadsheetApp.openById(SS_ID);
  var names = [
    '1 - Payment Link',
    '2 - Advance Payment (DOI)',
    '3 - Order Confirmation (OC)',
    '4 - Shipping Confirmation (SC)',
    '5 - Pricing Estimate'
  ];
  // Adopt the default first sheet only on a fresh spreadsheet. Renaming it unconditionally (v8)
  // would rename whatever happened to sit first — including a tab someone else made.
  if (!ss.getSheetByName(names[0])) ss.getSheets()[0].setName(names[0]);
  for (var i = 1; i < names.length; i++) {
    if (!ss.getSheetByName(names[i])) ss.insertSheet(names[i]);
  }
  // Deliberately NO cleanup pass. Sheets this script does not build are none of its business.
  buildS1(ss.getSheetByName(names[0]));
  buildS2(ss.getSheetByName(names[1]));
  buildS3(ss.getSheetByName(names[2]));
  buildS4(ss.getSheetByName(names[3]));
  buildS5(ss.getSheetByName(names[4]));
  ss.getSheetByName(names[0]).setTabColor('#F59E0B');
  ss.getSheetByName(names[1]).setTabColor('#F59E0B');
  ss.getSheetByName(names[2]).setTabColor('#2563EB');
  ss.getSheetByName(names[3]).setTabColor('#16A34A');
  ss.getSheetByName(names[4]).setTabColor('#7C3AED');

  // Report what actually happened. A silent "Done!" cannot tell a successful run from a run that
  // built five tabs nobody was looking at — which is exactly how a rename mismatch hides.
  var left = ss.getSheets().map(function(sh){ return sh.getName(); })
                .filter(function(n){ return names.indexOf(n) === -1; });
  var msg = 'Timanti WhatsApp Templates ' + VERSION + '\n\n'
    + 'Rebuilt these ' + names.length + ' tabs:\n  ' + names.join('\n  ') + '\n\n'
    + 'Store Staff Name added to all 5 (optional — blank drops the line).\n'
    + 'Sheet 5 is the Pricing Estimate: Draft Order ID x 8810.';
  if (left.length) {
    msg += '\n\nLEFT UNTOUCHED (not built by this script):\n  ' + left.join('\n  ')
      + '\n\nIf your cost-breakup tab is in that list, this script did NOT fill it. '
      + 'Rename that tab to exactly "5 - Pricing Estimate" (or delete it and use the one just '
      + 'created) and run again.';
  }
  SpreadsheetApp.getUi().alert(msg);
}

// ============================================================
// reportTimantiTabs — READ ONLY. Builds nothing, changes no existing tab.
//
// This script only knows the tabs listed in setupTimantiWhatsApp, so any tab added to the
// spreadsheet since (a second payment link, a cost breakup) is invisible to it and gets no Store
// Staff Name field. Run this, then send the contents of the "_tab report" tab, and the missing tabs
// can be built properly instead of guessed at.
//
// Run it from the same dropdown as setupTimantiWhatsApp.
// ============================================================
function reportTimantiTabs() {
  var ss = SpreadsheetApp.openById(SS_ID);
  var out = [];
  var tabNames = [];
  ss.getSheets().forEach(function(sh) {
    var name = sh.getName();
    tabNames.push(name);
    if (name === '_tab report') return;
    out.push('=== ' + name + ' ===');
    var last = Math.min(sh.getLastRow(), 80);
    if (last < 1) { out.push('  (empty)'); return; }
    var vals = sh.getRange(1, 1, last, 4).getValues();
    var fmls = sh.getRange(1, 1, last, 4).getFormulas();
    for (var i = 0; i < last; i++) {
      var bF = String(fmls[i][1] || '').trim(), bV = String(vals[i][1] || '').trim();
      var cF = String(fmls[i][2] || '').trim(), cV = String(vals[i][2] || '').trim();
      if (!bF && !bV && !cF && !cV) continue;
      var line = '  r' + (i + 1) + ' | B: ' + (bF ? bF.slice(0, 400) : bV.slice(0, 120));
      if (cF)      line += '\n         C: ' + cF.slice(0, 400);
      else if (cV) line += '\n         C(value): ' + cV.slice(0, 120);
      out.push(line);
    }
    out.push('');
  });
  var text = 'Timanti WhatsApp tabs — report from ' + VERSION + '\n'
           + tabNames.length + ' tabs: ' + tabNames.join(' | ') + '\n\n' + out.join('\n');
  Logger.log(text);
  var dump = ss.getSheetByName('_tab report') || ss.insertSheet('_tab report');
  dump.clear();
  dump.getRange(1, 1).setValue(text);
  SpreadsheetApp.getUi().alert(
    'Report written to the "_tab report" tab (also in View > Execution log).\n\n'
    + tabNames.length + ' tabs found:\n  ' + tabNames.join('\n  ')
    + '\n\nNothing else was changed. Delete the "_tab report" tab when you are done with it.');
}

function rh(sh,r,h){ sh.setRowHeight(r,h); }
function setCols(sh){
  sh.setColumnWidth(1,18); sh.setColumnWidth(2,250);
  sh.setColumnWidth(3,470); sh.setColumnWidth(4,160); sh.setColumnWidth(5,18);
}
function clearSh(sh){
  sh.clearContents(); sh.clearFormats();
  try{ sh.getRange(1,1,sh.getMaxRows(),sh.getMaxColumns()).breakApart(); }catch(e){}
}
function hdr(sh,r,title,useWhen){
  rh(sh,r,34); sh.getRange(r,1,1,5).setBackground(NAV);
  sh.getRange(r,2,1,3).merge().setValue(title)
    .setFontColor(WHITE).setFontSize(12).setFontWeight('bold').setVerticalAlignment('middle');
  r++;
  rh(sh,r,15); sh.getRange(r,1,1,5).setBackground(NAV);
  sh.getRange(r,2,1,3).merge().setValue('WHEN TO USE:  '+useWhen)
    .setFontColor('#FDE68A').setFontSize(8).setVerticalAlignment('middle');
  return r+1;
}
function gap(sh,r,h){ rh(sh,r,h||8); return r+1; }
function sec(sh,r,txt){
  rh(sh,r,17); sh.getRange(r,1,1,5).setBackground(SEC_BG);
  sh.getRange(r,2,1,3).merge().setValue(txt)
    .setBackground(SEC_BG).setFontColor('#6B7280').setFontSize(7)
    .setFontWeight('bold').setVerticalAlignment('middle');
  return r+1;
}
function inp(sh,r,label,hint){
  rh(sh,r,28);
  sh.getRange(r,2).setValue(label).setFontSize(9).setFontColor('#374151').setVerticalAlignment('middle');
  sh.getRange(r,3).setBackground(Y_BG).setFontColor(Y_FG).setFontSize(10).setFontWeight('bold').setVerticalAlignment('middle')
    .setBorder(false,false,true,false,false,false,Y_BD,SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sh.getRange(r,4).setValue(hint).setFontSize(7).setFontStyle('italic').setFontColor('#9CA3AF').setWrap(true).setVerticalAlignment('middle');
  return r+1;
}
function inpReq(sh,r,label,hint){
  rh(sh,r,32);
  sh.getRange(r,2).setValue(label).setFontSize(9).setFontColor(R_FG).setFontWeight('bold').setVerticalAlignment('middle');
  sh.getRange(r,3).setBackground(R_BG).setFontColor(Y_FG).setFontSize(10).setFontWeight('bold').setVerticalAlignment('middle')
    .setBorder(false,false,true,false,false,false,R_BD,SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sh.getRange(r,4).setValue(hint).setFontSize(7).setFontStyle('italic').setFontColor('#9CA3AF').setWrap(true).setVerticalAlignment('middle');
  return r+1;
}
function inpDD(sh,r,label,hint,options){
  r=inp(sh,r,label,hint);
  var dv=SpreadsheetApp.newDataValidation().requireValueInList(options,true).setAllowInvalid(false).build();
  sh.getRange(r-1,3).setDataValidation(dv);
  return r;
}
// The staff field. Same yellow styling as any other optional input, and deliberately NOT added to
// the send button's required list — a blank one must never block a message going out.
function inpStaff(sh,r){
  return inp(sh,r,'Store Staff Name',
    'Who is sending this message  (e.g.  Priya).  Optional -- leave blank and the line is simply '
    +'left out of the sign-off.');
}
function auto(sh,r,label,formula,hint){
  rh(sh,r,28);
  sh.getRange(r,2).setValue(label).setFontSize(9).setFontColor('#14532D').setVerticalAlignment('middle');
  sh.getRange(r,3).setFormula(formula).setBackground(AUTO_BG).setFontColor('#14532D').setFontSize(9)
    .setWrap(true).setVerticalAlignment('middle')
    .setBorder(false,false,true,false,false,false,'#A7F3D0',SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(r,4).setValue(hint).setFontSize(7).setFontStyle('italic').setFontColor('#9CA3AF').setWrap(true).setVerticalAlignment('middle');
  return r+1;
}
function note(sh,r,txt){
  rh(sh,r,13);
  sh.getRange(r,2).setValue(txt).setFontSize(8).setFontStyle('italic').setFontColor('#9CA3AF').setVerticalAlignment('middle');
  return r+1;
}
function preview(sh,r,formula,h){
  rh(sh,r,h||115);
  sh.getRange(r,2,1,3).merge().setFormula(formula)
    .setBackground(GRAY_BG).setFontColor('#1F2937').setFontSize(10).setWrap(true).setVerticalAlignment('top')
    .setBorder(true,true,true,true,false,false,'#D1D5DB',SpreadsheetApp.BorderStyle.SOLID);
  return r+1;
}
function backupUrl(sh,r,formula){
  rh(sh,r,22);
  sh.getRange(r,2).setValue('Backup URL').setFontSize(8).setFontStyle('italic').setFontColor('#9CA3AF').setVerticalAlignment('middle');
  sh.getRange(r,3).setFormula(formula).setBackground(URL_BG).setFontColor(URL_FG).setFontSize(7).setWrap(true).setVerticalAlignment('middle')
    .setBorder(false,false,true,false,false,false,'#BFDBFE',SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(r,4).setValue('Copy + paste in browser if button does not open')
    .setFontSize(7).setFontStyle('italic').setFontColor('#9CA3AF').setWrap(true).setVerticalAlignment('middle');
  return r+1;
}
function sendBtn(sh,r,prRow,phone,reqCells){
  phone=phone||'C6';
  var chk=(reqCells||['C5','C6','C7']).map(function(c){return c+'=""';}).join(',');
  rh(sh,r,17);
  sh.getRange(r,2,1,3).merge().setValue('SEND  |  click the green button')
    .setBackground(SEC_BG).setFontColor('#6B7280').setFontSize(7).setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  r++;
  rh(sh,r,40);
  sh.getRange(r,2,1,3).merge()
    .setFormula('=IF(OR('+chk+'),"Fill all required (red) fields above first",'
      +'HYPERLINK("https://wa.me/91"&'+phone+'&"?text="&ENCODEURL(B'+prRow+'),"  Open WhatsApp >>"))')
    .setBackground(WAG).setFontColor(WHITE).setFontSize(13).setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  return r+1;
}
function divider(sh,r){
  rh(sh,r,12); sh.getRange(r,1,1,5).setBackground('#E5E7EB');
  return r+1;
}

// ── PDF formulas (INT/MOD split — exact 16-digit result) ────
function pdfMult(id,m){
  return 'TEXT(INT('+id+'/1000000)*'+m+'+INT(MOD('+id+',1000000)*'+m+'/1000000),"0")'
    +'&TEXT(MOD(MOD('+id+',1000000)*'+m+',1000000),"000000")';
}
// Guard: NOT(ISNUMBER) covers empty + text entry; <=0 covers zero
function pdfGuard(idCell,nmCell,errMsg,urlBody){
  return '=IF(OR(NOT(ISNUMBER('+idCell+')),'+idCell+'<=0,'+nmCell+'=""),"'+errMsg+'",'+urlBody+')';
}
function fDraft(id,nm){
  id=id||'C8'; nm=nm||'C7';
  return pdfGuard(id,nm,'Enter Draft Order Name (C7) + Draft Order ID (C8)',
    '"https://timanti.in/apps/download-pdf/drafts/91013a1d4c9b2beea028/"&'+pdfMult(id,5255)+'&"/"&SUBSTITUTE(LOWER('+nm+'),"#","")&".pdf"');
}
function fTax(id,nm){
  id=id||'C8'; nm=nm||'C7';
  return pdfGuard(id,nm,'Enter Order Number (C7) + Shopify Order ID (C8)',
    '"https://timanti.in/apps/download-pdf/orders/00f6f4bcc547f05bf47f/"&'+pdfMult(id,8909)+'&"/"&SUBSTITUTE(LOWER('+nm+'),"#","")&".pdf"');
}
function fOC(id,nm){
  id=id||'C8'; nm=nm||'C7';
  return pdfGuard(id,nm,'Enter Order Number (C7) + Shopify Order ID (C8)',
    '"https://timanti.in/apps/download-pdf/orders/91013a1d4c9b2beea028/"&'+pdfMult(id,5255)+'&"/"&SUBSTITUTE(LOWER('+nm+'),"#","")&".pdf"');
}
// Pricing Estimate. Shared BEFORE the customer commits, so it is always a DRAFT order — the path
// segment is drafts/, and the ID that goes in is the draft order id, not an order id.
function fEstimate(id,nm){
  id=id||'C8'; nm=nm||'C7';
  return pdfGuard(id,nm,'Enter Draft Order Name (C7) + Draft Order ID (C8)',
    '"https://timanti.in/apps/download-pdf/drafts/6fb7c284e3dd71764a10/"&'+pdfMult(id,8810)+'&"/"&SUBSTITUTE(LOWER('+nm+'),"#","")&".pdf"');
}
function waBackup(prCell,phone){
  phone=phone||'C6';
  return '="https://wa.me/91"&'+phone+'&"?text="&ENCODEURL('+prCell+')';
}

// ═══════════════════════════════════════════════════
// SHEET 1 — PAYMENT LINK
// C5 Name | C6 Mobile | C7 Payment Link URL | C8 Staff
// ═══════════════════════════════════════════════════
function buildS1(sh){
  clearSh(sh); setCols(sh);
  var r=1;
  r=hdr(sh,r,'PAYMENT LINK — Follow-Up Message',
    'BEFORE a draft order is paid — you have the GoKwik / Razorpay link ready.');
  r=gap(sh,r);
  r=sec(sh,r,'ENTER DETAILS');
  r=inp(sh,r,'Customer Name','First name  (e.g.  Priya)');
  r=inp(sh,r,'Mobile Number','10 digits, no country code  (e.g.  9830380785)');
  r=inp(sh,r,'Payment Link URL','GoKwik or Razorpay link from the Draft Order in Shopify');
  var staff='C'+r; r=inpStaff(sh,r);              // C8
  r=gap(sh,r,10);
  r=sec(sh,r,'MESSAGE PREVIEW');
  r=note(sh,r,'Auto-updates as you type above');
  var prRow=r;
  r=preview(sh,r,
    '="Hi "&C5&","&CHAR(10)&CHAR(10)&'
    +'"Hope you are doing well."&CHAR(10)&CHAR(10)&'
    +'"We have prepared your payment link for your Timanti order. Please complete the payment at your convenience:"&CHAR(10)&CHAR(10)&'
    +'C7&CHAR(10)&CHAR(10)&'
    +'"Once done, please share a screenshot on this number and we will confirm your order right away."&CHAR(10)&CHAR(10)&'
    +'"Do reach out if you have any questions -- we are always happy to help."&CHAR(10)&CHAR(10)&'
    +sign(staff));
  r=gap(sh,r,6);
  r=backupUrl(sh,r,waBackup('B'+prRow));
  r=gap(sh,r,4);
  r=sendBtn(sh,r,prRow,'C6',['C5','C6','C7']);
}

// ═══════════════════════════════════════════════════
// SHEET 2 — ADVANCE PAYMENT (DOI / Draft Order)
// C5 Name | C6 Mobile | C7 ★Draft Name | C8 ★Draft ID | C9 Staff
// C12 Draft Receipt PDF = drafts/9101.../{C8x5255}/1063.pdf
// ═══════════════════════════════════════════════════
function buildS2(sh){
  clearSh(sh); setCols(sh);
  var r=1;
  r=hdr(sh,r,'ADVANCE PAYMENT — Confirmation Message',
    'AFTER a customer pays the advance on a Draft Order. Receipt PDF auto-generated.');
  r=gap(sh,r);
  r=sec(sh,r,'ENTER DETAILS  —  first 4 required, staff name optional');
  r=inp(sh,r,'Customer Name','First name  (e.g.  Priya)');
  r=inp(sh,r,'Mobile Number','10 digits, no country code  (e.g.  9830380785)');
  r=inpReq(sh,r,'★ REQUIRED  Draft Order Name',
    'Short name at the TOP of the draft order page in Shopify.  '
    +'Looks like  #1062  (WITH the # symbol).  Becomes the filename in the PDF link.');
  r=inpReq(sh,r,'★ REQUIRED  Shopify Draft Order ID  (long number)',
    'From URL bar:  Shopify Admin → Draft Orders → click order → '
    +'URL ends with  /draft_orders/1429984444673  → enter  1429984444673  here.  '
    +'Multiplied by 5255 to build the PDF link.');
  var staff='C'+r; r=inpStaff(sh,r);              // C9
  r=gap(sh,r,8);
  r=sec(sh,r,'AUTO-GENERATED RECEIPT LINK  (needs C7 + C8 above)');
  var pdf='C'+r;
  r=auto(sh,r,'Payment Receipt PDF  →  '+pdf,fDraft(),
    'Auto: Draft Order ID (C8) x 5255  |  filename from C7');
  r=gap(sh,r,8);
  r=sec(sh,r,'MESSAGE PREVIEW');
  r=note(sh,r,'Auto-updates. Receipt link embedded in the message automatically.');
  var prRow=r;
  r=preview(sh,r,
    '="Hi "&C5&","&CHAR(10)&CHAR(10)&'
    +'"Thank you so much for your advance payment. Your order "&C7&" is now registered with us."&CHAR(10)&CHAR(10)&'
    +'"Your payment receipt is here:"&CHAR(10)&'+pdf+'&CHAR(10)&CHAR(10)&'
    +'"We will keep you updated every step of the way. Please write back on this number if you have any questions."&CHAR(10)&CHAR(10)&'
    +sign(staff));
  r=gap(sh,r,6);
  r=backupUrl(sh,r,waBackup('B'+prRow));
  r=gap(sh,r,4);
  r=sendBtn(sh,r,prRow,'C6',['C5','C6','C7','C8']);
}

// ═══════════════════════════════════════════════════
// SHEET 3 — ORDER CONFIRMATION  (3 versions)
// C5 Name | C6 Mobile | C7 ★Order No | C8 ★Order ID | C9 Staff
// C12 Tax Invoice PDF   = orders/00f6.../{C8x8909}/1063.pdf
// C13 Payment Receipt   = orders/9101.../{C8x5255}/1063.pdf
// ═══════════════════════════════════════════════════
function buildS3(sh){
  clearSh(sh); setCols(sh);
  var r=1;
  r=hdr(sh,r,'ORDER CONFIRMATION — Message  (3 versions)',
    'AFTER order is confirmed and paid. Fill the details once, pick the right version below.');
  r=gap(sh,r);
  r=sec(sh,r,'ENTER DETAILS  —  fill once, used by all 3 versions');
  r=inp(sh,r,'Customer Name','First name  (e.g.  Priya)');
  r=inp(sh,r,'Mobile Number','10 digits, no country code  (e.g.  9830380785)');
  r=inpReq(sh,r,'★ REQUIRED  Order Number',
    'WITH the hash symbol  (e.g.  #1063)  — shown in the Orders page in Shopify.  '
    +'Becomes the filename in both PDF links below.');
  r=inpReq(sh,r,'★ REQUIRED  Shopify Order ID  (long number)',
    'From URL bar:  Shopify Admin → Orders → click order → '
    +'URL ends with  /orders/7197127278849  → enter  7197127278849  here.  '
    +'Multiplied to auto-generate BOTH PDF links. Leave blank = broken link.');
  var staff='C'+r; r=inpStaff(sh,r);              // C9
  r=gap(sh,r,8);
  r=sec(sh,r,'AUTO-GENERATED PDF LINKS  (both need C7 + C8 above)');
  var pdfTax='C'+r;
  r=auto(sh,r,'Tax Invoice PDF  →  '+pdfTax+'  (versions B + C)',fTax(),
    'Auto: Order ID (C8) x 8909  |  for offline orders and walk-in');
  var pdfOC='C'+r;
  r=auto(sh,r,'Payment Receipt PDF  →  '+pdfOC+'  (version A)',fOC(),
    'Auto: Order ID (C8) x 5255  |  for online orders');
  r=gap(sh,r,12);

  // Version A — Online, Payment Receipt
  r=divider(sh,r);
  r=sec(sh,r,'VERSION A  —  ONLINE ORDER  —  website purchase  —  uses '+pdfOC+' (Payment Receipt)');
  r=note(sh,r,'timanti.in order paid via Razorpay / UPI. Uses the Payment Receipt.');
  var prA=r;
  r=preview(sh,r,
    '="Hi "&C5&","&CHAR(10)&CHAR(10)&'
    +'"Your Timanti order "&C7&" is confirmed -- thank you for your purchase."&CHAR(10)&CHAR(10)&'
    +'"Your payment receipt is here:"&CHAR(10)&'+pdfOC+'&CHAR(10)&CHAR(10)&'
    +'"Your piece will be dispatched within 2 to 3 business days. Tracking details will follow once it ships."&CHAR(10)&CHAR(10)&'
    +'"Please reach out on this number if there is anything you need."&CHAR(10)&CHAR(10)&'
    +sign(staff));
  r=gap(sh,r,6);
  r=backupUrl(sh,r,waBackup('B'+prA));
  r=gap(sh,r,4);
  r=sendBtn(sh,r,prA,'C6',['C5','C6','C7','C8']);
  r=gap(sh,r,12);

  // Version B — Offline delivery, Tax Invoice
  r=divider(sh,r);
  r=sec(sh,r,'VERSION B  —  OFFLINE ORDER, DELIVERY  —  outstation shipment  —  uses '+pdfTax+' (Tax Invoice)');
  r=note(sh,r,'Offline customer, piece to be shipped. Uses the Tax Invoice.');
  var prB=r;
  r=preview(sh,r,
    '="Hi "&C5&","&CHAR(10)&CHAR(10)&'
    +'"Your Timanti order "&C7&" is confirmed -- thank you for your trust in us."&CHAR(10)&CHAR(10)&'
    +'"Your tax invoice is here:"&CHAR(10)&'+pdfTax+'&CHAR(10)&CHAR(10)&'
    +'"Your piece will be dispatched within 2 to 3 business days. Tracking details will follow once it ships."&CHAR(10)&CHAR(10)&'
    +'"Please reach out on this number if there is anything you need."&CHAR(10)&CHAR(10)&'
    +sign(staff));
  r=gap(sh,r,6);
  r=backupUrl(sh,r,waBackup('B'+prB));
  r=gap(sh,r,4);
  r=sendBtn(sh,r,prB,'C6',['C5','C6','C7','C8']);
  r=gap(sh,r,12);

  // Version C — Walk-in, Tax Invoice
  r=divider(sh,r);
  r=sec(sh,r,'VERSION C  —  WALK-IN / IN-STORE  —  collected at store  —  uses '+pdfTax+' (Tax Invoice)');
  r=note(sh,r,'Walk-in purchase, collected at store. Uses the Tax Invoice.');
  var prC=r;
  r=preview(sh,r,
    '="Hi "&C5&","&CHAR(10)&CHAR(10)&'
    +'"It was lovely having you with us! Your Timanti order "&C7&" is confirmed."&CHAR(10)&CHAR(10)&'
    +'"Your tax invoice is here:"&CHAR(10)&'+pdfTax+'&CHAR(10)&CHAR(10)&'
    +'"We hope you love your new piece. Please do not hesitate to reach out if you have any questions."&CHAR(10)&CHAR(10)&'
    +sign(staff));
  r=gap(sh,r,6);
  r=backupUrl(sh,r,waBackup('B'+prC));
  r=gap(sh,r,4);
  r=sendBtn(sh,r,prC,'C6',['C5','C6','C7','C8']);
}

// ═══════════════════════════════════════════════════
// SHEET 4 — SHIPPING CONFIRMATION
// C5 Name | C6 Mobile | C7 Order No | C8 Tracking No | C9 Courier | C10 Staff
// C13 Tracking URL = auto from C8 + C9
// ═══════════════════════════════════════════════════
function buildS4(sh){
  clearSh(sh); setCols(sh);
  var r=1;
  r=hdr(sh,r,'SHIPPING CONFIRMATION — Message',
    'WHEN AN ORDER SHIPS. Enter AWB + select courier. Tracking link auto-generated.');
  r=gap(sh,r);
  r=sec(sh,r,'ENTER DETAILS  —  first 5 required, staff name optional');
  r=inp(sh,r,'Customer Name','First name  (e.g.  Priya)');
  r=inp(sh,r,'Mobile Number','10 digits, no country code  (e.g.  9830380785)');
  r=inp(sh,r,'Order Number','WITH the hash symbol  (e.g.  #1063)');
  r=inp(sh,r,'Tracking Number','AWB number from shipping label  (e.g.  0712604572)');
  r=inpDD(sh,r,'Courier','Select from dropdown — tracking link builds automatically',['Bluedart','Sequel']);
  var staff='C'+r; r=inpStaff(sh,r);              // C10
  r=gap(sh,r,8);
  r=sec(sh,r,'AUTO-GENERATED TRACKING LINK  (needs Tracking Number + Courier above)');
  var trk='C'+r;
  r=auto(sh,r,'Tracking URL  →  '+trk,
    '=IF(OR(C8="",C9=""),"Enter Tracking Number (C8) and select Courier (C9) above",'
    +'IF(C9="Bluedart","https://www.bluedart.com/web/guest/trackdocket?awb="&C8,'
    +'"https://sequel247.com/track/"&C8))',
    'Auto: Bluedart or Sequel detected from dropdown');
  r=gap(sh,r,8);
  r=sec(sh,r,'MESSAGE PREVIEW');
  r=note(sh,r,'Auto-updates as you fill details above.');
  var prRow=r;
  r=preview(sh,r,
    '="Hi "&C5&","&CHAR(10)&CHAR(10)&'
    +'"Great news -- your Timanti order "&C7&" is on its way!"&CHAR(10)&CHAR(10)&'
    +'"Tracking Number: "&C8&CHAR(10)&'
    +'"Courier: "&C9&CHAR(10)&'
    +'"Track your shipment: "&'+trk+'&CHAR(10)&CHAR(10)&'
    +'"Please reach out on this number if you need any assistance."&CHAR(10)&CHAR(10)&'
    +sign(staff));
  r=gap(sh,r,6);
  r=backupUrl(sh,r,waBackup('B'+prRow));
  r=gap(sh,r,4);
  r=sendBtn(sh,r,prRow,'C6',['C5','C6','C7','C8','C9']);
}

// ═══════════════════════════════════════════════════
// SHEET 5 — PRICING ESTIMATE  (cost breakup)
// C5 Name | C6 Mobile | C7 ★Draft Name | C8 ★Draft ID | C9 Staff
// C12 Pricing Estimate PDF = drafts/6fb7.../{C8x8810}/1063.pdf
//
// Sent BEFORE the customer commits, so the document is always a DRAFT order — the same place the
// advance receipt on Sheet 2 comes from. Use the Draft Order ID, not an Order ID.
// ═══════════════════════════════════════════════════
function buildS5(sh){
  clearSh(sh); setCols(sh);
  var r=1;
  r=hdr(sh,r,'PRICING ESTIMATE — Cost Breakup Message',
    'BEFORE the customer commits — sharing the component-wise price for approval.');
  r=gap(sh,r);
  r=sec(sh,r,'ENTER DETAILS  —  first 4 required, staff name optional');
  r=inp(sh,r,'Customer Name','First name  (e.g.  Priya)');
  r=inp(sh,r,'Mobile Number','10 digits, no country code  (e.g.  9830380785)');
  r=inpReq(sh,r,'★ REQUIRED  Draft Order Name',
    'Short name at the TOP of the draft order page in Shopify.  '
    +'Looks like  #1062  (WITH the # symbol).  Becomes the filename in the PDF link.');
  r=inpReq(sh,r,'★ REQUIRED  Shopify Draft Order ID  (long number)',
    'From URL bar:  Shopify Admin → Draft Orders → click order → '
    +'URL ends with  /draft_orders/1429984444673  → enter  1429984444673  here.  '
    +'Multiplied by 8810 to build the PDF link.');
  var staff='C'+r; r=inpStaff(sh,r);              // C9
  r=gap(sh,r,8);
  r=sec(sh,r,'AUTO-GENERATED ESTIMATE LINK  (needs C7 + C8 above)');
  var pdf='C'+r;
  r=auto(sh,r,'Pricing Estimate PDF  →  '+pdf,fEstimate(),
    'Auto: Draft Order ID (C8) x 8810  |  filename from C7');
  r=gap(sh,r,8);
  r=sec(sh,r,'MESSAGE PREVIEW');
  r=note(sh,r,'Auto-updates. Estimate link embedded in the message automatically.');
  var prRow=r;
  r=preview(sh,r,
    '="Hi "&C5&","&CHAR(10)&CHAR(10)&'
    +'"Thank you for visiting us. We have put together the pricing for the piece you selected."&CHAR(10)&CHAR(10)&'
    +'"Here is your pricing estimate:"&CHAR(10)&'+pdf+'&CHAR(10)&CHAR(10)&'
    +'"Please reach out on this number if you have any questions."&CHAR(10)&CHAR(10)&'
    +sign(staff));
  r=gap(sh,r,6);
  r=backupUrl(sh,r,waBackup('B'+prRow));
  r=gap(sh,r,4);
  r=sendBtn(sh,r,prRow,'C6',['C5','C6','C7','C8']);
}
