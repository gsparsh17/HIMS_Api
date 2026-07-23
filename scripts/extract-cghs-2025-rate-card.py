#!/usr/bin/env python3
"""Extract the official 03-Oct-2025 CGHS Annexure-I tariff into import-ready files.

The extractor intentionally keeps the source row/page metadata and does not map
external CGHS codes to local HIMS service IDs. Finance/master-data users must
review and approve those mappings before activation.
"""
from __future__ import annotations
import argparse, csv, hashlib, json, re, subprocess
from pathlib import Path

ROW = re.compile(r'^\s*(\d+)\s+([A-Z]{1,5}[0-9]{3,5})\s+(.*?)\s+([0-9][0-9,.]*)\s+([0-9][0-9,.]*)\s+([0-9][0-9,.]*)\s+([A-Za-z].*?)\s*$')
TIER_MARKERS = {
    'I': ('CGHS rates for Tier I (X City)', 'B) Rate list for Semiprivate'),
    'II': ('CGHS rates for Tier II (Y City)', 'C) Rate list for Semiprivate'),
    'III': ('CGHS rates for Tier III (Z City)', None),
}
NOISE = re.compile(r'(5-16/CGHS|I/3807087/2025|CGHS rates for Tier|Rates for Semi|CGHS TREATMENT|Speciality Classification|\bNABH\b|^Sr\.|^No\b|^Code\b|^Ward$|^Non-$|^Super$|^Speciality$)', re.I)

def number(value: str) -> float | int:
    value = value.replace(',', '').strip()
    n = float(value)
    return int(n) if n.is_integer() else n

def clean_pending(lines: list[str]) -> str:
    parts=[]
    for line in lines:
        text=' '.join(line.replace('\f',' ').split())
        if not text or text.isdigit() or NOISE.search(text):
            continue
        # Table continuation text starts in the description column. Avoid prose outside the tariff table.
        if len(line) - len(line.lstrip()) < 12:
            continue
        parts.append(text)
    return ' '.join(parts)

def parse_tier(text: str, tier: str) -> list[dict]:
    start_marker, end_marker = TIER_MARKERS[tier]
    start=text.find(start_marker)
    if start < 0: raise RuntimeError(f'Missing {start_marker}')
    end=text.find(end_marker, start) if end_marker else len(text)
    section=text[start:end]
    rows=[]; pending=[]; page=0
    for raw in section.splitlines():
        if raw.startswith('\f'):
            page += 1
        match=ROW.match(raw)
        if not match:
            pending.append(raw)
            continue
        serial, code, current, non_nabh, nabh, super_speciality, specialty=match.groups()
        prefix=clean_pending(pending[-6:])
        description=' '.join(part for part in (prefix, ' '.join(current.split())) if part).strip()
        rows.append({
            'serialNumber': int(serial), 'externalCode': code, 'externalName': description,
            'nonNabh': number(non_nabh), 'nabh': number(nabh), 'superSpeciality': number(super_speciality),
            'specialty': ' '.join(specialty.split()), 'sourcePageApprox': page + 7,
        })
        pending=[]
    if len(rows) != 1998 or rows[-1]['serialNumber'] != 1998:
        raise RuntimeError(f'Tier {tier}: expected 1998 rows, extracted {len(rows)}')
    return rows

def service_type(specialty: str, name: str) -> str:
    text=f'{specialty} {name}'.lower()
    if 'consultation' in text: return 'consultation'
    if 'laboratory' in text or 'pathology' in text or 'blood bank' in text: return 'laboratory'
    if any(k in text for k in ('radiology','imaging','x-ray','x ray','ultrasound','mri','ct scan','pet scan','mammography','doppler')): return 'radiology'
    if any(k in text for k in ('bed charge','room rent','ward charge','icu charge','nursing care')): return 'bed'
    if any(k in text for k in ('equipment','ventilator','monitoring charge')): return 'equipment'
    if 'operation theatre' in text or specialty.lower() == 'ot charges': return 'ot'
    return 'procedure'

def package_days(specialty: str, name: str) -> int | None:
    text=f'{specialty} {name}'.lower()
    if 'day care' in text or 'minor' in text: return 1
    if 'laparoscop' in text or 'angioplasty' in text or 'normal delivery' in text: return 3
    if any(k in text for k in ('cardiothoracic','neurosurgery','neuro surgery','transplant','super speciality','super specialty')): return 12
    if any(k in text for k in ('surgery','replacement','repair','excision','resection','operation')): return 7
    return None

def main() -> None:
    parser=argparse.ArgumentParser()
    parser.add_argument('pdf', type=Path)
    parser.add_argument('--output-dir', type=Path, default=Path('data'))
    args=parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    txt=args.output_dir/'cghs-2025-source.txt'
    subprocess.run(['pdftotext','-layout',str(args.pdf),str(txt)],check=True)
    text=txt.read_text(errors='replace')
    by_tier={tier: parse_tier(text,tier) for tier in TIER_MARKERS}
    rows=[]
    for index, base in enumerate(by_tier['I']):
        code=base['externalCode']
        related={tier: by_tier[tier][index] for tier in ('I','II','III')}
        if any(row['externalCode'] != code for row in related.values()):
            raise RuntimeError(f'Tier code mismatch around {code}')
        st=service_type(base['specialty'],base['externalName'])
        ward_uniform=st in {'consultation','laboratory','radiology'} or any(k in f"{base['specialty']} {base['externalName']}".lower() for k in ('radiotherapy','day care','minor procedure'))
        rows.append({
            'externalCode': code, 'externalName': base['externalName'], 'serviceType': st,
            'specialty': base['specialty'], 'category': base['specialty'],
            'rates': {
                'tierI': {k: related['I'][k] for k in ('nonNabh','nabh','superSpeciality')},
                'tierII': {k: related['II'][k] for k in ('nonNabh','nabh','superSpeciality')},
                'tierIII': {k: related['III'][k] for k in ('nonNabh','nabh','superSpeciality')},
            },
            'packagePeriodDays': package_days(base['specialty'],base['externalName']),
            'wardUniform': ward_uniform,
            'internalService': {'mappingStatus': 'unmapped'},
            'sourceRow': {'page': base['sourcePageApprox'], 'serialNumber': base['serialNumber']},
        })
    checksum=hashlib.sha256(args.pdf.read_bytes()).hexdigest()
    payload={
        'source': {'title':'CGHS Office Memorandum 03.10.2025','filename':args.pdf.name,'sha256':checksum,'issueDate':'2025-10-03','effectiveFrom':'2025-10-13','annexure':'Annexure I'},
        'rules': {'baseWard':'semi_private','wardFactors':{'general':0.95,'semi_private':1.0,'private':1.05},'accreditationFactors':{'non_nabh_non_nabl':0.85,'nabh_nabl':1.0,'super_speciality':1.15},'cityTierFactors':{'I':1.0,'II':0.9,'III':0.8},'sameOtSession':[1.0,0.5,0.25],'bilateralSecondFactor':0.5,'withinPackagePeriodFactor':0.75,'wardUniformCategories':['consultation','radiotherapy','investigation','day_care','minor_no_admission'],'packagePeriods':{'super_speciality':12,'major_surgery':7,'laparoscopic_angioplasty_normal_delivery':3,'day_care_minor':1}},
        'itemCount': len(rows), 'items': rows,
    }
    (args.output_dir/'cghs-2025-rate-items.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2))
    with (args.output_dir/'cghs-2025-rate-items.csv').open('w',newline='',encoding='utf-8') as handle:
        writer=csv.writer(handle)
        writer.writerow(['serial','code','name','service_type','specialty','tier1_non_nabh','tier1_nabh','tier1_super','tier2_non_nabh','tier2_nabh','tier2_super','tier3_non_nabh','tier3_nabh','tier3_super','package_period_days','ward_uniform','source_page'])
        for row in rows:
            r=row['rates']; writer.writerow([row['sourceRow']['serialNumber'],row['externalCode'],row['externalName'],row['serviceType'],row['specialty'],r['tierI']['nonNabh'],r['tierI']['nabh'],r['tierI']['superSpeciality'],r['tierII']['nonNabh'],r['tierII']['nabh'],r['tierII']['superSpeciality'],r['tierIII']['nonNabh'],r['tierIII']['nabh'],r['tierIII']['superSpeciality'],row['packagePeriodDays'],row['wardUniform'],row['sourceRow']['page']])
    print(f'Extracted {len(rows)} official CGHS items; sha256={checksum}')

if __name__ == '__main__': main()
