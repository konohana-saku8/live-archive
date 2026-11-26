# -*- coding: utf-8 -*-
"""把 overrides.json 里已校对的逐字稿回写 TranslationHistory。

默认写 SourceText + TranslatedText；--translation-only 只写译文。
只处理 --since / --until 指定范围内的场次，默认不碰更早的库。

安全措施：
  - 写前用 SQLite backup() 备份到 .data/backups/
  - 只改 orig 与当前「导出态」一致的条目，不一致的跳过并报告
  - 单事务写入，任何一行失败整体回滚
  - 直播可能仍在进行时拒绝执行（最后一条记录静默不足 quiet_min）

用法：
  python tools/writeback_overrides.py --since 2026-11-13 --dry-run
  python tools/writeback_overrides.py --since 2026-11-13
  python tools/writeback_overrides.py --since 2026-11-13 --translation-only
"""
import argparse
import datetime
import json
import os
import sqlite3
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
import asr_fixes
import overrides
import time_fixes

ROOT = common.ROOT
STATE = os.path.join(ROOT, '.state')


def _ro_uri(path):
    return 'file:%s?mode=ro' % path.replace('\\', '/')


def load_rows(db_path):
    con = sqlite3.connect(_ro_uri(db_path), uri=True, timeout=10)
    try:
        cur = con.cursor()
        cur.execute('SELECT Id, Timestamp, SourceText, TranslatedText '
                    'FROM TranslationHistory ORDER BY CAST(Timestamp AS INTEGER)')
        rows = []
        for rid, ts, src, tr in cur.fetchall():
            raw = int(ts)
            rows.append({
                'id': rid,
                'raw': raw,
                'ts': time_fixes.apply(raw),
                'src': (src or '').strip(),
                'tr': common.clean_translation(tr),
            })
        return rows
    finally:
        con.close()


def group_sessions(rows, cfg):
    gap = cfg['source']['session_gap_min'] * 60
    minr = cfg['source']['min_records']
    groups, cur = [], []
    for r in rows:
        if cur and r['ts'] - cur[-1]['ts'] > gap:
            if len(cur) >= minr:
                groups.append({'start': cur[0]['ts'], 'end': cur[-1]['ts'], 'recs': cur})
            cur = []
        cur.append(r)
    if len(cur) >= minr:
        groups.append({'start': cur[0]['ts'], 'end': cur[-1]['ts'], 'recs': cur})
    kept, _ = common.filter_sessions(
        groups, cfg['source'].get('time_window', ''),
        cfg['source'].get('time_window_keep') or [])
    return kept


def key_map(group):
    seen, out = {}, {}
    for r in group['recs']:
        t = datetime.datetime.fromtimestamp(r['ts']).strftime('%H:%M:%S')
        n = seen.get(t, 0)
        seen[t] = n + 1
        out['%s#%d' % (t, n)] = r
    return out


def backup_db(db_path):
    d = os.path.join(os.path.dirname(db_path), 'backups')
    os.makedirs(d, exist_ok=True)
    dst_path = os.path.join(
        d, 'translation_history-%s.db' % datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    src = sqlite3.connect(_ro_uri(db_path), uri=True, timeout=10)
    dst = sqlite3.connect(dst_path)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return dst_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--config')
    ap.add_argument('--since', default='', help='只处理开播日期 >= YYYY-MM-DD 的场次')
    ap.add_argument('--until', default='', help='只处理开播日期 <= YYYY-MM-DD 的场次')
    ap.add_argument('--translation-only', action='store_true', help='只回写 TranslatedText')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--force', action='store_true', help='忽略「可能还在直播」的判断')
    args = ap.parse_args()

    cfg = common.load_config(args.config)
    db = cfg['source']['db']
    if not os.path.exists(db):
        print('找不到数据库：%s' % db, file=sys.stderr)
        return 1
    rows = load_rows(db)
    if not rows:
        print('数据库为空')
        return 0
    quiet = (time.time() - rows[-1]['raw']) / 60
    if quiet < cfg['source']['quiet_min'] and not args.force:
        print('最后一条记录在 %.0f 分钟前，直播可能还在进行；确认已结束请加 --force' % quiet)
        return 1

    sessions = group_sessions(rows, cfg)
    smap = {datetime.datetime.fromtimestamp(s['start']).strftime('%Y-%m-%d_%H%M'): s
            for s in sessions}
    all_ov = overrides.load()

    wanted = {}
    for name, es in all_ov.items():
        d = name[:10]
        if args.since and d < args.since:
            continue
        if args.until and d > args.until:
            continue
        wanted[name] = es

    plan, skips = [], []
    for name in sorted(wanted):
        es = wanted[name]
        g = smap.get(name)
        if not g:
            skips.append({'session': name, 'key': '*', 'why': '当前库切不出这场（时间窗/切场参数？）'})
            continue
        km = key_map(g)
        for k, o in es.items():
            r = km.get(k)
            if not r:
                skips.append({'session': name, 'key': k, 'why': '场次里没有这个时间戳#序号'})
                continue
            exp_src = asr_fixes.apply(r['src'])
            exp_tr = asr_fixes.apply(r['tr'])
            orig = o.get('orig') or {}
            if orig.get('jp') != exp_src or orig.get('zh') != exp_tr:
                skips.append({'session': name, 'key': k, 'why': 'orig 与当前库不一致（可能已改过或库变了）'})
                continue
            jp = (o.get('jp') or '').strip()
            zh = (o.get('zh') or '').strip()
            if not jp or not zh:
                skips.append({'session': name, 'key': k, 'why': '修正后的 jp/zh 为空'})
                continue
            plan.append({
                'session': name, 'key': k, 'id': r['id'],
                'old_jp': r['src'], 'old_zh': r['tr'],
                'new_jp': jp, 'new_zh': zh,
                'src_idem': asr_fixes.apply(jp) == jp,
                'tr_idem': asr_fixes.apply(zh) == zh,
            })

    by_date = Counter(p['session'][:10] for p in plan)
    print('范围 %s ~ %s · 场次 %d · 可回写 %d 行 · 跳过 %d 行'
          % (args.since or '-', args.until or '-', len(wanted), len(plan), len(skips)))
    for d in sorted(by_date):
        print('  %s  %d 行' % (d, by_date[d]))
    warn = [p for p in plan if not p['src_idem'] or not p['tr_idem']]
    if warn:
        print('注意：%d 行回写后会再被 asr_fixes 改写；页面仍以 overrides 为准' % len(warn))
    for s in skips[:30]:
        print('  跳过 %s %s：%s' % (s['session'], s['key'], s['why']))
    if len(skips) > 30:
        print('  … 其余 %d 行跳过' % (len(skips) - 30))
    for p in plan[:5]:
        print('  %s %s  Id=%s' % (p['session'], p['key'], p['id']))
        print('    JP %s\n    -> %s' % (p['old_jp'], p['new_jp']))
        print('    ZH %s\n    -> %s' % (p['old_zh'], p['new_zh']))

    if args.dry_run:
        print('DRY RUN：未备份、未写库')
        return 0
    if not plan:
        print('没有可回写的行')
        return 0

    bak = backup_db(db)
    print('已备份数据库：%s' % bak)

    con = sqlite3.connect(db, timeout=10)
    try:
        con.execute('PRAGMA busy_timeout=10000')
        con.execute('BEGIN IMMEDIATE')
        cols = 'TranslatedText=?, SourceText=?' if not args.translation_only else 'TranslatedText=?'
        for p in plan:
            if args.translation_only:
                cur = con.execute('UPDATE TranslationHistory SET %s WHERE Id=?' % cols,
                                  (p['new_zh'], p['id']))
            else:
                cur = con.execute('UPDATE TranslationHistory SET %s WHERE Id=?' % cols,
                                  (p['new_zh'], p['new_jp'], p['id']))
            if cur.rowcount != 1:
                raise RuntimeError('Id %s 更新行数 %d' % (p['id'], cur.rowcount))
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()

    os.makedirs(STATE, exist_ok=True)
    log_path = os.path.join(
        STATE, 'writeback-overrides-%s.json' % datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    with open(log_path, 'w', encoding='utf-8') as f:
        json.dump({'args': vars(args), 'backup': bak, 'written': plan, 'skipped': skips,
                   'at': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')},
                  f, ensure_ascii=False, indent=1)
    print('已回写 %d 行（%s）；日志 %s'
          % (len(plan), '仅译文' if args.translation_only else '原文+译文', log_path))
    print('overrides.json 未改动；重建站点前再跑一次 export.py 即可。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
