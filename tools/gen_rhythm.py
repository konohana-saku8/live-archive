# -*- coding: utf-8 -*-
"""把整场逐字稿按「观众发言 → 她的回应」生成节奏页数据。

源数据：
  site/data/sessions/<key>.json   逐字稿（已过 ASR / 单行校正）
  site/data/rhythm_links.json     手工指定的 SC → 回应逐字稿关系
  site/data/quotes.json           摘录标题（同一段直接沿用）
  枢纽库 sc_message                观众 SC 原文（手机 live-capture 增量拉取后落在本机）

口径：
  - 只处理配置里指定的那一场（默认 2026-11-28_0017），不扫全库；
  - 有对应关系的 SC 与逐字稿合成一张 reply 卡片，她的回应缩进成跟帖；
  - 没有对应的 SC 与逐字稿按时间顺序散装成 sc / free 卡片；
  - 逐字稿全量纳入，每条只出现一次；SC 也只出现一次（配对或散装）；
  - 不读弹幕、不记上屏时间——只保留观众发言与她自己的话。

输出 site/data/rhythm.json；内容没变就不重写。
"""
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

KEY = '2026-11-28_0017'
SC_GAP = 30              # 秒：散装 SC 相隔不超过这个就合并成一张卡
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
        idxs = sorted({int(i) for i in p['lines'] if 0 <= int(i) < len(recs)})
        if not idxs:
            continue
        ids = [s for s in p.get('sc', []) if s in scs]
        paired.update(idxs)
        used_sc.update(ids)
        title = p.get('title') or ''
        tag = p.get('tag') or ''
        if not title:
            title, tag = quote_title(set(idxs))
        if not title and ids:
            top = sorted((scs[s] for s in ids), key=lambda x: x['price'], reverse=True)[0]
            title, tag = clip(top['text'], 26) or 'SC 回应', 'SC'
        if not title:
            title, tag = clip(recs[idxs[0]][2] or recs[idxs[0]][1], 26) or '现场', '现场'
        lines = [line(i) for i in idxs]
        times = [sec_of(sess['dateLong'], x['t']) for x in lines]
        times += [scs[s]['start'] for s in ids]
        cards.append({
            'kind': 'reply' if ids else 'free',
            't': min(times), 'end': max(times),
            'title': title, 'tag': tag, 'note': p.get('note', ''),
            'scs': [scs[s] for s in sorted(ids, key=lambda x: scs[x]['start'])],
            'lines': lines,
        })

    # 没有对应的 SC：时间相近的合并成一张散装卡片
    loose = [s for s in scs.values() if s['id'] not in used_sc]
    clusters = []
    for s in loose:
        if not clusters or s['start'] - clusters[-1][-1]['start'] > SC_GAP:
            clusters.append([])
        clusters[-1].append(s)
    for cl in clusters:
        cards.append({
            'kind': 'sc', 't': cl[0]['start'], 'end': cl[-1]['start'],
            'title': clip(cl[0]['text'], 26) or '观众留言', 'tag': 'SC', 'note': '',
            'scs': cl, 'lines': [],
        })

    # 没有对应的逐字稿：连续段按时间散装
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
            'tag': '现场', 'note': '', 'scs': [], 'lines': lines,
        })

    cards.sort(key=lambda c: (c['t'], c['kind'] != 'reply'))
    for n, c in enumerate(cards, 1):
        c['id'] = 'b%d' % n
        c['t'] = datetime.datetime.fromtimestamp(c['t']).strftime('%H:%M:%S')
        c['end'] = datetime.datetime.fromtimestamp(c['end']).strftime('%H:%M:%S')

    out = {
        'session': KEY, 'date': sess['date'], 'title': sess['dateLong'],
        'total': len(recs), 'scCount': len(scs), 'beats': cards,
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
    n_sc = sum(1 for c in cards if c['kind'] == 'sc')
    print('rhythm: %d 卡片（%d 回应 / %d 散装 SC / %d 散装逐字稿） / %d 条逐字稿 / %d 条 SC → %s'
          % (len(cards), n_reply, n_sc, len(cards) - n_reply - n_sc,
             len(recs), len(scs), path))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
