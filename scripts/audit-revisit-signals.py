#!/usr/bin/env python3
"""Exploratory navigation-domain proxy audit; never a revisit/Home quality score.

Read a consistent, existing Chrome History snapshot, not a live profile. Output
contains aggregate counts/metrics only; no visited URLs, hostnames or embeddings.
Keep output private: aggregate timing and counts can describe personal activity.
"""
import argparse
from pathlib import Path
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from urllib.parse import urlsplit
from collections import Counter, defaultdict
import sqlite3, json, math

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--history-copy', required=True, type=Path)
parser.add_argument('--start', required=True, help='Inclusive local date')
parser.add_argument('--end', required=True, help='Exclusive local date')
parser.add_argument('--timezone', default='UTC')
parser.add_argument('--output', type=Path)
args = parser.parse_args()
TZ = ZoneInfo(args.timezone)
START = datetime.fromisoformat(args.start).replace(tzinfo=TZ)
END = datetime.fromisoformat(args.end).replace(tzinfo=TZ)
if END <= START or (END-START).days % 14:
    parser.error('Use an even number of complete weeks; first half trains, second half evaluates.')
CHROME_EPOCH = 11644473600
snapshot = args.history_copy.resolve(strict=True)
connection = sqlite3.connect(snapshot.as_uri()+'?mode=ro', uri=True)

SQL = '''SELECT v.id,v.visit_time,u.url,v.transition,v.originator_cache_guid,
                COALESCE(s.source,1) AS visit_source
         FROM visits v JOIN urls u ON u.id=v.url
         LEFT JOIN visit_source s ON s.id=v.id
         WHERE v.visit_time>=? AND v.visit_time<?
           AND (v.transition & 255) NOT IN (3,4,8)
           AND (u.url LIKE 'https://%' OR u.url LIKE 'http://%')
         ORDER BY v.visit_time'''
parameters = [int((x.timestamp()+CHROME_EPOCH)*1e6) for x in (START,END)]
integrity = connection.execute('PRAGMA quick_check').fetchone()[0]
if integrity != 'ok':
    raise RuntimeError(f'Invalid history snapshot: {integrity}')
rows = connection.execute(SQL,parameters).fetchall()
connection.close()
source_counts=Counter(); excluded=Counter(); duplicate_ids=0; seen_ids=set(); rows_by_source=defaultdict(list)
for vid, vt, url, transition, origin, source in rows:
    if vid in seen_ids: duplicate_ids+=1; continue
    seen_ids.add(vid)
    remote = bool(origin) or source==0
    source_counts['remote' if remote else 'local']+=1
    parsed=urlsplit(url); host=(parsed.hostname or '').lower().removeprefix('www.')
    if host in ('localhost','127.0.0.1','::1') or host.endswith('.localhost'):
        excluded['loopback']+=1; continue
    if transition & (0x40000000|0x80000000):
        excluded['redirect_flag']+=1; continue
    if source not in (0,1): excluded['other_source']+=1; continue
    dt=datetime.fromtimestamp(vt/1e6-CHROME_EPOCH,timezone.utc).astimezone(TZ)
    # Counts of URL loads are not attention. Each host contributes once per
    # ten-minute interval; occupied intervals are navigation activity proxies.
    rows_by_source['remote' if remote else 'local'].append((dt,host))

start=START; cutoff=START+(END-START)/2
seen=set(); events=[]
for dt,host in rows_by_source['local']:
    key=(dt.date(),dt.hour,dt.minute//10,host)
    if key in seen: continue
    seen.add(key); events.append((dt,host))
training=[x for x in events if x[0]<cutoff]
test=[x for x in events if x[0]>=cutoff]
if not training or not test:
    raise ValueError('Both chronological halves need eligible local observations.')
counts=Counter(host for _,host in training)
labels=sorted(host for host,n in counts.items() if n>=10)+['<other>']
labelset=set(labels)
label=lambda host:host if host in labelset else '<other>'
base=Counter(label(h) for _,h in training)
freq={h:(base[h]+.5)/(len(training)+.5*len(labels)) for h in labels}
byhour=defaultdict(Counter); byday=defaultdict(Counter); byjoint=defaultdict(Counter); byprev=defaultdict(Counter)
previous=None
for dt,host in training:
    h=label(host); byhour[dt.hour][h]+=1; byday[dt.weekday()][h]+=1; byjoint[dt.weekday(),dt.hour][h]+=1
    if previous and (dt-previous[0]).total_seconds()<=1800: byprev[label(previous[1])][h]+=1
    previous=(dt,host)

def probability(c,prior,alpha=50):
    total=sum(c.values())
    return {h:(c[h]+alpha*prior[h])/(total+alpha) for h in labels}
def circular(counter,hour):
    result=Counter()
    for hh in range(24):
        distance=min(abs(hh-hour),24-abs(hh-hour)); weight=math.exp(-.5*(distance/2)**2)
        result.update({h:n*weight for h,n in counter[hh].items()})
    return result
metrics=defaultdict(lambda:{'n':0,'log_loss':0.,'top1':0,'brier':0.,'days':defaultdict(list)})
for dt,host in test:
    actual=label(host)
    clock=probability(circular(byhour,dt.hour),freq)
    weekday=probability(byday[dt.weekday()],freq)
    jointprior={h:(clock[h]+weekday[h])/2 for h in labels}
    jointcounts=defaultdict(Counter,{hh:byjoint[dt.weekday(),hh] for hh in range(24)})
    joint=probability(circular(jointcounts,dt.hour),jointprior)
    prev=label(previous[1]) if previous and (dt-previous[0]).total_seconds()<=1800 else None
    sequence=probability(byprev[prev],freq) if prev else freq
    models={'frequency':freq,'time-of-day':clock,'weekday':weekday,'weekday-and-time':joint,'previous-domain':sequence}
    for name,ps in models.items():
        m=metrics[name]; loss=-math.log(ps[actual]); m['n']+=1; m['log_loss']+=loss
        m['brier']+=sum((p-(h==actual))**2 for h,p in ps.items())
        m['top1']+=max(ps,key=ps.get)==actual; m['days'][dt.date().isoformat()].append(loss)
    previous=(dt,host)
result={'label':'domain at an observed navigation opportunity; NOT qualified revisit or Home utility',
 'training_start':start.isoformat(),'training_end_exclusive':cutoff.isoformat(),'test_end_exclusive':END.isoformat(),
 'training_events':len(training),'test_events':len(test),'domain_classes':len(labels),
 'method':'First visit to each external domain per 10-minute bin, local-only. Frozen first-half counts. Circular Gaussian hour kernel sigma=2h; smoothing 50 global pseudo-observations; unseen/rare training domains grouped as other. Previous-domain context only within 30 minutes. No tuning on the held-out second half.',
 'models':{name:{'n':m['n'],'log_loss':m['log_loss']/m['n'],'top1':m['top1']/m['n'],'brier':m['brier']/m['n']} for name,m in metrics.items()}}
for name,m in metrics.items():
    wins=0; days=0
    for d,values in m['days'].items():
        days+=1; wins+=sum(values)<sum(metrics['frequency']['days'][d])
    result['models'][name]['days_with_lower_log_loss_than_frequency']=wins
    result['models'][name]['evaluated_days']=days
assert all(m['n']==len(test) for m in result['models'].values())
assert abs(sum(freq.values())-1)<1e-9
result['timezone'] = str(TZ)
result['data_quality'] = {
    'database_integrity': integrity,
    'eligible_navigation_rows_before_exclusions': len(rows),
    'source_counts_before_exclusions': dict(source_counts),
    'exclusions': dict(excluded),
    'duplicate_visit_ids': duplicate_ids,
    'local_external_navigation_rows': len(rows_by_source['local']),
    'local_days_with_navigation': len({dt.date() for dt, _ in rows_by_source['local']}),
    'local_occupied_10m_slots': len({(dt.date(), dt.hour, dt.minute//10) for dt, _ in rows_by_source['local']})
}
encoded = json.dumps(result, indent=2) + '\n'
if args.output:
    args.output.write_text(encoded)
else:
    print(encoded, end='')
