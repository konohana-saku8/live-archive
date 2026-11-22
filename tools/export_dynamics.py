# -*- coding: utf-8 -*-
"""从 live-capture 的 dynamics 表导出主播动态到 site/data/dynamics.json。

默认走 config.toml [capture]：本机 capture 库通常没有动态，真实数据在手机上，
用 ssh 只读查询，不碰手机的 data/。也可以 --db 指定本地 capture.db。

  python tools/export_dynamics.py            # 按配置（手机 ssh）
  python tools/export_dynamics.py --db PATH  # 只读本地库
  python tools/export_dynamics.py --ssh v20 --mid 2094031249

输出幂等：内容没变就不重写文件。
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

COLS = ['dyn_id', 'mid', 'pub_ts', 'dyn_type', 'text',
        'text_trans', 'pics', 'jump_url', 'fetched_at']

REMOTE = '''import sqlite3, json, os
p = os.path.expanduser("~/live-capture/data/capture.db")
c = sqlite3.connect("file:" + p + "?mode=ro", uri=True)
cols = {cols}
sql = "select " + ",".join(cols) + " from dynamics where mid = {mid} order by pub_ts desc"
rows = [dict(zip(cols, r)) for r in c.execute(sql)]
print(json.dumps(rows, ensure_ascii=False))
'''

LOCAL = '''import sqlite3, json
c = sqlite3.connect("file:" + {db!r} + "?mode=ro", uri=True)
cols = {cols!r}
sql = "select " + ",".join(cols) + " from dynamics where mid = {mid} order by pub_ts desc"
rows = [dict(zip(cols, r)) for r in c.execute(sql)]
print(json.dumps(rows, ensure_ascii=False))
'''

# B站动态正文开头常带零宽空格，复制出来会变成看不见的空白
INVISIBLE = re.compile('[\u200b\u200c\u200d\ufeff]')


def clean(s):
    return INVISIBLE.sub('', str(s or '')).strip()


def fetch_rows(ssh, db, mid):
    if ssh:
        # 整段代码用单引号包住给远端 shell；片段里只用双引号，避免引号打架
        code = "python3 -c '" + REMOTE.format(cols=json.dumps(COLS), mid=int(mid)) + "'"
        out = subprocess.check_output(['ssh', ssh, code], text=True)
    else:
        if not db or not os.path.exists(db):
            raise SystemExit('找不到 capture.db：%r（或用 --ssh 指定手机）' % db)
        db = os.path.normpath(db).replace('\\', '/')
        code = LOCAL.format(db=db, cols=COLS, mid=int(mid))
        out = subprocess.check_output([sys.executable, '-c', code], text=True)
    rows = json.loads(out)
    if not isinstance(rows, list):
        raise SystemExit('动态查询返回的不是列表')
    return rows


def normalize(rows):
    items = []
    for r in rows:
        ts = int(r.get('pub_ts') or 0)
        if not ts:
            continue
        dt = datetime.datetime.fromtimestamp(ts)
        pics = r.get('pics') or '[]'
        if isinstance(pics, str):
            try:
                pics = json.loads(pics)
            except (TypeError, ValueError):
                pics = []
        url = clean(r.get('jump_url'))
        if url.startswith('//'):
            url = 'https:' + url
        elif url.startswith('http://'):
            url = 'https://' + url[len('http://'):]
        items.append({
            'id': str(r.get('dyn_id') or ''),
            'ts': ts,
            'date': dt.strftime('%Y-%m-%d'),
            'time': dt.strftime('%H:%M'),
            'month': dt.strftime('%Y-%m'),
            'type': clean(r.get('dyn_type')),
            'jp': clean(r.get('text')),
            'zh': clean(r.get('text_trans')),
            'pics': [p for p in pics if isinstance(p, str) and p] if isinstance(pics, list) else [],
            'url': url,
        })
    items.sort(key=lambda x: x['ts'], reverse=True)
    return items


def main():
    cfg = common.load_config()
    cap = cfg.get('capture', {})
    ap = argparse.ArgumentParser()
    ap.add_argument('--ssh', default=cap.get('ssh') or '', help='远端 ssh 别名，留空读本地库')
    ap.add_argument('--db', default=None, help='本地 capture.db 路径；给了就只读本地库')
    ap.add_argument('--mid', type=int, default=int(cap.get('mid') or 0), help='只导出这位 up 主')
    ap.add_argument('--out', default=os.path.join(cfg['site']['dir'], 'data', 'dynamics.json'))
    args = ap.parse_args()

    if not args.mid:
        raise SystemExit('缺少 mid：在 config.toml [capture] 里填，或传 --mid')
    # 配置了 ssh 就默认读手机；只有显式 --db 才切回本地库（本机库经常是空的）
    use_ssh = bool(args.ssh) and args.db is None
    db = args.db if args.db is not None else (cap.get('db') or '')
    rows = fetch_rows(args.ssh if use_ssh else '', '' if use_ssh else db, args.mid)
    items = normalize(rows)

    text = json.dumps(items, ensure_ascii=False, indent=1) + '\n'
    old = None
    if os.path.exists(args.out):
        with open(args.out, encoding='utf-8') as f:
            old = f.read()
    if old == text:
        print('dynamics: 无变化，%d 条' % len(items))
        return 0
    with open(args.out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    print('dynamics: %d 条 → %s' % (len(items), args.out))
    if items:
        print('范围：%s — %s' % (items[-1]['date'], items[0]['date']))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
