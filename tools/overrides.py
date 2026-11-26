# -*- coding: utf-8 -*-
"""逐字稿单行覆盖（overrides.json）。

和 asr_fixes 的全局替换是两回事：
  asr_fixes   一条规则改所有场次里所有相同的串（错字、专名误识）
  overrides   只改某一场的某一行，带「为什么改」，用来处理上下文相关的错译

键是「场次 key + 行时间戳 + 同秒序号」：
  同一场里会有两行时间戳相同（实测全库 535 处），只用 HH:MM:SS 会串行，
  所以第 n 次出现的同一时间戳记作 `00:14:23#1`。

存的是改完的 jp/zh 和当初的原文（orig），导出时只要这一行存在就直接替换，
不再跑 asr_fixes——覆盖写的就是最终文本，避免两条规则互相打架。
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, 'site', 'data', 'overrides.json')


def load(path=None):
    path = path or PATH
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def keys(times):
    """一组行时间戳 → 稳定的键（同秒第 n 次记 #n）。"""
    seen, out = {}, []
    for t in times:
        n = seen.get(t, 0)
        seen[t] = n + 1
        out.append('%s#%d' % (t, n))
    return out


def apply_lines(recs, ov):
    """site/data/sessions/*.json 的 records：[[t, jp, zh, kind], ...] 就地改文本。"""
    if not ov:
        return recs
    for k, rec in zip(keys([r[0] for r in recs]), recs):
        o = ov.get(k)
        if o:
            rec[1] = o.get('jp', rec[1])
            rec[2] = o.get('zh', rec[2])
    return recs


def apply_db(records, ov, fmt):
    """export_subs 的 records：[(ts, jp, zh), ...]，fmt 把 ts 转成 HH:MM:SS。"""
    if not ov:
        return records
    times = [fmt(r[0]) for r in records]
    out = []
    for k, (ts, jp, zh) in zip(keys(times), records):
        o = ov.get(k)
        out.append((ts, o.get('jp', jp), o.get('zh', zh)) if o else (ts, jp, zh))
    return out
