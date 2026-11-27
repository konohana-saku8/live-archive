# -*- coding: utf-8 -*-
"""把整场逐字稿按「观众发言 → 她的回应」切节拍，生成节奏页数据。

源数据：
  site/data/sessions/<key>.json   逐字稿（已过 ASR / 单行校正）
  site/data/quotes.json           11-28 摘录的标题与选段，用来给节拍命名
  枢纽库 sc_message / danmaku      观众原文（手机 live-capture 增量拉取后落在本机）

口径：
  - 只处理配置里指定的那一场（默认 2026-11-28_0017），不扫全库；
  - 逐字稿按时间顺序全量纳入，每条只出现一次，节拍之间没有空隙；
  - 节拍边界取 SC 聚簇的间隙（有意义的 SC 相隔 30 秒以上就换段），
    这样同一波 SC 和她的回应留在同一张卡片里；
  - 每段带齐该时段的 SC、弹幕和逐字稿；逐字稿行上再记当时在屏的 SC 与
    同期弹幕在段内列表里的下标，前端可以逐句展开，做到一一对应。

输出 site/data/rhythm.json；内容没变就不重写。
"""
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

KEY = '2026-11-28_0017'
SC_CLUSTER_GAP = 30          # 秒：超过这个间隔就另起一个节拍
DM_WINDOW = 2                # 秒：一条逐字稿前后各取几秒的弹幕算「同期」
FILLERS = ('えっと', 'あのー', 'あ、', 'んー', 'うーん', 'まあ', 'ちょっと待って', '何の話')


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


def beats_from_scs(scs, t0, t1):
    """按有意义 SC 的间隔聚簇，返回 [(start, end), ...] 覆盖整个场次。"""
    marks = []
    for sc in scs:
        msg = (sc['text'] or '').strip()
        if (sc['price'] or 0) >= 30 or len(msg) >= 4:
            marks.append(sc['start'])
    if not marks:
        return [(t0, t1)]
    clusters = [[marks[0]]]
    for st in marks[1:]:
        if st - clusters[-1][-1] > SC_CLUSTER_GAP:
            clusters.append([])
        clusters[-1].append(st)

    cuts = [t0]
    for prev, cur in zip(clusters, clusters[1:]):
        cuts.append((prev[-1] + cur[0]) // 2)
    cuts.append(t1 + 1)
    return [(a, b) for a, b in zip(cuts, cuts[1:]) if b > a]


def main():
    cfg = common.load_config()
    site_dir = cfg['site']['dir']
    sess_path = os.path.join(site_dir, 'data', 'sessions', KEY + '.json')
    sess = load_json(sess_path)
    recs = sess['records']
    quotes = load_json(os.path.join(site_dir, 'data', 'quotes.json'))

    t0 = sec_of(sess['dateLong'], recs[0][0])
    t1 = sec_of(sess['dateLong'], recs[-1][0]) + 1

    import sqlite3
    con = sqlite3.connect('file:%s?mode=ro' % cfg['source']['db'].replace('\\', '/'),
                          uri=True, timeout=10)
    # 口径与当天导出的 SC 清单一致：00:17:00 起到下播，开播前更早的散条不计
    rows = con.execute(
        "SELECT sc_id, uname, price, message, start_time, end_time FROM sc_message "
        "WHERE start_time BETWEEN ? AND ? ORDER BY start_time", (t0 - 16, t1)).fetchall()
    sc_all = [{
        'id': str(r[0]), 'name': r[1] or '', 'price': int(r[2] or 0), 'text': r[3] or '',
        'start': int(r[4] or 0), 'end': int(r[5] or 0),
        't': datetime.datetime.fromtimestamp(int(r[4] or 0)).strftime('%H:%M:%S'),
    } for r in rows]
    rows = con.execute(
        "SELECT uname, text, event_time FROM danmaku WHERE event_time BETWEEN ? AND ? "
        "ORDER BY event_time, received_at", (t0, t1)).fetchall()
    dm_all = [{
        'name': r[0] or '', 'text': r[1] or '', 't': int(r[2] or 0),
        'hms': datetime.datetime.fromtimestamp(int(r[2] or 0)).strftime('%H:%M:%S'),
    } for r in rows]
    con.close()

    spans = beats_from_scs(sc_all, t0, t1)
    # 逐字稿按时间落进节拍；空段并掉，避免卡片没有正文
    grouped = [[] for _ in spans]
    for i, r in enumerate(recs):
        ts = sec_of(sess['dateLong'], r[0])
        for bi, (a, b) in enumerate(spans):
            if a <= ts < b:
                grouped[bi].append(i)
                break
        else:
            grouped[-1].append(i)
    kept = [bi for bi, g in enumerate(grouped) if g]
    assert sum(len(grouped[bi]) for bi in kept) == len(recs), '逐字稿有遗漏'

    # 摘录标题优先：用第一条选段所在节拍给这张卡片命名
    titles = {}
    for q in quotes:
        if q.get('session') != KEY or not q.get('sel'):
            continue
        anchor = min(int(x['i']) for x in q['sel'])
        for bi in kept:
            if grouped[bi][0] <= anchor <= grouped[bi][-1]:
                titles.setdefault(bi, (q['title'], q['tag']))
                break

    beats = []
    for bi in kept:
        idxs = grouped[bi]
        a, b = spans[bi]
        # 开播瞬间前发、开场即被读到的 SC 并进第一段，别让它在页面上消失
        if bi == kept[0]:
            a = min([a] + [x['start'] for x in sc_all if x['start'] < a])
        scs = [dict(x) for x in sc_all if a <= x['start'] < b]
        dms = [dict(x) for x in dm_all if a <= x['t'] < b]
        # 段内弹幕按下标建时间索引，逐句取同期窗口
        dm_times = [x['t'] for x in dms]

        def near(ts):
            lo, hi = ts - DM_WINDOW, ts + DM_WINDOW
            left = 0
            while left < len(dm_times) and dm_times[left] < lo:
                left += 1
            right = left
            while right < len(dm_times) and dm_times[right] <= hi:
                right += 1
            return list(range(left, min(right, left + 40)))

        lines = []
        for i in idxs:
            r = recs[i]
            ts = sec_of(sess['dateLong'], r[0])
            on = [x for x in scs if x['start'] <= ts <= (x['end'] or x['start'] + 5)]
            on.sort(key=lambda x: x['price'], reverse=True)
            lines.append({
                'i': i, 't': r[0], 'jp': r[1], 'zh': r[2], 'tp': r[3],
                'sc': on[0]['id'] if on else None,
                'dmi': near(ts),
            })

        if bi in titles:
            title, tag = titles[bi]
        elif scs:
            top = sorted(scs, key=lambda x: x['price'], reverse=True)[0]
            title, tag = clip(top['text'], 26) or 'SC 回应', '现场'
        else:
            first = next((x[2] for x in (recs[i] for i in idxs) if x[2] and not any(
                f in x[1] for f in FILLERS)), recs[idxs[0]][2])
            title, tag = clip(first, 26) or '自由谈', '现场'

        beats.append({
            'id': 'b%d' % (len(beats) + 1),
            't': recs[idxs[0]][0], 'end': recs[idxs[-1]][0],
            'title': title, 'tag': tag,
            'scs': scs, 'dms': dms, 'lines': lines,
        })

    out = {
        'session': KEY, 'date': sess['date'], 'title': sess['dateLong'],
        'total': len(recs), 'scCount': len(sc_all), 'dmCount': len(dm_all),
        'beats': beats,
    }
    path = os.path.join(site_dir, 'data', 'rhythm.json')
    text = json.dumps(out, ensure_ascii=False, indent=1) + '\n'
    old = None
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            old = f.read()
    if old == text:
        print('rhythm: 无变化，%d 个节拍' % len(beats))
        return 0
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    print('rhythm: %d 节拍 / %d 条逐字稿 / %d 条 SC / %d 条弹幕 → %s'
          % (len(beats), len(recs), len(sc_all), len(dm_all), path))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
