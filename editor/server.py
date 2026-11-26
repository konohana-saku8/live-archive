# -*- coding: utf-8 -*-
"""火羽直播档案 · 本地编辑器后端（只用标准库）

启动：python editor/server.py [端口，默认 8765]
只在本机监听 127.0.0.1，不联网。DB 只读；写入只用原子替换 + 备份。

写回的东西：
  site/data/quotes.json   摘录（含 sel / tags）
  site/data/tags.json     tag 注册表
  tools/fixes_data.json   编辑器新增的全局修正

不改原始 DB、不改 .build / dist（由重建命令产出）。
"""
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asr_fixes  # noqa: E402  （加载时已读入 fixes_data.json）
import overrides  # noqa: E402  单行覆盖的键规则与导出共用
import pull as pull_mod  # noqa: E402

DATA = os.path.join(ROOT, 'site', 'data')
SESS_DIR = os.path.join(DATA, 'sessions')
QUOTES = os.path.join(DATA, 'quotes.json')
TAGS = os.path.join(DATA, 'tags.json')
OVERRIDES = os.path.join(DATA, 'overrides.json')
FIXES = os.path.join(ROOT, 'tools', 'fixes_data.json')
BACKUP = os.path.join(ROOT, '.state', 'editor-backups')
CONF = os.path.join(ROOT, 'config.toml')
DB = os.environ.get('LC_DB') or os.path.join(ROOT, '.data', 'translation_history.db')


# ---------- 基础读写 ----------

def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def save_json(path, obj, backup=True):
    """原子写：先备份旧文件，再 temp + replace，保持 indent=1 / LF。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if backup and os.path.exists(path):
        os.makedirs(BACKUP, exist_ok=True)
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        name = os.path.basename(path)
        shutil.copy2(path, os.path.join(BACKUP, '%s.%s' % (stamp, name)))
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write('\n')
    os.replace(tmp, path)


def sessions():
    out = []
    for fn in sorted(os.listdir(SESS_DIR)):
        if not fn.endswith('.json'):
            continue
        s = load_json(os.path.join(SESS_DIR, fn), {})
        s['_key'] = fn[:-5]
        out.append(s)
    return out


def tag_names():
    reg = load_json(TAGS, [])
    if reg:
        return [t if isinstance(t, str) else t.get('name', '') for t in reg if t]
    names = []
    for q in load_json(QUOTES, []):
        for t in (q.get('tags') or ([q['tag']] if q.get('tag') else [])):
            if t not in names:
                names.append(t)
    return names


def session_records(key, raw=False):
    """逐字稿行 = records 的下标，编辑器勾选时就存这个下标。

    默认返回套过单行覆盖的文本（编辑器看到的就是导出后的样子）；
    raw=True 取文件原样，写覆盖时用它当 orig 和键序基准。
    """
    s = load_json(os.path.join(SESS_DIR, key + '.json'), {})
    recs = s.get('records', [])
    if raw:
        return recs
    ov = overrides_file().get(key) or {}
    if not ov:
        return recs
    out = [list(r) for r in recs]
    for k, r in zip(overrides.keys([x[0] for x in out]), out):
        o = ov.get(k)
        if o:
            r[1] = o.get('jp', r[1])
            r[2] = o.get('zh', r[2])
    return out


def overrides_file():
    """读 site/data/overrides.json，按 mtime 缓存（导出与编辑器都读这一份）。"""
    try:
        m = os.path.getmtime(OVERRIDES)
    except OSError:
        _ov_cache[0] = None
        _ov_cache[1] = {}
        return {}
    if _ov_cache[0] != m:
        _ov_cache[0] = m
        _ov_cache[1] = load_json(OVERRIDES, {})
    return _ov_cache[1]


_ov_cache = [None, {}]


def override_index(key):
    """{行下标: 覆盖记录}，给前端标「已改」和回填表单。"""
    ov = overrides_file().get(key) or {}
    if not ov:
        return {}
    recs = session_records(key, raw=True)
    return {i: ov[k] for i, k in enumerate(overrides.keys([r[0] for r in recs])) if k in ov}


def _draft_sel(q, recs):
    """老条目没有 sel：按首行时间戳定位，再按 jp 行数往后延伸。
    只用于载入时把勾选画出来，不写回文件；保存时才落成真正的 sel。"""
    t = q.get('t') or ''
    idx = next((i for i, r in enumerate(recs) if r[0] == t), None)
    if idx is None:
        return []
    n = max(1, len((q.get('jp') or '').split('\n')))
    return [{'i': idx + k, 't': recs[idx + k][0]}
            for k in range(n) if idx + k < len(recs)]


def quotes_for(key):
    """该场已有的摘录。新条目按 session 匹配；老条目只有 date+t，按场次时间窗判断。"""
    s = load_json(os.path.join(SESS_DIR, key + '.json'), {})
    recs = s.get('records', [])
    out = []
    for idx, q in enumerate(load_json(QUOTES, [])):
        if q.get('session'):
            if q['session'] != key:
                continue
        else:
            if q.get('date') != s.get('date'):
                continue
            if not _inside(q.get('t', ''), s.get('start', ''), s.get('end', '')):
                continue
        item = dict(q)
        item['_i'] = idx
        item['sel'] = q.get('sel') or []
        if not item['sel']:
            item['selDraft'] = _draft_sel(q, recs)
        out.append(item)
    return out


def _mins(t):
    p = [int(v) for v in str(t).split(':')[:2]]
    return p[0] * 60 + p[1]


def _inside(t, start, end):
    a, b, x = _mins(start), _mins(end), _mins(t)
    return a <= x <= b if a <= b else (x >= a or x <= b)


# ---------- 校勘命中试跑 ----------

def fix_hits(bad):
    """在原始 DB 的机器记录上试跑，不是在已套过 FIXES 的逐字稿上。

    已导出的逐字稿里错字已经被替换掉，拿它试跑永远命中 0，
    看不出这条规则到底会改到多少条原始记录。
    """
    hits = 0
    try:
        uri = 'file:%s?mode=ro' % DB.replace('\\', '/')
        con = sqlite3.connect(uri, uri=True)
        hits = con.execute(
            'SELECT count(*) FROM TranslationHistory WHERE SourceText LIKE ? OR TranslatedText LIKE ?',
            ('%' + bad + '%', '%' + bad + '%')).fetchone()[0]
        con.close()
    except Exception:
        # DB 不在本机时退回逐字稿，至少能给出粗略命中
        for s in sessions():
            for t, jp, zh, _tp in s.get('records', []):
                hits += jp.count(bad) + zh.count(bad)
    return hits, 1 if hits else 0


# ---------- 全库搜索 / 替换 ----------
#
# 扫的是 site/data/sessions/*.json（已套过单行覆盖），也就是站点上真正显示的文本。
# 命中后「应用」写的是 overrides.json —— 精确到某场某行，不会像全局规则那样
# 顺带改掉别处。全局规则（fixes_data.json）仍然单独维护，作用于所有场次。

MAX_ROWS = 800            # 一次最多回传多少行给前端
MAX_HITS = 50000          # 全库命中上限，防止空正则把机器拖死
FIELD_SETS = {'both': (1, 2), 'jp': (1,), 'zh': (2,)}

_CORPUS = [None, None]


def corpus():
    """全库逐字稿，按 sessions 文件与 overrides 的 mtime 缓存。"""
    files = sorted(f for f in os.listdir(SESS_DIR) if f.endswith('.json')) if os.path.isdir(SESS_DIR) else []
    paths = [os.path.join(SESS_DIR, f) for f in files]
    try:
        sig = (tuple(os.path.getmtime(p) for p in paths),
               tuple(os.path.getsize(p) for p in paths),
               os.path.getmtime(OVERRIDES))
    except OSError:
        sig = None
    if sig is not None and _CORPUS[0] == sig:
        return _CORPUS[1]
    ov_all = overrides_file()
    out = []
    for f, p in zip(files, paths):
        key = f[:-5]
        s = load_json(p, {})
        recs = [list(r) for r in s.get('records', [])]
        ov = ov_all.get(key) or {}
        if ov:
            overrides.apply_lines(recs, ov)
        out.append({'key': key, 'date': s.get('dateLong', ''),
                    'start': s.get('start', ''), 'recs': recs})
    _CORPUS[0], _CORPUS[1] = sig, out
    return out


def _repl_tpl(repl):
    """把 VSCode 习惯的 $1 / ${1} / $& 换成 Python 的 \\g<n>。"""
    if not repl or '$' not in repl:
        return repl
    out, i = [], 0
    while i < len(repl):
        c = repl[i]
        if c == '$' and i + 1 < len(repl):
            nx = repl[i + 1]
            if nx == '$':
                out.append('$')
                i += 2
                continue
            if nx == '&':
                out.append('\\g<0>')
                i += 2
                continue
            if nx == '{':
                j = repl.find('}', i + 2)
                if j > i + 2 and repl[i + 2:j].isdigit():
                    out.append('\\g<%s>' % repl[i + 2:j])
                    i = j + 1
                    continue
            if nx.isdigit():
                j = i + 1
                while j < len(repl) and repl[j].isdigit():
                    j += 1
                out.append('\\g<%s>' % repl[i + 1:j])
                i = j
                continue
        out.append(c)
        i += 1
    return ''.join(out)


def _sub_text(text, pat, sub):
    """返回 (替换后文本, 命中区间列表)。"""
    if not text:
        return text, []
    spans = [(m.start(), m.end()) for m in pat.finditer(text)]
    if not spans:
        return text, []
    try:
        return pat.sub(sub, text), spans
    except (re.error, IndexError, KeyError) as exc:
        raise ValueError('替换串写错了：%s' % exc)


def search_replace(q, repl='', regex=False, case=False, scope='both', limit=MAX_ROWS):
    """全库搜索，可选带替换预览。返回按场次分组的行 + 命中位置。"""
    q = (q or '')
    if not q.strip():
        return {'rows': [], 'rows_total': 0, 'hits': 0, 'sessions': 0, 'truncated': False}
    if len(q) > 200:
        return {'error': '搜索串太长（上限 200 字符）'}
    fields = FIELD_SETS.get(scope or 'both') or FIELD_SETS['both']
    flags = 0 if case else re.IGNORECASE
    repl = repl or ''
    if regex:
        try:
            pat = re.compile(q, flags)
        except re.error as exc:
            return {'error': '正则写错了：%s' % exc}
        sub = _repl_tpl(repl)
    else:
        # 字符串模式：转义后当正则跑，大小写与命中区间的口径才一致
        pat = re.compile(re.escape(q), flags)
        sub = (lambda m: repl)

    rows, hits, sess_hit, row_count, truncated = [], 0, 0, 0, False
    try:
        for s in corpus():
            got = 0
            for i, r in enumerate(s['recs']):
                jp = r[1] if len(r) > 1 else ''
                zh = r[2] if len(r) > 2 else ''
                njp, mj = _sub_text(jp, pat, sub) if 1 in fields else (jp, [])
                nzh, mz = _sub_text(zh, pat, sub) if 2 in fields else (zh, [])
                if not mj and not mz:
                    continue
                hits += len(mj) + len(mz)
                got += 1
                row_count += 1
                if hits > MAX_HITS:
                    truncated = True
                    break
                if len(rows) < limit:
                    rows.append({
                        'session': s['key'], 'date': s['date'], 'start': s['start'],
                        'i': i, 't': r[0], 'jp': jp, 'zh': zh,
                        'jp_after': njp, 'zh_after': nzh,
                        'marks': {'jp': [list(m) for m in mj], 'zh': [list(m) for m in mz]},
                    })
            if got:
                sess_hit += 1
            if truncated:
                break
    except ValueError as exc:
        return {'error': str(exc)}
    return {'rows': rows, 'rows_total': row_count, 'hits': hits,
            'sessions': sess_hit, 'truncated': truncated or row_count > len(rows)}


def apply_edits(items):
    """把替换结果逐行写成单行覆盖。items: [{session, i, jp?, zh?, why?}]"""
    if not isinstance(items, list) or not items:
        return {'error': '没有要应用的条目'}
    ov_all = {k: dict(v) for k, v in overrides_file().items()}
    cache, applied, skipped = {}, [], 0
    stamp = datetime.now().strftime('%Y-%m-%d %H:%M')
    for it in items:
        if not isinstance(it, dict):
            skipped += 1
            continue
        key = (it.get('session') or '').strip()
        i = it.get('i')
        if key not in cache:
            raw = session_records(key, raw=True)
            cache[key] = (raw, overrides.keys([x[0] for x in raw]) if raw else [])
        raw, keys = cache[key]
        if not raw or not isinstance(i, int) or not (0 <= i < len(raw)):
            skipped += 1
            continue
        row = raw[i]
        ojp = row[1] if len(row) > 1 else ''
        ozh = row[2] if len(row) > 2 else ''
        jp = ojp if it.get('jp') is None else str(it.get('jp'))
        zh = ozh if it.get('zh') is None else str(it.get('zh'))
        why = (it.get('why') or '').strip() or '全库搜索替换'
        k = keys[i]
        mine = dict(ov_all.get(key) or {})
        old = mine.get(k) or {}
        entry = {
            'jp': jp, 'zh': zh, 'why': why, 'at': stamp,
            'orig': old.get('orig') or {'jp': ojp, 'zh': ozh},
        }
        if entry['jp'] == entry['orig']['jp'] and entry['zh'] == entry['orig']['zh']:
            mine.pop(k, None)          # 替换成原文等于撤销
        else:
            mine[k] = entry
            applied.append({'session': key, 'i': i, 'entry': entry})
        if mine:
            ov_all[key] = mine
        else:
            ov_all.pop(key, None)
    if applied:
        save_json(OVERRIDES, ov_all)
        _ov_cache[0] = None
    return {'ok': True, 'applied': applied, 'skipped': skipped}


# ---------- SC 对照（只读 DB） ----------

def _hms(t):
    """'HH:MM' 或 'HH:MM:SS' → 秒。解析不了返回 None。"""
    parts = str(t).split(':')
    if len(parts) < 2:
        return None
    try:
        h, m = int(parts[0]), int(parts[1])
        sec = int(float(parts[2])) if len(parts) > 2 else 0
    except ValueError:
        return None
    return h * 3600 + m * 60 + sec


def session_window(s):
    """本场的绝对时间窗（epoch 秒）。跨零点的场次 end 顺延一天。"""
    try:
        d0 = datetime.strptime(str(s.get('dateLong', '')).replace('.', '-'), '%Y-%m-%d').timestamp()
    except ValueError:
        return None
    a, b = _hms(s.get('start')), _hms(s.get('end'))
    if a is None or b is None:
        return None
    return d0 + a, d0 + b + (86400 if b <= a else 0)


CTX_CACHE = {}


def context(key):
    """本场全部 SC + 弹幕，按时间排好整份返回。

    不做时间窗筛选：前端自己按选中的逐字稿行定位到最近一条，
    数据少就全列出来，数据多就分页翻。另外回传每行逐字稿的
    绝对时间戳，前端据此算「离选中行多少秒」。
    """
    if key in CTX_CACHE:
        return CTX_CACHE[key]
    s = load_json(os.path.join(SESS_DIR, key + '.json'), {})
    win = session_window(s)
    if not win:
        return {'error': '这场没有开播时间，无法对时'}
    lo, hi = win

    # 逐字稿每行的绝对时间戳（跨零点按场次起点顺延）
    base = _hms(s.get('start')) or 0
    rec_ts = []
    for t, _jp, _zh, *_ in s.get('records', []):
        sec = _hms(t)
        if sec is None:
            rec_ts.append(None)
            continue
        off = sec - base
        if off < -3600:
            off += 86400
        rec_ts.append(lo + off)

    items, err = [], None
    try:
        con = sqlite3.connect('file:%s?mode=ro' % DB.replace('\\', '/'), uri=True)
        for uname, msg, mt, ts in con.execute(
                'SELECT uname, message, message_trans, start_time FROM sc_message '
                'WHERE start_time BETWEEN ? AND ?', (lo, hi)).fetchall():
            if not (msg or '').strip():
                continue
            items.append({'k': 'sc', 'ts': int(ts), 'name': uname or '',
                          'text': msg.strip(), 'trans': (mt or '').strip()})
        for uname, txt, ts, medal, lv in con.execute(
                'SELECT uname, text, received_at, medal_name, medal_level FROM danmaku '
                'WHERE received_at BETWEEN ? AND ?', (lo * 1000, hi * 1000)).fetchall():
            if not (txt or '').strip():
                continue
            items.append({'k': 'dm', 'ts': int(ts) // 1000, 'name': uname or '',
                          'text': txt.strip(),
                          'medal': ('%s %s' % (medal, lv)) if medal else ''})
        cover = con.execute(
            'SELECT (SELECT min(start_time) FROM sc_message), (SELECT max(start_time) FROM sc_message),'
            '       (SELECT min(received_at)/1000 FROM danmaku), (SELECT max(received_at)/1000 FROM danmaku)'
        ).fetchone()
        con.close()
    except Exception as exc:
        err, cover = str(exc), None

    items.sort(key=lambda x: (x['ts'], 0 if x['k'] == 'sc' else 1))
    out = {
        'start': lo, 'end': hi, 'recTs': rec_ts, 'items': items,
        'counts': {'sc': sum(1 for x in items if x['k'] == 'sc'),
                   'dm': sum(1 for x in items if x['k'] == 'dm')},
    }
    if err:
        out['error'] = err
    if cover and cover[0]:
        out['coverage'] = {
            'sc': [datetime.fromtimestamp(cover[0]).strftime('%m-%d %H:%M'),
                   datetime.fromtimestamp(cover[1]).strftime('%m-%d %H:%M')],
            'dm': [datetime.fromtimestamp(cover[2]).strftime('%m-%d %H:%M'),
                   datetime.fromtimestamp(cover[3]).strftime('%m-%d %H:%M')],
        }
    if not items and not err:
        # 别让人以为是「这场真没弹幕」：本机库只同步了一部分日期
        c = out.get('coverage') or {}
        rng = c.get('sc') or c.get('dm')
        out['hint'] = ('本机库没有 {date} 的记录（SC 覆盖 {a} ~ {b}），不是这场没有弹幕'
                       .format(date=str(s.get('dateLong', '')).replace('.', '-'),
                               a=(rng or ['?', '?'])[0], b=(rng or ['?', '?'])[1]))
    CTX_CACHE[key] = out
    return out


# ---------- 重建 ----------

def find_node():
    """找 node 可执行文件。Electron 从 npm 起时 PATH 里有，直接双击时不一定。"""
    found = shutil.which('node') or shutil.which('node.exe')
    if found:
        return found
    # npm 与 node 一般同目录，用它反推
    npm = shutil.which('npm') or shutil.which('npm.cmd')
    if npm:
        cand = os.path.join(os.path.dirname(npm), 'node.exe')
        if os.path.exists(cand):
            return cand
    roots = [os.environ.get('ProgramFiles'), os.environ.get('ProgramFiles(x86)'),
             os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Programs')]
    for base in roots:
        if not base:
            continue
        cand = os.path.join(base, 'nodejs', 'node.exe')
        if os.path.exists(cand):
            return cand
    return None


def rebuild():
    # vite 是 node 包，不能拿 python -m 跑（会报 No module named vite）。
    # 用 node 直接执行 node_modules 里的入口，不依赖 shell / .cmd。
    node = find_node()
    vite = os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
    cmds = [
        ('tools/export.py', [sys.executable, os.path.join(ROOT, 'tools', 'export.py')]),
        ('tools/export_subs.py', [sys.executable, os.path.join(ROOT, 'tools', 'export_subs.py')]),
        ('tools/gen_data.py', [sys.executable, os.path.join(ROOT, 'tools', 'gen_data.py')]),
    ]
    log = []
    if node and os.path.exists(vite):
        cmds.append(('vite build', [node, vite, 'build']))
    for label, cmd in cmds:
        log.append('$ ' + label)
        try:
            p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                               encoding='utf-8', errors='replace', timeout=300)
            log.append((p.stdout or '').strip())
            if p.returncode:
                log.append('!! 失败 (%d): %s' % (p.returncode, (p.stderr or '').strip()))
                break
            if p.stderr and p.stderr.strip():
                log.append('stderr: ' + p.stderr.strip())
        except Exception as exc:
            log.append('!! 异常: %s' % exc)
            break
    else:
        if not node:
            log.append('!! 没找到 node，跳过前端构建：把 Node.js 加进 PATH，或在本机装一份'
                       '（工具脚本已跑完，data/ 是最新的）。')
        elif not os.path.exists(vite):
            log.append('!! 没找到 node_modules/vite，先在项目根跑 npm install，再重建。')
        else:
            log.append('完成。')
    return '\n'.join(x for x in log if x)


# ---------- HTTP ----------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n).decode('utf-8')) if n else {}

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        path = u.path
        try:
            if path == '/api/bootstrap':
                ss = sessions()
                self._send({
                    'sessions': [{'key': s['_key'], 'date': s.get('date'),
                                  'dateLong': s.get('dateLong'), 'week': s.get('week'),
                                  'count': s.get('count'), 'start': s.get('start'),
                                  'end': s.get('end')} for s in ss],
                    'tags': tag_names(),
                    'quotes': len(load_json(QUOTES, [])),
                    'fixes': load_json(FIXES, []),
                    'builtFixes': len(asr_fixes.FIXES),
                })
            elif path == '/api/session':
                key = (q.get('key') or [''])[0]
                self._send({'records': session_records(key),
                            'overrides': override_index(key),
                            'quotes': quotes_for(key)})
            elif path == '/api/quotes':
                # 全库列表。老条目没有 session，按 date + 时间窗反查，供摘录库跳转
                by_date = {}
                for s in sessions():
                    by_date.setdefault(s.get('date'), []).append(s)
                out = []
                for i, q in enumerate(load_json(QUOTES, [])):
                    it = dict(q)
                    it['_i'] = i
                    if not it.get('session'):
                        hit = next((s for s in by_date.get(q.get('date'), [])
                                    if _inside(q.get('t', ''), s.get('start', ''), s.get('end', ''))), None)
                        if hit:
                            it['session'] = hit['_key']
                    out.append(it)
                self._send({'quotes': out})
            elif path == '/api/ctx':
                self._send(context((q.get('key') or [''])[0]))
            elif path in ('/', '/index.html', '/app.js', '/style.css'):
                name = 'index.html' if path == '/' else path.lstrip('/')
                fp = os.path.join(os.path.dirname(os.path.abspath(__file__)), name)
                with open(fp, 'rb') as f:
                    body = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8' if name.endswith('.html') else
                                 ('text/css; charset=utf-8' if name.endswith('.css') else
                                  'application/javascript; charset=utf-8'))
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif path == '/api/backup':
                files = []
                if os.path.isdir(BACKUP):
                    for fn in sorted(os.listdir(BACKUP))[-40:]:
                        files.append(fn)
                self._send({'files': files})
            else:
                self._send({'error': 'not found'}, 404)
        except Exception as exc:
            self._send({'error': str(exc)}, 500)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            b = self._body()
            if path == '/api/quote':
                self._save_quote(b)
            elif path == '/api/quote/delete':
                qs = load_json(QUOTES, [])
                i = b.get('i')
                if not isinstance(i, int) or i < 0 or i >= len(qs):
                    return self._send({'error': '下标无效'}, 400)
                qs.pop(i)
                save_json(QUOTES, qs)
                self._send({'ok': True})
            elif path == '/api/tag':
                self._tag(b)
            elif path == '/api/fix':
                self._fix(b)
            elif path == '/api/fix/preview':
                bad = (b.get('bad') or '').strip()
                if len(bad) < 3:
                    return self._send({'error': '串太短，至少 3 字'}, 400)
                hits, n = fix_hits(bad)
                self._send({'hits': hits, 'sessions': n})
            elif path == '/api/search':
                self._send(search_replace(
                    b.get('q'), b.get('repl') or '',
                    bool(b.get('regex')), bool(b.get('case')),
                    b.get('scope') or 'both'))
            elif path == '/api/apply':
                self._send(apply_edits(b.get('items')))
            elif path == '/api/rebuild':
                self._send({'log': rebuild()})
            elif path == '/api/override':
                self._save_override(b)
            elif path == '/api/override/delete':
                self._delete_override(b)
            elif path == '/api/pull':
                t0 = time.time()
                try:
                    r = pull_mod.pull(DB, timeout=int(b.get('timeout') or 300))
                except Exception as exc:
                    return self._send({'error': str(exc)}, 500)
                CTX_CACHE.clear()
                r['seconds'] = round(time.time() - t0, 1)
                self._send(r)
            elif path == '/api/restore':
                fn = os.path.basename(b.get('file') or '')
                src = os.path.join(BACKUP, fn)
                target = {'quotes': QUOTES, 'tags': TAGS, 'fixes': FIXES}.get(b.get('kind'))
                if not target or not os.path.exists(src):
                    return self._send({'error': '备份不存在'}, 404)
                shutil.copy2(src, target)
                self._send({'ok': True})
            else:
                self._send({'error': 'not found'}, 404)
        except Exception as exc:
            self._send({'error': str(exc)}, 500)

    # ---- 单行覆盖（逐字稿原文/译文） ----

    def _save_override(self, b):
        key = (b.get('session') or '').strip()
        i = b.get('i')
        raw = session_records(key, raw=True)
        if not isinstance(i, int) or not (0 <= i < len(raw)):
            return self._send({'error': '行号无效'}, 400)
        jp = (b.get('jp') or '').strip()
        zh = (b.get('zh') or '').strip()
        why = (b.get('why') or '').strip()
        if not jp:
            return self._send({'error': '日文原文不能空'}, 400)
        if len(why) < 4:
            return self._send({'error': '写清为什么改（至少 4 个字），以后回看才有依据'}, 400)

        all_ov = dict(overrides_file())
        mine = dict(all_ov.get(key) or {})
        k = overrides.keys([r[0] for r in raw])[i]
        old = mine.get(k) or {}
        entry = {
            'jp': jp, 'zh': zh, 'why': why,
            'at': datetime.now().strftime('%Y-%m-%d %H:%M'),
            # 原文只在第一次覆盖时记下来，之后改来改去都以「导出时的原样」为准
            'orig': old.get('orig') or {'jp': raw[i][1], 'zh': raw[i][2]},
        }
        if entry['jp'] == entry['orig']['jp'] and entry['zh'] == entry['orig']['zh']:
            mine.pop(k, None)          # 改回原样就等于没改
        else:
            mine[k] = entry
        if mine:
            all_ov[key] = mine
        else:
            all_ov.pop(key, None)
        save_json(OVERRIDES, all_ov)
        _ov_cache[0] = None
        self._send({'ok': True, 'records': session_records(key),
                    'overrides': override_index(key)})

    def _delete_override(self, b):
        key = (b.get('session') or '').strip()
        i = b.get('i')
        raw = session_records(key, raw=True)
        if not isinstance(i, int) or not (0 <= i < len(raw)):
            return self._send({'error': '行号无效'}, 400)
        all_ov = dict(overrides_file())
        mine = dict(all_ov.get(key) or {})
        mine.pop(overrides.keys([r[0] for r in raw])[i], None)
        if mine:
            all_ov[key] = mine
        else:
            all_ov.pop(key, None)
        save_json(OVERRIDES, all_ov)
        _ov_cache[0] = None
        self._send({'ok': True, 'records': session_records(key),
                    'overrides': override_index(key)})

    # ---- 写摘录 ----

    def _save_quote(self, b):
        qs = load_json(QUOTES, [])
        key = (b.get('session') or '').strip()
        recs = session_records(key)
        sel = b.get('sel') or []
        clean = []
        for item in sel:
            i = item.get('i') if isinstance(item, dict) else item
            if isinstance(i, int) and 0 <= i < len(recs):
                clean.append({'i': i, 't': recs[i][0]})
        if not clean:
            return self._send({'error': '至少勾选一行'}, 400)
        tags = [t.strip() for t in (b.get('tags') or []) if str(t).strip()]
        if not tags:
            return self._send({'error': '至少选一个 tag'}, 400)
        lines = [recs[x['i']] for x in clean]
        s = next((x for x in sessions() if x['_key'] == key), {})
        entry = {
            'date': s.get('date', ''),
            'session': key,
            't': lines[0][0],
            'tag': tags[0],
            'tags': tags,
            'title': (b.get('title') or '').strip(),
            # jp/zh 留作 sel 失效时的兜底锚点，正文仍以逐字稿为准
            'jp': '\n'.join(r[1] for r in lines),
            'zh': '\n'.join(r[2] for r in lines),
            'note': (b.get('note') or '').strip(),
            'sel': clean,
        }
        # 引用块：一条摘录只带一种（SC 或弹幕），两个字段互斥
        for kind in ('sc', 'dm'):
            ref = b.get(kind)
            if not isinstance(ref, dict):
                continue
            name = (ref.get('name') or '').strip()
            text = (ref.get('text') or '').strip()
            if name or text:
                entry[kind] = {'name': name, 'text': text}
        i = b.get('i')
        if isinstance(i, int) and 0 <= i < len(qs):
            qs[i] = entry
        else:
            qs.append(entry)
            i = len(qs) - 1
        save_json(QUOTES, qs)
        self._send({'ok': True, 'i': i})

    # ---- tag 管理 ----

    def _tag(self, b):
        act = b.get('action')
        qs = load_json(QUOTES, [])
        names = tag_names()
        if act == 'add':
            name = (b.get('name') or '').strip()
            if not name or name in names:
                return self._send({'error': '名称为空或已存在'}, 400)
            names.append(name)
            save_json(TAGS, names)
        elif act == 'rename':
            old, new = (b.get('old') or '').strip(), (b.get('new') or '').strip()
            if old not in names or not new or new in names:
                return self._send({'error': '旧名不存在或新名重复'}, 400)
            names[names.index(old)] = new
            for q in qs:
                tags = q.get('tags') or ([q['tag']] if q.get('tag') else [])
                tags = [new if t == old else t for t in tags]
                q['tags'] = tags
                q['tag'] = tags[0] if tags else ''
            save_json(TAGS, names)
            save_json(QUOTES, qs)
        elif act == 'merge':
            old, new = (b.get('old') or '').strip(), (b.get('new') or '').strip()
            if old not in names or new not in names or old == new:
                return self._send({'error': '请选择两个不同的已有 tag'}, 400)
            names.remove(old)
            for q in qs:
                tags = q.get('tags') or ([q['tag']] if q.get('tag') else [])
                tags = [new if t == old else t for t in tags]
                tags = list(dict.fromkeys(tags))
                q['tags'] = tags
                q['tag'] = tags[0] if tags else ''
            save_json(TAGS, names)
            save_json(QUOTES, qs)
        elif act == 'delete':
            name = (b.get('name') or '').strip()
            used = sum(1 for q in qs if name in (q.get('tags') or [q.get('tag')]))
            if not b.get('force') and used:
                return self._send({'error': '仍有 %d 条引用，确认后先摘除再删' % used,
                                   'used': used}, 409)
            if name in names:
                names.remove(name)
            for q in qs:
                tags = [t for t in (q.get('tags') or [q.get('tag')]) if t != name]
                q['tags'] = tags
                q['tag'] = tags[0] if tags else ''
            save_json(TAGS, names)
            save_json(QUOTES, qs)
        else:
            return self._send({'error': '未知操作'}, 400)
        self._send({'ok': True, 'tags': tag_names()})

    # ---- 全局修正 ----

    def _fix(self, b):
        # 新增时前端只送内容、不送 action；没写 action 就当新增，删才显式传 delete。
        act = b.get('action') or 'add'
        items = load_json(FIXES, [])
        if act == 'add':
            bad = (b.get('bad') or '').strip()
            good = (b.get('good') or '').strip()
            jp_bad = (b.get('jp_bad') or '').strip()
            jp_good = (b.get('jp_good') or '').strip()
            if not bad and not jp_bad:
                return self._send({'error': '至少填一条原文'}, 400)
            if not good and not jp_good:
                return self._send({'error': '至少填一条修正'}, 400)
            if bad and bad == good or jp_bad and jp_bad == jp_good:
                return self._send({'error': '修正前后不能一样'}, 400)
            hits, n = fix_hits(jp_bad or bad)
            if not hits:
                return self._send({'error': '命中 0 条，检查原文是否写全'}, 400)
            if (jp_bad or bad) and len(jp_bad or bad) < 8:
                return self._send({'error': '串太短，容易误伤别处，请写长一点'}, 400)
            items.append({
                'jp_bad': jp_bad, 'jp_good': jp_good,
                'zh_bad': bad, 'zh_good': good,
                'why': (b.get('why') or '').strip(),
                'session': (b.get('session') or '').strip(),
                't': (b.get('t') or '').strip(),
            })
            save_json(FIXES, items)
        elif act == 'delete':
            i = b.get('i')
            if not isinstance(i, int) or i < 0 or i >= len(items):
                return self._send({'error': '下标无效'}, 400)
            items.pop(i)
            save_json(FIXES, items)
        else:
            return self._send({'error': '未知操作'}, 400)
        self._send({'ok': True, 'fixes': items})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print('编辑器已启动： http://127.0.0.1:%d/' % port)
    print('数据目录： %s' % DATA)
    print('Ctrl+C 停止')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')
        srv.server_close()


if __name__ == '__main__':
    main()
