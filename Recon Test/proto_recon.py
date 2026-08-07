"""Payments reconciliation across Pine Labs + GoKwik.

The gateway/Shopify dumps in this folder are MANUAL exports that get overwritten
every month, so this script never treats them as the source of truth. Each run:

  1. INGEST  — parse whatever dumps are currently on disk and UPSERT them into a
               persistent store under _recon_store/ (append-only across months;
               later dumps fill in settlement data that wasn't known at txn time).
  2. MATCH   — run the whole matcher over the FULL history in the store, not just
               this month's dump. This is what lets an advance paid in June link
               to the order that was finalised in July.
  3. LEDGER  — rewrite recon_ledger.csv from the full store, grouped by order so
               every leg of a part-paid order sits together with a running
               paid-to-date and balance.

Deleting a month's dump from this folder does NOT delete that month from recon.
"""

import csv, shutil, tempfile, os, re, itertools
from collections import Counter, defaultdict
from datetime import datetime, date

BASE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(BASE, '_recon_store')
TXN_STORE = os.path.join(STORE, 'transactions.csv')
ENT_STORE = os.path.join(STORE, 'entities.csv')
LEDGER = os.path.join(BASE, 'recon_ledger.csv')
RUN_STAMP = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

TOL = 1.5                # rupee tolerance when comparing amounts
SPLIT_WINDOW_DAYS = 35   # deposits can precede the order by weeks
MAX_LEGS = 3

# ── Date helpers ──────────────────────────────────────────────────────────────
def parse_pine_date(s):
    for fmt in ('%d/%m/%Y %I:%M:%S %p', '%d/%m/%Y %H:%M:%S', '%m/%d/%Y %I:%M:%S %p'):
        try: return datetime.strptime(s.strip(), fmt).date()
        except: pass
    return None

def parse_mpr_date(s):
    try: return datetime.strptime(str(s).strip(), '%d-%b-%y').date()
    except: return None

def parse_gk_date(s):
    for fmt in ('%d-%m-%Y %H:%M', '%d/%m/%Y %I:%M %p', '%d/%m/%Y %H:%M:%S', '%m/%d/%Y %I:%M %p', '%m/%d/%Y %H:%M'):
        try: return datetime.strptime(s.strip(), fmt).date()
        except: pass
    return None

def parse_shop_date(s):
    for fmt in ('%Y-%m-%d', '%d/%m/%Y'):
        try: return datetime.strptime(s.strip(), fmt).date()
        except: pass
    return None

def iso(d): return d.isoformat() if isinstance(d, date) else ''
def from_iso(s):
    try: return date.fromisoformat((s or '').strip())
    except: return None

def days_diff(a, b):
    if not a or not b: return 999
    return abs((a - b).days)

def strip_apos(s): return s.lstrip("'").strip()

def parse_bill_invoice(raw):
    s = strip_apos(raw)
    m = re.search(r'(#[A-Z]\d+)', s, re.I)
    return m.group(1).upper() if m else ''

def norm_platform_ref(s):
    s = s.strip()
    if not s or s.startswith('GKMREF') or s.startswith('KWIK'): return ''
    if s.startswith('#'): return s
    if re.match(r'^D\d+$', s, re.I): return '#' + s.upper()
    return ''

def name_sim(a, b):
    if not a or not b: return 0.0
    ta = set(a.lower().split())
    tb = b.lower().split()
    hits = sum(1 for t in tb if t in ta)
    return hits / max(len(ta), len(tb), 1)

def is_real_name(n):
    n = (n or '').strip().lower()
    return bool(n) and n != 'null' and '@' not in n

def is_test_txn(amount, order_number=''):
    return amount < 2 or 'TEST' in order_number.upper()

def fnum(v):
    try: return float(str(v).strip() or 0)
    except: return 0.0

# ══════════════════════════════════════════════════════════════════════════════
# STORE — persistent, month-over-month
# ══════════════════════════════════════════════════════════════════════════════
TXN_COLS = ['Key','Source','TxnID','TxnDate','Amount','Fee','NetPaid','SettlDate','SettlUTR',
            'PaymentMode','Name','VPA','CardLast4','BillInvoice','PlatformRef',
            'FirstSeen','LastSeen','SourceFile']
ENT_COLS = ['Ref','Type','Customer','Date','Total','AdvancePaid','DateApprox',
            'FirstSeen','LastSeen','SourceFile']

def load_store(path, key):
    out = {}
    if not os.path.exists(path): return out
    with open(path, newline='', encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            if r.get(key): out[r[key]] = dict(r)
    return out

MONEY_FIELDS = ('Amount', 'Fee', 'NetPaid', 'SettlDate', 'SettlUTR', 'Total', 'AdvancePaid')

def upsert(store, key, rec):
    """Fill-forward merge: a non-empty new value wins, otherwise the stored value
    survives. Blank/zero fields in a fresh dump never erase data we already have
    (e.g. settlement details that only arrived in a later month's MPR).

    Returns 'new' / 'restated' (a money or settlement field actually changed) /
    'seen'. Descriptive fields being enriched — the MPR calls a leg CREDIT CARD
    where the txn export says CARD — is expected and not reported as a change."""
    old = store.get(key)
    if not old:
        rec['FirstSeen'] = RUN_STAMP
        rec['LastSeen'] = RUN_STAMP
        store[key] = rec
        return 'new'
    merged = dict(old)
    changed = False
    for k, v in rec.items():
        if k in ('FirstSeen', 'LastSeen'): continue
        if v in (None, '', 0, 0.0, '0', '0.0'): continue
        if k == 'SourceFile':
            # provenance accumulates — one leg legitimately appears in both the
            # txn export and the settlement/MPR file for the same period
            seen = [s for s in str(old.get(k, '')).split('; ') if s]
            if v not in seen: seen.append(v)
            merged[k] = '; '.join(seen)
            continue
        if k in MONEY_FIELDS and str(old.get(k, '')) != str(v):
            changed = True
        merged[k] = v
    merged['LastSeen'] = RUN_STAMP
    store[key] = merged
    return 'restated' if changed else 'seen'

def write_store(path, cols, store, keyfn):
    os.makedirs(STORE, exist_ok=True)
    if os.path.exists(path):
        shutil.copy2(path, path + '.bak')
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for k in sorted(store, key=keyfn):
            w.writerow({c: store[k].get(c, '') for c in cols})

txn_store = load_store(TXN_STORE, 'Key')
ent_store = load_store(ENT_STORE, 'Ref')
_bootstrapped = False

# ── One-time bootstrap from pre-store recon_output*.csv ──────────────────────
# Earlier months were only ever written as a flat output CSV and their source
# dumps have since been overwritten. Seed the store from those so that history
# survives the switch to the persistent design.
if not txn_store:
    legacy = sorted(f for f in os.listdir(BASE)
                    if f.lower().startswith('recon_output') and f.endswith('.csv'))
    legacy_legs = defaultdict(list)
    for fname in legacy:
        with open(os.path.join(BASE, fname), newline='', encoding='utf-8-sig') as f:
            for r in csv.DictReader(f):
                tid = (r.get('TxnID') or '').strip()
                if not tid: continue
                src = (r.get('Source') or '').strip()
                holder = (r.get('Cardholder') or '').strip()
                last4 = (r.get('CardLast4') or '').strip()
                vpa = holder if '@' in holder else (last4 if '@' in last4 else '')
                key = f'{src}|{tid}'
                upsert(txn_store, key, {
                    'Key': key, 'Source': src, 'TxnID': tid,
                    'TxnDate': (r.get('TxnDate') or '').strip(),
                    'Amount': f'{fnum(r.get("Gross")):.2f}',
                    'Fee': f'{fnum(r.get("Fee")):.2f}',
                    'NetPaid': f'{fnum(r.get("NetPaid")):.2f}',
                    'SettlDate': (r.get('SettlDate') or '').strip(),
                    'SettlUTR': (r.get('SettlUTR') or '').strip(),
                    'PaymentMode': (r.get('PaymentMode') or '').strip(),
                    'Name': holder if is_real_name(holder) else '',
                    'VPA': vpa, 'CardLast4': '' if '@' in last4 else last4,
                    'BillInvoice': '', 'PlatformRef': '',
                    'SourceFile': f'(bootstrap: {fname})',
                })
                ref = (r.get('OrderRef') or '').strip()
                if ref and ref not in ('UNLINKED', 'AMBIGUOUS'):
                    legacy_legs[ref].append(r)
    # Rebuild the order/draft entities those legs were matched against. The dumps
    # that carried their real dates are gone, so approximate the entity date with
    # the latest leg that paid it and flag it as approximate.
    for ref, legs in legacy_legs.items():
        dates = [from_iso(l.get('TxnDate')) for l in legs]
        dates = [d for d in dates if d]
        adv = ''
        for l in legs:
            if l.get('EntityType') == 'draft' and l.get('Role') == 'advance':
                adv = f'{fnum(l.get("Gross")):.2f}'
        upsert(ent_store, ref, {
            'Ref': ref, 'Type': legs[0].get('EntityType') or 'order',
            'Customer': legs[0].get('Customer') or '',
            'Date': iso(max(dates)) if dates else '',
            'Total': f'{fnum(legs[0].get("OrderTotal")):.2f}',
            'AdvancePaid': adv, 'DateApprox': '1',
            'SourceFile': '(bootstrap)',
        })
    if txn_store:
        _bootstrapped = True
        print(f'Bootstrapped store from {len(legacy)} legacy output file(s): '
              f'{len(txn_store)} txns, {len(ent_store)} entities')

_pre_txn = len(txn_store)
_pre_ent = len(ent_store)
stats = Counter()

# ══════════════════════════════════════════════════════════════════════════════
# INGEST — this month's dumps
# ══════════════════════════════════════════════════════════════════════════════

# ── Pine Labs txn CSVs ───────────────────────────────────────────────────────
pine_files = [f for f in os.listdir(BASE) if 'all transactions' in f.lower() and f.endswith('.csv')]
for fname in sorted(pine_files):
    with open(os.path.join(BASE, fname), newline='', encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            if r.get('Txn Status','').lower() != 'success': continue
            cpm = r.get('Customer Payment Mode ID','')
            last4 = cpm.replace("'","").split('****')[-1] if '****' in cpm else ''
            if '@' not in last4:
                _d = re.sub(r'\D', '', last4)      # '**2213' -> '2213'
                last4 = _d[-4:] if _d else ''
            amount = fnum(r.get('Amount'))
            if is_test_txn(amount): continue
            txn_id = strip_apos(r.get('Transaction ID',''))
            if not txn_id: continue
            name = r.get('Name','').strip()
            key = f'Pine Labs|{txn_id}'
            stats[upsert(txn_store, key, {
                'Key': key, 'Source': 'Pine Labs', 'TxnID': txn_id,
                'TxnDate': iso(parse_pine_date(r.get('Date',''))),
                'Amount': f'{amount:.2f}', 'Fee': '', 'NetPaid': '',
                'SettlDate': '', 'SettlUTR': '',
                'PaymentMode': r.get('Payment Mode','').upper(),
                'Name': name if is_real_name(name) else '',
                'VPA': strip_apos(cpm) if '@' in cpm else '',
                'CardLast4': last4 if '@' not in last4 else '',
                'BillInvoice': parse_bill_invoice(r.get('Bill Invoice','')),
                'PlatformRef': '', 'SourceFile': fname,
            })] += 1
print(f'Pine Labs txn files ingested: {len(pine_files)}')

# ── Pine Labs MPR xlsx (settlement + settlement-only SALEs) ──────────────────
import openpyxl
mpr_files = [f for f in os.listdir(BASE) if 'mpr' in f.lower() and f.endswith('.xlsx')]
for fname in sorted(mpr_files):
    tmp = tempfile.mktemp(suffix='.xlsx')
    shutil.copy2(os.path.join(BASE, fname), tmp)
    wb = openpyxl.load_workbook(tmp, data_only=True)
    os.remove(tmp)
    ws = wb['Trxn details']
    rows_iter = list(ws.iter_rows(values_only=True))
    hdrs = list(rows_iter[1])
    def col(name, h=hdrs):
        try: return h.index(name)
        except: return -1
    for r in rows_iter[2:]:
        if r[col('Trxn type')] != 'SALE': continue
        tid = str(r[col('Transaction Id')] or '').strip()
        if not tid: continue
        _pan = str(r[col('Card Pan Number')] or '').replace('*','')
        gross = float(r[col('Gross Txn Amount')] or 0)
        fee = float(r[col('Total Fee (including Taxes)')] or 0)
        net = float(r[col('Paid to Merchant A/c')] or 0)
        amt = gross or (net + fee)
        if is_test_txn(amt): continue
        key = f'Pine Labs|{tid}'
        # A SALE present in the MPR but missing from the "All transactions"
        # export is still real, collected money — upsert creates it either way.
        stats[upsert(txn_store, key, {
            'Key': key, 'Source': 'Pine Labs', 'TxnID': tid,
            'TxnDate': iso(parse_mpr_date(r[col('Txn Date')])),
            'Amount': f'{amt:.2f}', 'Fee': f'{fee:.2f}', 'NetPaid': f'{net:.2f}',
            'SettlDate': iso(parse_mpr_date(r[col('Settlement Date')])),
            'SettlUTR': str(r[col('UTR No')] or '').strip(),
            'PaymentMode': str(r[col('Instrument Type')] or '').strip().upper() or 'CARD',
            'Name': '', 'VPA': str(r[col('Payer VPA')] or '').strip(),
            'CardLast4': _pan[-4:] if _pan else '',
            'BillInvoice': '', 'PlatformRef': '', 'SourceFile': fname,
        })] += 1
print(f'Pine Labs MPR files ingested: {len(mpr_files)}')

# ── GoKwik txn CSVs ──────────────────────────────────────────────────────────
gk_files = [f for f in os.listdir(BASE) if 'transaction-report' in f.lower() and f.endswith('.csv')]
for fname in sorted(gk_files):
    with open(os.path.join(BASE, fname), newline='', encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            if r.get('Status','').lower() != 'success': continue
            order_num = r.get('Order Number','').strip()
            amount = fnum(r.get('Amount'))
            if is_test_txn(amount, order_num): continue
            pid = r.get('Payment ID','').strip()
            if not pid: continue
            ref = norm_platform_ref(order_num) or norm_platform_ref(r.get('Platform order number',''))
            key = f'GoKwik|{pid}'
            stats[upsert(txn_store, key, {
                'Key': key, 'Source': 'GoKwik', 'TxnID': pid,
                'TxnDate': iso(parse_gk_date(r.get('Created At',''))),
                'Amount': f'{amount:.2f}', 'Fee': '', 'NetPaid': '',
                'SettlDate': '', 'SettlUTR': '',
                'PaymentMode': (r.get('Payment Mode','') or r.get('Payment Method','')).upper(),
                'Name': '', 'VPA': r.get('Payer vpa','').strip(),
                'CardLast4': r.get('Card Last 4 Digits','').strip(),
                'BillInvoice': '', 'PlatformRef': ref, 'SourceFile': fname,
            })] += 1
print(f'GoKwik txn files ingested: {len(gk_files)}')

# ── GoKwik settlement CSVs ───────────────────────────────────────────────────
settle_files = [f for f in os.listdir(BASE) if 'settlement_v2' in f.lower() and f.endswith('.csv')]
for fname in sorted(settle_files):
    with open(os.path.join(BASE, fname), newline='', encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            if r.get('Transaction Type','').lower() != 'payment': continue
            pid = r.get('Payment Id','').strip()
            if not pid: continue
            key = f'GoKwik|{pid}'
            rec = {
                'Key': key, 'Source': 'GoKwik', 'TxnID': pid,
                'Fee': f'{fnum(r.get("Fee")) + fnum(r.get("Tax")):.2f}',
                'NetPaid': f'{fnum(r.get("Credit")):.2f}',
                'SettlUTR': r.get('Settlement UTR','').strip(),
                'SettlDate': iso(parse_gk_date(r.get('Settlement Date',''))),
                'PlatformRef': norm_platform_ref(r.get('Platform Order Id','')),
                'SourceFile': fname,
            }
            if key not in txn_store:
                # settled but absent from the txn export — keep the money visible
                rec.update({'TxnDate': iso(parse_gk_date(r.get('Transaction Date',''))),
                            'Amount': f'{fnum(r.get("Amount")):.2f}',
                            'PaymentMode': r.get('Payment Method','').upper(),
                            'Name': '', 'VPA': '', 'CardLast4': '', 'BillInvoice': ''})
            stats[upsert(txn_store, key, rec)] += 1
print(f'GoKwik settlement files ingested: {len(settle_files)}')

# ── Shopify orders ───────────────────────────────────────────────────────────
def ingest_shopify(fname, etype):
    """Totals are re-summed from the file and REPLACE the stored total (rather
    than accumulating), so re-ingesting the same export is idempotent."""
    path = os.path.join(BASE, fname)
    agg = {}
    with open(path, newline='', encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            ref = r.get('Order name','').strip()
            if not ref: continue
            e = agg.setdefault(ref, {'total': 0.0, 'customer': r.get('Customer name','').strip(),
                                     'date': parse_shop_date(r.get('Day','')),
                                     'tags': r.get('Payment Tags','')})
            e['total'] += fnum(r.get('Net sales'))
    for ref, e in agg.items():
        adv = ''
        m = re.search(r'paid:Rs(\d+)', e['tags'] or '')
        if m: adv = f'{float(m.group(1)):.2f}'
        rec = {'Ref': ref, 'Type': etype, 'Customer': e['customer'], 'Date': iso(e['date']),
               'Total': f'{e["total"]:.2f}', 'AdvancePaid': adv, 'DateApprox': '',
               'SourceFile': fname}
        # a real export supersedes bootstrapped guesses outright
        if ref in ent_store and ent_store[ref].get('DateApprox') == '1':
            ent_store[ref].update({'Date': '', 'Total': '', 'DateApprox': ''})
        upsert(ent_store, ref, rec)
    return len(agg)

_orders_file = 'Accounts - Fully Paid Orders.csv'
if os.path.exists(os.path.join(BASE, _orders_file)):
    print(f'Orders ingested: {ingest_shopify(_orders_file, "order")} from {_orders_file}')
else:
    print(f'!! {_orders_file} not found — relying on stored orders only')

_draft_files = sorted(f for f in os.listdir(BASE)
                      if f.lower().startswith('draft-orders-report') and f.endswith('.csv'))
if _draft_files:
    for df in _draft_files:
        print(f'Drafts ingested: {ingest_shopify(df, "draft")} from {df}')
else:
    print('!! No draft-orders-report*.csv found — draft advances for this period '
          'cannot be matched. Re-export it if advances are expected.')

write_store(TXN_STORE, TXN_COLS, txn_store, lambda k: (txn_store[k].get('TxnDate',''), k))
write_store(ENT_STORE, ENT_COLS, ent_store, lambda k: (ent_store[k].get('Date',''), k))
print(f'\nStore: {len(txn_store)} txns ({len(txn_store)-_pre_txn} new this run), '
      f'{len(ent_store)} entities ({len(ent_store)-_pre_ent} new this run)')
print(f'  upserts -> {dict(stats)}')

# ══════════════════════════════════════════════════════════════════════════════
# MATCH — over the full store, every month, every run
# ══════════════════════════════════════════════════════════════════════════════
txns = []
for rec in txn_store.values():
    txns.append({
        'source': rec['Source'], 'txnId': rec['TxnID'],
        'date': from_iso(rec.get('TxnDate')), 'amount': fnum(rec.get('Amount')),
        'fee': fnum(rec.get('Fee')), 'netPaid': fnum(rec.get('NetPaid')),
        'settlDate': from_iso(rec.get('SettlDate')), 'utr': rec.get('SettlUTR',''),
        'paymentMode': rec.get('PaymentMode',''), 'name': rec.get('Name',''),
        'vpa': rec.get('VPA',''), 'cardLast4': rec.get('CardLast4',''),
        'billInvoice': rec.get('BillInvoice',''), 'platformRef': rec.get('PlatformRef',''),
        'firstSeen': rec.get('FirstSeen',''), 'lastSeen': rec.get('LastSeen',''),
        'sourceFile': rec.get('SourceFile',''),
    })
txns.sort(key=lambda t: (t['date'] or date.min, t['txnId']))

all_entities = []
for rec in ent_store.values():
    e = {'ref': rec['Ref'], 'type': rec.get('Type','order'), 'customer': rec.get('Customer',''),
         'date': from_iso(rec.get('Date')), 'total': fnum(rec.get('Total')),
         'dateApprox': rec.get('DateApprox') == '1'}
    if rec.get('AdvancePaid'): e['advance_paid'] = fnum(rec['AdvancePaid'])
    all_entities.append(e)
entity_by_ref = {e['ref']: e for e in all_entities}
print(f'Matching {len(txns)} transactions against {len(all_entities)} orders/drafts '
      f'({sum(1 for e in all_entities if e["type"]=="draft")} drafts)')

def find_candidates(amount, entities):
    result = []
    for e in entities:
        if abs(e['total'] - amount) <= TOL:
            result.append(e)
        elif e.get('type') == 'draft' and abs(e.get('advance_paid', -99999) - amount) <= TOL:
            result.append(e)
    return result

def match_by_amount_date(txn, entities):
    cands = find_candidates(txn['amount'], entities)
    if not cands: return {'method':'UNLINKED','match':None,'confidence':'NONE','notes':'No amount match'}
    name = txn.get('name','') or txn.get('vpa','')
    scored = [(e, days_diff(txn['date'], e['date']), name_sim(name, e['customer'])) for e in cands]
    scored = [(e,d,s) for e,d,s in scored if d <= 3]
    if not scored: return {'method':'UNLINKED','match':None,'confidence':'NONE','notes':'Amount match but >3d date gap'}
    scored.sort(key=lambda x:(x[1],-x[2]))
    if len(scored) == 1:
        return {'method':'AMOUNT_DATE','match':scored[0][0],'confidence':'MEDIUM' if scored[0][1]<=1 else 'LOW','notes':''}
    top, sec = scored[0], scored[1]
    if top[2] > 0.25 and top[2] > sec[2]+0.2:
        return {'method':'AMOUNT_DATE','match':top[0],'confidence':'MEDIUM','notes':f'Name preferred over {sec[0]["ref"]}'}
    if top[1] < sec[1]-0.5:
        return {'method':'AMOUNT_DATE','match':top[0],'confidence':'LOW','notes':f'Closer date preferred over {sec[0]["ref"]}'}
    cstr = ' | '.join(f'{e["ref"]}(D{d:.0f},{s:.0%})' for e,d,s in scored)
    return {'method':'AMBIGUOUS','match':None,'confidence':'AMBIGUOUS','notes':cstr}

def build_row(txn, mr):
    m = mr['match']
    amt = txn['amount']
    d = txn.get('date')
    return {
        '_vpa': txn.get('vpa','') or txn.get('name',''),
        '_name': txn.get('name',''),
        '_date': d,
        '_amount': amt,
        '_entity': m,
        'Source': txn['source'],
        'TxnMonth': d.strftime('%Y-%m') if d else '',
        'TxnDate': str(d or ''),
        'SettlDate': str(txn.get('settlDate') or ''),
        'TxnID': txn['txnId'],
        'PaymentMode': txn.get('paymentMode',''),
        'Cardholder': txn.get('name','') or txn.get('vpa',''),
        'CardLast4': txn.get('cardLast4',''),
        'Gross': f'{amt:.2f}',
        'Fee': f'{txn.get("fee",0):.2f}',
        'NetPaid': f'{(txn.get("netPaid") or amt):.2f}',
        'SettlUTR': txn.get('utr',''),
        'OrderRef': m['ref'] if m else ('AMBIGUOUS' if mr['method']=='AMBIGUOUS' else 'UNLINKED'),
        'OrderTotal': f'{m["total"]:.2f}' if m else '',
        'Customer': m['customer'] if m else '',
        'EntityType': m['type'] if m else '',
        'MatchMethod': mr['method'],
        'Confidence': mr['confidence'],
        'Notes': mr.get('notes',''),
        'FirstSeen': txn.get('firstSeen',''),
        'LastSeen': txn.get('lastSeen',''),
        'SourceFile': txn.get('sourceFile',''),
    }

def relink(row, e, method, confidence, notes):
    row['_entity'] = e
    row['OrderRef'] = e['ref']; row['OrderTotal'] = f'{e["total"]:.2f}'
    row['Customer'] = e['customer']; row['EntityType'] = e['type']
    row['MatchMethod'] = method; row['Confidence'] = confidence; row['Notes'] = notes

# ── Pass 1: explicit references, else amount+date ────────────────────────────
rows = []
for t in txns:
    ref = t['billInvoice'] or t['platformRef']
    if ref:
        method = 'BILL_INVOICE' if t['billInvoice'] else ('DRAFT_REF' if ref.startswith('#D') else 'ORDER_REF')
        entity = entity_by_ref.get(ref)
        mr = {'method':method,'match':entity,'confidence':'HIGH','notes':''} if entity else \
             {'method':method,'match':None,'confidence':'LOW','notes':f'{ref} not in data'}
    else:
        mr = match_by_amount_date(t, all_entities)
    rows.append(build_row(t, mr))

def unlinked_rows():
    return [r for r in rows if r['OrderRef'] in ('UNLINKED','AMBIGUOUS')]

# ── Pass 2: VPA cross-reference ──────────────────────────────────────────────
for row in unlinked_rows():
    vpa = (row['_vpa'] or '').lower()
    if not vpa or vpa == 'null': continue
    for other in rows:
        if other is row or not other['_entity']: continue
        if (other['_vpa'] or '').lower() == vpa:
            relink(row, other['_entity'], 'VPA_CROSS_REF', 'MEDIUM', 'Shared VPA/name with another txn')
            break

# ── Pass 3: payer name + date (amount not required) ──────────────────────────
for row in unlinked_rows():
    name = row.get('_name','')
    if not is_real_name(name): continue
    scored = [(e, days_diff(row.get('_date'), e['date']), name_sim(name, e['customer']))
              for e in all_entities]
    scored = [x for x in scored if x[2] >= 0.5 and x[1] <= 4]
    if not scored: continue
    scored.sort(key=lambda x:(-x[2], x[1]))
    e, d, _ = scored[0]
    relink(row, e, 'NAME_DATE', 'LOW', f'Name~"{e["customer"]}" within {d:.0f}d (amount unconfirmed)')

# ── Pass 4: split payments — a subset of legs summing to an order total ──────
def _combo_sum(combo): return sum(l['_amount'] for l in combo)

for e in sorted(all_entities, key=lambda e: (str(e['date']), e['ref'])):
    pool = [r for r in unlinked_rows()
            if r.get('_date') and days_diff(r['_date'], e['date']) <= SPLIT_WINDOW_DAYS]
    if len(pool) < 2: continue
    combo = None
    for size in range(2, min(len(pool), MAX_LEGS) + 1):
        for c in itertools.combinations(pool, size):
            s = _combo_sum(c)
            if abs(s - e['total']) <= TOL and sum(1 for x in all_entities if abs(x['total'] - s) <= TOL) == 1:
                combo = c; break
        if combo: break
    if not combo: continue
    total = _combo_sum(combo)
    span = max(days_diff(a['_date'], b['_date']) for a in combo for b in combo)
    for i, l in enumerate(combo, 1):
        relink(l, e, 'SPLIT_PAYMENT', 'LOW',
               f'Leg {i}/{len(combo)} of split (sum Rs{total:.2f} = {e["ref"]}, legs span {span:.0f}d)')

# ── Pass 5: draft → order supersession ───────────────────────────────────────
# A draft that took an advance is later converted to a real order, and the two
# carry different refs. Tie them into one group so the advance and the balance
# reconcile against a single order even when they fall in different months.
supersede = {}
for d in [e for e in all_entities if e['type'] == 'draft']:
    cands = []
    for o in [e for e in all_entities if e['type'] == 'order']:
        if not d['date'] or not o['date'] or o['date'] < d['date']: continue
        if o['total'] <= 0 or d['total'] <= 0: continue
        if abs(o['total'] - d['total']) / max(o['total'], d['total']) > 0.05: continue
        if name_sim(d['customer'], o['customer']) < 0.8: continue
        cands.append(o)
    if len(cands) == 1:
        supersede[d['ref']] = cands[0]['ref']
for dref, oref in supersede.items():
    print(f'Draft supersession: {dref} -> {oref} '
          f'(same customer, totals within 5%)')

def group_of(ref):
    return supersede.get(ref, ref)

# ── Pass 6: balance closers (the cross-month advance/final case) ─────────────
# With the advance already linked (possibly to the superseded draft), look for an
# unlinked leg that settles the order's REMAINING balance. This is what links a
# July final payment to a June advance on the same order.
def group_paid(gref):
    return sum(r['_amount'] for r in rows if r['_entity'] and group_of(r['_entity']['ref']) == gref)

for e in sorted(all_entities, key=lambda e: (str(e['date']), e['ref'])):
    if e['ref'] in supersede: continue            # only reconcile at group level
    bal = e['total'] - group_paid(e['ref'])
    if bal <= TOL: continue
    # the balance must be unambiguous: no other open order wants the same amount
    rival = sum(1 for x in all_entities
                if x['ref'] not in supersede and x is not e
                and abs((x['total'] - group_paid(x['ref'])) - bal) <= TOL)
    if rival: continue
    pool = [r for r in unlinked_rows()
            if r.get('_date') and days_diff(r['_date'], e['date']) <= SPLIT_WINDOW_DAYS]
    hits = [r for r in pool if abs(r['_amount'] - bal) <= TOL]
    if len(hits) != 1: continue
    relink(hits[0], e, 'BALANCE_MATCH', 'MEDIUM',
           f'Closes {e["ref"]} balance of Rs{bal:,.2f} outstanding after earlier leg(s)')

# ══════════════════════════════════════════════════════════════════════════════
# ROLLUP — per-order across all months
# ══════════════════════════════════════════════════════════════════════════════
groups = defaultdict(list)
for r in rows:
    r['OrderGroup'] = group_of(r['_entity']['ref']) if r['_entity'] else ''
    groups[r['OrderGroup']].append(r)

for gref, legs in groups.items():
    legs.sort(key=lambda r: (r['_date'] or date.min, r['TxnID']))
    if not gref:
        for r in legs:
            r.update({'LegNo':'','Legs':'','GroupTotal':'','PaidToDate':'','Balance':'',
                      'GroupStatus':'UNRECONCILED','Role':'unknown'})
        continue
    entity = entity_by_ref.get(gref)
    total = entity['total'] if entity else 0.0
    paid = sum(r['_amount'] for r in legs)
    bal = total - paid
    months = sorted({r['TxnMonth'] for r in legs if r['TxnMonth']})
    status = 'PAID' if abs(bal) <= TOL else ('PART_PAID' if bal > TOL else 'OVERPAID')
    running = 0.0
    for i, r in enumerate(legs, 1):
        running += r['_amount']
        if len(legs) == 1:
            role = 'full_payment' if status == 'PAID' else ('part_payment' if status == 'PART_PAID' else 'overpayment')
        elif i == len(legs):
            role = 'final_payment' if status == 'PAID' else ('part_payment' if status == 'PART_PAID' else 'overpayment')
        else:
            role = 'advance'
        r.update({
            'LegNo': i, 'Legs': len(legs),
            'GroupTotal': f'{total:.2f}',
            'PaidToDate': f'{running:.2f}',
            'Balance': f'{total - running:.2f}',
            'GroupStatus': status,
            'Role': role,
        })
        if r['OrderRef'] != gref:
            note = f'Paid against {r["OrderRef"]} (superseded by {gref})'
            r['Notes'] = f'{r["Notes"]}; {note}' if r['Notes'] else note
    if len(months) > 1:
        note = f'CROSS-MONTH: legs in {", ".join(months)}'
        for r in legs:
            r['Notes'] = f'{r["Notes"]}; {note}' if r['Notes'] else note

# ══════════════════════════════════════════════════════════════════════════════
# LEDGER — regenerated in full from the store every run
# ══════════════════════════════════════════════════════════════════════════════
COLS = ['OrderGroup','GroupStatus','LegNo','Legs','GroupTotal','PaidToDate','Balance',
        'Source','TxnMonth','TxnDate','SettlDate','TxnID','PaymentMode','Cardholder','CardLast4',
        'Gross','Fee','NetPaid','SettlUTR','OrderRef','OrderTotal','Customer','EntityType',
        'MatchMethod','Confidence','Role','Notes','FirstSeen','LastSeen','SourceFile']

def sort_key(r):
    g = r['OrderGroup']
    if not g: return (1, date.max, '', r['_date'] or date.min, r['TxnID'])
    first = min((x['_date'] or date.min) for x in groups[g])
    return (0, first, g, r['_date'] or date.min, r['TxnID'])

rows.sort(key=sort_key)

def write_csv(path):
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c,'') for c in COLS})

out = LEDGER
try:
    write_csv(out)
except PermissionError:
    out = os.path.join(BASE, f'recon_ledger_{datetime.now():%Y%m%d_%H%M%S}.csv')
    write_csv(out)
    print('  (recon_ledger.csv was locked — wrote a timestamped copy instead)')

# ── Report ───────────────────────────────────────────────────────────────────
print('\n' + '='*140)
for gref in sorted(groups, key=lambda g: (g == '', min((x['_date'] or date.min) for x in groups[g]))):
    legs = groups[gref]
    if not gref:
        continue
    e = entity_by_ref.get(gref)
    head = legs[0]
    print(f'\n{gref}  {head["Customer"]}  total Rs{head["GroupTotal"]}  '
          f'[{head["GroupStatus"]}]  balance Rs{legs[-1]["Balance"]}')
    for r in legs:
        print(f'   {r["TxnMonth"]}  {r["TxnDate"]}  {r["Source"]:<9} Rs{float(r["Gross"]):>12,.2f}  '
              f'{r["Role"]:<14} {r["MatchMethod"]:<15} {r["Confidence"]:<9} {r["Notes"]}')

unl = groups.get('', [])
if unl:
    print(f'\nUNRECONCILED ({len(unl)}):')
    for r in unl:
        print(f'   {r["TxnMonth"]}  {r["TxnDate"]}  {r["Source"]:<9} Rs{float(r["Gross"]):>12,.2f}  '
              f'{r["Cardholder"] or r["CardLast4"]}  — {r["Notes"]}')

print('\n--- SUMMARY ---')
print(f'Transactions in ledger: {len(rows)}  (store spans '
      f'{min((r["TxnMonth"] for r in rows if r["TxnMonth"]), default="?")} .. '
      f'{max((r["TxnMonth"] for r in rows if r["TxnMonth"]), default="?")})')
print('By month:', dict(sorted(Counter(r['TxnMonth'] for r in rows).items())))
print('By method:', dict(Counter(r['MatchMethod'] for r in rows)))
print('By confidence:', dict(Counter(r['Confidence'] for r in rows)))
_gstat = Counter(legs[0]['GroupStatus'] for g, legs in groups.items() if g)
print('Order groups:', dict(_gstat), f'({len([g for g in groups if g])} orders)')
_cross = [g for g, legs in groups.items() if g and len({r['TxnMonth'] for r in legs}) > 1]
print(f'Cross-month orders: {len(_cross)}' + (f' -> {", ".join(sorted(_cross))}' if _cross else ''))
print(f'Matched: {len(rows)-len(unl)}, Unreconciled: {len(unl)}')
print(f'Total Gross: Rs{sum(float(r["Gross"]) for r in rows):,.2f}')
print(f'Total Fee:   Rs{sum(float(r["Fee"]) for r in rows):,.2f}')
print(f'Total Net:   Rs{sum(float(r["NetPaid"]) for r in rows):,.2f}')
print(f'\nStore  -> {STORE}')
print(f'Ledger -> {out}')
