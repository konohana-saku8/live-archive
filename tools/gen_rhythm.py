# -*- coding: utf-8 -*-
"""生成整场节奏页数据：完整逐字稿按时间顺序排列，部分段落挂 SC 引用。

源数据：
  site/data/sessions/<key>.json   逐字稿（已过 ASR / 单行校正）
  site/data/rhythm_links.json     手工指定的「哪些逐字稿在回应哪些 SC」
  site/data/quotes.json           摘录标题（同一段直接沿用）
  枢纽库 sc_message                观众 SC 原文（手机 live-capture 增量拉取后落在本机）

口径（2026-11-28 定稿）：
  - 主线是全部逐字稿，严格按原顺序，一条不重不漏；不因 SC 的时间挪动任何一句；
  - 手工映射里的 lines 可能不连续，按「连续区间」拆成多张卡片，各自留在自己的时间位置，
    同一条 SC 可以在多个区间上作为引用出现；
  - 只有她实际读到／回应的 SC 才作为引用出现；没念到的 SC 不进页面；
  - 没有对应 SC 的逐字稿按连续区间散装；
  - 不读弹幕、不记上屏时间——只保留观众发言与她自己的话；
  - SC 的发出时间只用于排序同一卡内的多条引用，不决定卡片位置。

输出 site/data/rhythm.json；内容没变就不重写。
"""
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

KEY = '2026-11-28_0017'
FREE_GAP = 90            # 秒：散装逐字稿相隔超过这个就另起一张卡


def load_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def sec_of(date_long, t):
    h, m, s = [int(x) for x in t.split(':')]
    dt = datetime.datetime.strptime(date_long.replace('.', '-'), '%Y-%m-%d')
    base = dt.replace(tzinfo=datetime.timezone(datetime.timedelta(hours=8))).timestamp()
    return int(base + h * 3600 + m * 60 + s)


def clip(s, n):
    s = ' '.join(str(s or '').split())
    return s if len(s) <= n else s[:n] + '…'


def runs_of(indices):
    """把任意索引列表拆成连续区间（防止跨时间段被合并挪位）。"""
    out = []
    for i in sorted(set(indices)):
        if out and i == out[-1][-1] + 1:
            out[-1].append(i)
        else:
            out.append([i])
    return out


def main():
    cfg = common.load_config()
    site_dir = cfg['site']['dir']
    sess = load_json(os.path.join(site_dir, 'data', 'sessions', KEY + '.json'))
    recs = sess['records']
    links = load_json(os.path.join(site_dir, 'data', 'rhythm_links.json'))
    quotes = load_json(os.path.join(site_dir, 'data', 'quotes.json'))

    t0 = sec_of(sess['dateLong'], recs[0][0])
    t1 = sec_of(sess['dateLong'], recs[-1][0]) + 1

    import sqlite3
    con = sqlite3.connect('file:%s?mode=ro' % cfg['source']['db'].replace('\\', '/'),
                          uri=True, timeout=10)
    rows = con.execute(
        "SELECT sc_id, uname, price, message, start_time FROM sc_message "
        "WHERE start_time BETWEEN ? AND ? ORDER BY start_time", (t0 - 16, t1)).fetchall()
    con.close()
    scs = {}
    for r in rows:
        scs[str(r[0])] = {
            'id': str(r[0]), 'name': r[1] or '', 'price': int(r[2] or 0),
            'text': r[3] or '', 'start': int(r[4] or 0),
            't': datetime.datetime.fromtimestamp(int(r[4] or 0)).strftime('%H:%M:%S'),
        }

    def line(i):
        r = recs[i]
        return {'i': i, 't': r[0], 'jp': r[1], 'zh': r[2], 'tp': r[3]}

    def quote_title(indices):
        for q in quotes:
            if q.get('session') != KEY or not q.get('sel'):
                continue
            sel = {int(x['i']) for x in q['sel']}
            if sel & indices:
                return q.get('title') or '', q.get('tag') or ''
        return '', ''

    cards = []
    paired = set()
    used_sc = set()
    for p in links.get('pairs', []):
        idxs = [int(i) for i in p['lines'] if 0 <= int(i) < len(recs)]
        ids = [s for s in p.get('sc', []) if s in scs]
        if not idxs:
            continue
        used_sc.update(ids)
        top = None
        if ids:
            top = sorted((scs[s] for s in ids), key=lambda x: x['price'], reverse=True)[0]
        runs = runs_of(idxs)
        for n, run in enumerate(runs):
            paired.update(run)
            lines = [line(i) for i in run]
            qt, qtag = quote_title(set(run))
            title, tag, is_quote = qt, qtag, bool(qt)
            if not title and top:
                title, tag = clip(top['text'], 26) or 'SC 回应', 'SC'
            if not title:
                title, tag = clip(recs[run[0]][2] or recs[run[0]][1], 26) or '现场', '现场'
            if n:  # 同一映射的后续区间：留在自己的时间位置，标「续」
                title += '（续）'
            cards.append({
                'kind': 'reply' if ids else 'free',
                't': sec_of(sess['dateLong'], lines[0]['t']),
                'end': sec_of(sess['dateLong'], lines[-1]['t']),
                'title': title, 'tag': tag, 'note': p.get('note', ''),
                'quote': is_quote,
                'scs': [scs[s] for s in sorted(ids, key=lambda x: scs[x]['start'])],
                'lines': lines,
            })

    # 没被她读到／回应的 SC 不进页面；只有逐字稿的连续区间才散装。

    # 没有对应 SC 的逐字稿：连续区间按时间散装
    free_idx = [i for i in range(len(recs)) if i not in paired]
    chunks = []
    for i in free_idx:
        ts = sec_of(sess['dateLong'], recs[i][0])
        if (not chunks or i != chunks[-1][-1][0] + 1 or
                ts - sec_of(sess['dateLong'], recs[chunks[-1][-1][0]][0]) > FREE_GAP):
            chunks.append([])
        chunks[-1].append((i, ts))
    for ch in chunks:
        lines = [line(i) for i, _ in ch]
        cards.append({
            'kind': 'free', 't': ch[0][1], 'end': ch[-1][1],
            'title': clip(recs[ch[0][0]][2] or recs[ch[0][0]][1], 26) or '现场',
            'tag': '现场', 'note': '', 'quote': False, 'scs': [], 'lines': lines,
        })

    # SC 卡与同时刻的回应卡：SC 在前；逐字稿之间的相对顺序不受影响
    cards.sort(key=lambda c: (c['t'], 0 if c['kind'] == 'sc' else 1,
                              c['lines'][0]['i'] if c['lines'] else -1))
    all_lines = [l['i'] for c in cards for l in c['lines']]
    assert all_lines == list(range(len(recs))), '逐字稿必须按原顺序全量覆盖'
    used_ids = {s['id'] for c in cards for s in c['scs']}
    assert used_ids == used_sc, 'SC 引用必须与映射一致'
    assert used_ids <= set(scs), 'SC id 不在本场库内'

    for n, c in enumerate(cards, 1):
        c['id'] = 'b%d' % n
        c['t'] = datetime.datetime.fromtimestamp(c['t']).strftime('%H:%M:%S')
        c['end'] = datetime.datetime.fromtimestamp(c['end']).strftime('%H:%M:%S')

    out = {
        'session': KEY, 'date': sess['date'], 'title': sess['dateLong'],
        'total': len(recs), 'scCount': len(used_sc), 'beats': cards,
    }
    path = os.path.join(site_dir, 'data', 'rhythm.json')
    text = json.dumps(out, ensure_ascii=False, indent=1) + '\n'
    old = None
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            old = f.read()
    if old == text:
        print('rhythm: 无变化，%d 张卡片' % len(cards))
        return 0
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    n_reply = sum(1 for c in cards if c['kind'] == 'reply')
    print('rhythm: %d 卡片（%d 回应段 / %d 散装逐字稿） / %d 条逐字稿 / %d 条读到的 SC → %s'
          % (len(cards), n_reply, len(cards) - n_reply, len(recs), len(used_sc), path))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
