# -*- coding: utf-8 -*-
"""产出 Vite 构建需要的输入，全部落在 .build/ 下（不入库）。

  .build/public/assets/data.js   site/data/ 的索引部分内联成 window.DATA
  .build/public/records/*.json   逐字稿按场次分片，档案页 / 搜索按需取
  .build/public/quotes.json      全量摘录，摘录页 / 问答 / 时间线 / 搜索按需取
  .build/public/diary/*.json     每篇日记的正文，日记详情页按需取
  .build/public/subs/*.json      双语字幕轨（按场次分文件，供外部工具取用）
  .build/public/brand/           站点图片（app.js 里有运行时拼出来的引用，整目录复制）
  .build/manifest.json           版本号 + 页面模板要用的 profile

由 vite.config.mjs 在 dev 启动和 build 前调用，也可以单独跑：

  python tools/gen_data.py [--config config.toml] [--out .build]

版本号算法与旧的 build.py 一致：data（去掉构建时刻）+ app.js + style.css 的
sha256 前 10 位。同样的数据必然得到同样的版本号，用来判断线上是否已更新。
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
import export_subs

ROOT = common.ROOT

# 构建时刻一律按北京时间算：CI 跑在 UTC，用本地时间会差 8 小时，页脚会看起来像没更新。
BUILD_TZ = timezone(timedelta(hours=8))


def build_stamp():
    """这次构建的时刻，形如 2026.11.10 22:10。"""
    raw = os.environ.get('BUILD_TIME', '').strip()
    if raw:
        return raw
    return datetime.now(BUILD_TZ).strftime('%Y.%m.%d %H:%M')


_SC_HEAD = re.compile(r'^「(.+?)」$')


def split_sc(jp, zh):
    """旧格式首行「用户名：SC 原文」拆成引用块，返回 (sc, 她的发言, 译文)。

    老摘录都是「「观众：原话」\n——她的话」的写法，页面上分不出哪句是观众说的。
    这里统一拆开，前端把 SC 画成一条引用、她的话作为跟帖；拆不出来就原样返回。
    """
    jp_lines = jp.split('\n')
    zh_lines = zh.split('\n')
    if not jp_lines or not zh_lines or not zh_lines[0].strip().startswith('「'):
        return None, jp, zh
    m = _SC_HEAD.match(jp_lines[0].strip())
    if not m:
        return None, jp, zh
    body = m.group(1).strip()
    name, text = '', body
    if '：' in body:
        head, rest = body.split('：', 1)
        if len(head) <= 24 and rest.strip():
            name, text = head.strip(), rest.strip()
    reply_jp = re.sub(r'^——', '', '\n'.join(jp_lines[1:])).strip()
    reply_zh = re.sub(r'^——', '', '\n'.join(zh_lines[1:])).strip()
    if not reply_jp:
        return None, jp, zh
    return {'name': name, 'text': text}, reply_jp, reply_zh


def inside(t, start, end):
    """t / start / end 均为 HH:MM[:SS]，跨零点也能判断。"""
    def m(x):
        p = [int(v) for v in x.split(':')[:2]]
        return p[0] * 60 + p[1]
    t, s, e = m(t), m(start), m(end)
    if s <= e:
        return s <= t <= e
    return t >= s or t <= e


def load_sessions(site_dir):
    d = os.path.join(site_dir, 'data', 'sessions')
    out = []
    for fn in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        if not fn.endswith('.json'):
            continue
        with open(os.path.join(d, fn), encoding='utf-8') as f:
            s = json.load(f)
        s['_file'] = fn
        out.append(s)
    out.sort(key=lambda s: s['_file'])
    return out


def collect(site_dir):
    """site/data/ 下的场次、摘录、日记、动态合成页面用的数据结构。"""
    with open(os.path.join(site_dir, 'data', 'profile.json'), encoding='utf-8') as f:
        profile = json.load(f)
    sessions = load_sessions(site_dir)
    if not sessions:
        print('!! site/data/sessions 为空，先跑 tools/export.py', file=sys.stderr)
        raise SystemExit(1)

    with open(os.path.join(site_dir, 'data', 'quotes.json'), encoding='utf-8') as f:
        quotes_raw = json.load(f)

    # 直播日记：人工整理的每场摘要，按 date 挂到对应场次
    diary_raw = []
    diary_path = os.path.join(site_dir, 'data', 'diary.json')
    if os.path.exists(diary_path):
        with open(diary_path, encoding='utf-8') as f:
            diary_raw = json.load(f)

    # 主播动态：由 tools/export_dynamics.py 从 live-capture 的 dynamics 表导出
    dynamics_path = os.path.join(site_dir, 'data', 'dynamics.json')
    dynamics_out = []
    if os.path.exists(dynamics_path):
        with open(dynamics_path, encoding='utf-8') as f:
            dynamics_out = json.load(f)

    sess_out, recs_out = [], []
    for i, s in enumerate(sessions):
        key = os.path.basename(s['_file'])[:-5]
        sess_out.append({
            'id': i,
            # 场次文件名（2026-11-11_0904）：日记详情页用它做路由，比递增 id 稳
            'key': key,
            # 逐字稿分片的文件名（records/<key>.json）。前端看一场只取这一片，
            # 首屏的 data.js 里不再带任何逐字稿正文。
            'chunk': key,
            'date': s['date'], 'dateLong': s['dateLong'], 'week': s['week'],
            'start': s['start'], 'end': s['end'], 'dur': s['dur'], 'count': s['count'],
            'topics': s['topics'], 'ribbon': s['ribbon'], 'segs': s['segs'],
        })
        for t, jp, zh, tp in s['records']:
            recs_out.append({'s': i, 't': t, 'jp': jp, 'zh': zh, 'tp': tp})

    skipped, q_out = [], []
    for q in quotes_raw:
        cands = [s for s in sess_out if s['date'] == q['date']]
        hit = next((s for s in cands if inside(q['t'], s['start'], s['end'])), None)
        if not hit:
            skipped.append('%s %s' % (q['date'], q['t']))
            continue
        sc = q.get('sc')
        jp, zh = q['jp'], q['zh']
        if not sc:
            sc, jp, zh = split_sc(jp, zh)
        entry = {
            'id': 'q%d' % (len(q_out) + 1),
            's': hit['id'], 'date': hit['date'], 'week': hit['week'],
            't': q['t'], 'tag': q['tag'],
            'jp': jp, 'zh': zh, 'note': q.get('note', ''),
        }
        if sc:
            entry['sc'] = sc
        q_out.append(entry)

    # 日记也按 date 找场次；文件顺序即展示顺序（最新的写在最前）
    # 同一天有两场（比如凌晨场 + 白天场）时，光看 date 会全部绑到当天第一场，
    # 所以日记里可以写 "session": "2026-11-11_0904" 显式指定场次文件。
    by_file = {s['_file']: i for i, s in enumerate(sessions)}
    skipped_diary, diary_out = [], []
    for d in diary_raw:
        want = (d.get('session') or '').strip()
        wid = by_file.get(want + '.json') if want else None
        if wid is not None:
            hit = sess_out[wid]
        else:
            hit = next((s for s in sess_out if s['date'] == d['date']), None)
        if not hit:
            skipped_diary.append(d['date'] + (' / ' + want if want else ''))
            continue
        diary_out.append({
            's': hit['id'], 'key': hit['key'],
            'date': hit['date'], 'dateLong': hit['dateLong'],
            'week': hit['week'], 'start': hit['start'], 'end': hit['end'],
            'dur': hit['dur'], 'count': hit['count'],
            'title': d['title'], 'tagline': d.get('tagline', ''),
            # 列表页只显示 summary（一两句），全文放在详情页
            'summary': d.get('summary', ''),
            'body': d['body'],
            # 正文里出现的观众 uname，仅用于前端 .dname 轻排版；
            # scNames / dmNames 决定 SC 与弹幕发送者各自用哪套样式
            'names': d.get('names') or [],
            'scNames': d.get('scNames') or [],
            'dmNames': d.get('dmNames') or [],
        })

    # 动态挂到当天那篇日记：11-05、11-22 这种一天里有两条动态的，
    # 按时间就近归到那一天的某一场（例如 16:32 那条归 16:33 那场，00:07 归 00:11 那场）。
    # 没有日记的日期（或没有动态的日记）两边都不勉强凑。
    def _mins(t):
        h, m = str(t).split(':')[:2]
        return int(h) * 60 + int(m)

    by_date = {}
    for d in diary_out:
        by_date.setdefault(d['date'], []).append(d)
    for group in by_date.values():
        group.sort(key=lambda x: _mins(x['start']))
    for dyn in dynamics_out:
        cands = by_date.get(str(dyn.get('date', ''))[5:])   # 2026-11-22 -> 11-22
        if not cands:
            continue
        target = cands[0] if len(cands) == 1 else min(
            cands, key=lambda d: abs(_mins(d['start']) - _mins(dyn.get('time') or '00:00')))
        target.setdefault('dyn', []).append(dyn)
    for d in diary_out:
        if d.get('dyn'):
            d['dyn'].sort(key=lambda x: x.get('ts') or 0)

    return profile, sess_out, recs_out, q_out, diary_out, dynamics_out, skipped, skipped_diary



def write_chunks(public_dir, sess_out, recs_out):
    """逐字稿按场次拆成 records/<key>.json，返回 (总字节数, 内容指纹)。

    档案页看一场只取一片；全站搜索与主题索引才按需把全部片拉下来。这样
    data.js 不再随场次一起膨胀，新增一场也只多一个新文件，历史分片的内容
    没变就不必重下。

    片内每条写成 [t, jp, zh, tp] 而非对象：s 字段在单场文件里是恒定的，
    键名也是每行重复一遍，去掉这些后比 data.js 里原来的写法小四分之一左右。

    指纹覆盖全部片的内容，前端拿它给分片 URL 打 ?v=，校正后不会吃旧缓存。
    """
    rec_dir = os.path.join(public_dir, 'records')
    if os.path.isdir(rec_dir):
        shutil.rmtree(rec_dir)   # 场次可能被删掉，旧分片不能留在产物里
    os.makedirs(rec_dir, exist_ok=True)

    by_sess = {}
    for r in recs_out:
        by_sess.setdefault(r['s'], []).append([r['t'], r['jp'], r['zh'], r['tp']])

    h, total = hashlib.sha256(), 0
    for s in sess_out:
        txt = json.dumps(by_sess.get(s['id'], []), ensure_ascii=False, separators=(',', ':'))
        with open(os.path.join(rec_dir, s['chunk'] + '.json'), 'w',
                  encoding='utf-8', newline='\n') as f:
            f.write(txt)
        blob = txt.encode('utf-8')
        h.update(blob)
        total += len(blob)
    return total, h.hexdigest()[:10]


def _write_json(path, obj):
    txt = json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(txt)
    return txt


def write_side(public_dir, q_out, diary_out):
    """摘录与日记正文也从 data.js 拆出来，返回 (摘录指纹, 日记正文指纹)。

    首页真正要用的只有最近一场的三条摘录和一句随机引文，没必要为了它把
    几百段摘录和所有日记正文一起下载。需要全文的页面（摘录 / 问答 / 时间线 /
    主题详情 / 日记详情 / 搜索）再按需取：

      quotes.json          全部摘录
      diary/<key>.json     单篇日记的正文与具名观众

    指纹只覆盖各自的文件内容：新增一场时历史文件不变，URL 也就不变。
    """
    q_txt = _write_json(os.path.join(public_dir, 'quotes.json'), q_out)
    q_ver = hashlib.sha256(q_txt.encode('utf-8')).hexdigest()[:10]

    d_dir = os.path.join(public_dir, 'diary')
    if os.path.isdir(d_dir):
        shutil.rmtree(d_dir)   # 日记可能被删掉，旧正文不能留在产物里
    os.makedirs(d_dir, exist_ok=True)

    h = hashlib.sha256()
    for d in diary_out:
        txt = _write_json(os.path.join(d_dir, d['key'] + '.json'),
                          {'body': d['body'], 'names': d.get('names') or [],
                           'scNames': d.get('scNames') or [], 'dmNames': d.get('dmNames') or []})
        h.update(txt.encode('utf-8'))
    return q_ver, h.hexdigest()[:10]


def home_quotes(sess_out, q_out, limit=24):
    """首页只带固定条数的摘录：最近一场三条 + 一份横跨存档的随机池。

    随机池按时间均匀取样，保证「随机一句」不会总落在最近几场；条数固定，
    首页体积就不再随摘录总数增长。
    """
    if not q_out:
        return {'latest': [], 'pool': []}
    last_id = sess_out[-1]['id']
    latest = [q for q in q_out if q['s'] == last_id][:3]
    # 与前端原来的取句规则一致：长度适中的一句才适合放在首屏大引言里
    pool = [q for q in q_out if 55 <= len(re.sub(r'\s', '', q['zh'])) <= 120] or q_out
    step = max(1, len(pool) // limit)
    return {'latest': latest, 'pool': pool[::step][:limit]}


def data_js(data):
    return 'window.DATA = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n'


def content_version(data, site_dir):
    """版本号覆盖 data / app / style 三者：任一改动都会让浏览器重新取。"""
    # 构建时刻不计入哈希——它每次都不同，算进去会让版本号随每次构建变化，
    # 而版本号要表达的是「内容变没变」。
    hash_data = dict(data)
    hash_data['meta'] = dict(data['meta'])
    hash_data['meta']['built'] = ''
    # 字幕轨的「更新于」也是构建时刻，同样不计入版本
    if hash_data['meta'].get('subs'):
        hash_data['meta']['subs'] = dict(hash_data['meta']['subs'])
        hash_data['meta']['subs']['updated'] = ''
    hash_js = data_js(hash_data)
    h = hashlib.sha256(hash_js.encode('utf-8'))
    for rel in ('assets/app.js', 'assets/style.css'):
        # 按 LF 归一化后再算：工作区若是 CRLF，本地与 CI 算出的版本号会不一致
        with open(os.path.join(site_dir, rel), encoding='utf-8') as f:
            h.update(f.read().replace('\r\n', '\n').encode('utf-8'))
    return h.hexdigest()[:10]


def copy_static(site_dir, public_dir):
    """brand/ 与 audio/ 原样复制：app.js / index.html 运行时直接拼这两个路径，
    不能只靠打包器。sw.js / manifest.webmanifest 也没有被 index.html 引用
    （动态注册），同样要手动带过去。_headers 是 Cloudflare Pages 的缓存与 MIME
    规则，必须落在产物根目录才会生效。"""
    for folder in ('brand', 'audio'):
        src = os.path.join(site_dir, folder)
        dst = os.path.join(public_dir, folder)
        # 先清空目标：换格式/换歌后旧文件不能留在产物里
        if os.path.isdir(dst):
            shutil.rmtree(dst)
        if os.path.isdir(src):
            os.makedirs(public_dir, exist_ok=True)
            shutil.copytree(src, dst)
    for name in ('sw.js', 'manifest.webmanifest', '_headers'):
        src = os.path.join(site_dir, name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(public_dir, name))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--config')
    ap.add_argument('--out', default=os.path.join(ROOT, '.build'))
    args = ap.parse_args()

    os.chdir(ROOT)
    cfg = common.load_config(args.config)
    site_dir = cfg['site']['dir']

    out_dir = os.path.abspath(args.out)
    public_dir = os.path.join(out_dir, 'public')
    os.makedirs(os.path.join(public_dir, 'assets'), exist_ok=True)

    profile, sess_out, recs_out, q_out, diary_out, dynamics_out, skipped, skipped_diary = collect(site_dir)

    # 字幕轨统计：字幕文件随站点发布，data.js 里留一份概况供外部工具展示。
    subs_meta = {}
    try:
        with open(os.path.join(site_dir, 'data', 'subs', 'index.json'), encoding='utf-8') as f:
            si = json.load(f)
        subs_meta = {
            'sessions': si.get('count', 0),
            'blocks': si.get('blocks', 0),
            'updated': si.get('updated', ''),
            'latest': (si['sessions'][-1]['key'] if si.get('sessions') else ''),
        }
    except Exception as exc:
        print('!! 读不到字幕索引（%s），data.js 不带字幕概况' % exc, file=sys.stderr)

    # 逐字稿先落成按场次的分片，指纹要写进 meta，所以得赶在拼 data 之前
    chunk_bytes, rec_ver = write_chunks(public_dir, sess_out, recs_out)

    # 摘录与日记正文同样按需取；首页要用的几句单独挑进 data.js
    quotes_ver, diary_ver = write_side(public_dir, q_out, diary_out)

    # 场次 / 日记条目上的摘录条数在构建期算好：列表、日历和详情页头部都要显示它，
    # 不能为了一个数字把 quotes.json 拉下来。
    q_by_s = {}
    for q in q_out:
        q_by_s[q['s']] = q_by_s.get(q['s'], 0) + 1
    for s in sess_out:
        s['qn'] = q_by_s.get(s['id'], 0)

    # data.js 里的日记只留索引（标题 / 摘要 / 动态），正文另外成文件
    diary_index = []
    for d in diary_out:
        item = {k: v for k, v in d.items() if k not in ('body', 'names')}
        item['n'] = len(d['body'])
        item['qn'] = q_by_s.get(d['s'], 0)
        diary_index.append(item)

    # 主题的命中计数在构建期算好。以前是前端拿全量逐字稿现算，分片之后那样做
    # 会让「打开主题列表」变成一次全库拉取；口径与前端过滤保持一致。
    themes_raw = []
    themes_path = os.path.join(site_dir, 'data', 'themes.json')
    if os.path.exists(themes_path):
        with open(themes_path, encoding='utf-8') as f:
            themes_raw = json.load(f)
    themes_out = []
    for th in themes_raw:
        kw = th.get('kw') or []
        qn = sum(1 for q in q_out
                 if any(w in (q['jp'] + ' ' + q['zh'] + ' ' + q.get('note', '')) for w in kw))
        rn = sum(1 for r in recs_out
                 if any(w in (r['jp'] + ' ' + (r['zh'] or '')) for w in kw))
        themes_out.append(dict(th, quoteCount=qn, recCount=rn))

    data = {
        'meta': {
            'streamer': profile['streamer'],
            'title': profile['title'],
            'total': len(recs_out),
            'records': len(recs_out),
            'sessionCount': len(sess_out),
            'firstDate': sess_out[0]['dateLong'],
            'lastDate': sess_out[-1]['dateLong'],
            # 最后一场的结束时间：数据截止到哪儿，仍然只由数据决定
            'generated': sess_out[-1]['dateLong'] + ' ' + sess_out[-1]['end'],
            # 这次构建的时刻：由构建环境写入，同样的数据每次构建都会不同
            'built': build_stamp(),
            'quoteCount': len(q_out),
            'diaryCount': len(diary_out),
            'dynamicCount': len(dynamics_out),
            # 逐字稿分片的内容指纹：前端拿它给 records/*.json 打 ?v=
            'recVer': rec_ver,
            # 摘录与日记正文各自的内容指纹：分开取文件，也就能分开失效
            'quotesVer': quotes_ver,
            'diaryVer': diary_ver,
            # 字幕轨概况（场次数 / 块数 / 更新时间 / 最新场次）
            'subs': subs_meta,
        },
        'topics': [[common.TOPIC_NAMES[i], common.TOPIC_COLORS[i]] for i in range(len(common.TOPIC_NAMES))],
        # 主题索引：名称、配色、关键词与命中计数，前端的主题页直接读它
        'themes': themes_out,
        'sessions': sess_out,
        # 日记索引：列表与时间线只读这里，正文在 diary/<key>.json
        'diary': diary_index,
        # 首页专用的小份摘录：最近一场三条 + 随机引文池（条数固定，不随摘录总数涨）
        'home': home_quotes(sess_out, q_out),
        # 动态不再单独成页，已经挂在各自那篇日记的 dyn 字段里（meta.dynamicCount 仍给总数）
    }

    js = data_js(data)
    with open(os.path.join(public_dir, 'assets', 'data.js'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(js)
    ver = content_version(data, site_dir)

    copy_static(site_dir, public_dir)
    try:
        n_subs, n_blocks, sub_bytes = export_subs.emit_from_db(
            cfg, public_dir, site_dir, data['meta']['built'])
    except Exception as exc:  # 字幕挂了也不该拦着站点发布
        print('!! 字幕轨导出失败（%s），本站点照常发布' % exc, file=sys.stderr)
        n_subs, n_blocks, sub_bytes = 0, 0, 0

    manifest = {
        'version': ver,
        'profile': {
            'title': profile['title'],
            'desc': profile.get('desc', ''),
            'streamer': profile['streamer'],
        },
        'built': data['meta']['built'],
    }
    with open(os.path.join(out_dir, 'manifest.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write('\n')

    print('data: %d 场 / %d 条 / %d 段摘录 / %d 篇日记 · data.js %d KB · v=%s'
          % (len(sess_out), len(recs_out), len(q_out), len(diary_out),
             len(js.encode('utf-8')) // 1024, ver))
    print('records: %d 片 / 共 %d KB · 指纹 %s' % (len(sess_out), chunk_bytes // 1024, rec_ver))
    print('quotes: %d KB · 指纹 %s · diary 正文 %d 篇 / %d KB · 指纹 %s'
          % (os.path.getsize(os.path.join(public_dir, 'quotes.json')) // 1024, quotes_ver,
             len(diary_out),
             sum(os.path.getsize(os.path.join(public_dir, 'diary', f))
                 for f in os.listdir(os.path.join(public_dir, 'diary'))) // 1024,
             diary_ver))
    print('subs: %d 场字幕 / %d 块 / %d KB' % (n_subs, n_blocks, sub_bytes // 1024))
    if skipped:
        print('!! 找不到对应场次的摘录:', ', '.join(skipped))
    if skipped_diary:
        print('!! 找不到对应场次的日记:', ', '.join(skipped_diary))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
