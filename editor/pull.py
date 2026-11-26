# -*- coding: utf-8 -*-
"""从手机增量拉 SC 与弹幕到本机库（只读手机、只追加本地）。

数据源是 Termux 里 live-capture 的 capture.db。手机上没有 sqlite3 命令行，
所以走 `ssh v20 python3 -`：把一段查询脚本从 stdin 递过去，远端把结果按
400 行一批打成 JSON 行，外面套一层 gzip 再回传。

去重口径：
  sc_message 有 sc_id 主键，INSERT OR IGNORE 就够；
  danmaku 只有自增 seq，而本机库的 seq 与手机不是同一套编号（手机重装过），
  所以按（room_id, received_at, uid, text）比对——先把重叠窗口里已有的键读进
  内存，再逐条跳过。窗口取本机最大 received_at 往前 10 分钟，防止边界漏行。
"""
import gzip
import json
import os
import sqlite3
import subprocess
import time

OVERLAP_MS = 10 * 60 * 1000        # 弹幕重叠窗口
SC_OVERLAP_S = 24 * 3600           # SC 重叠窗口（量小，宽松点）

REMOTE = """\
import os, sqlite3, json
db = os.path.expanduser(%(db)r)          # ~ 在手机上展开，本机不要动
con = sqlite3.connect(db)
def dump(tag, sql, args):
    buf = []
    for row in con.execute(sql, args):
        buf.append(list(row))
        if len(buf) >= 400:
            print(json.dumps({'t': tag, 'r': buf}, ensure_ascii=False))
            buf = []
    if buf:
        print(json.dumps({'t': tag, 'r': buf}, ensure_ascii=False))
dump('dm', "SELECT seq, room_id, uid, uname, text, event_time, received_at, medal_name,"
           " medal_level, guard_level, is_admin, is_emoticon FROM danmaku"
           " WHERE received_at > ? ORDER BY seq", (%(dm_from)d,))
dump('sc', "SELECT sc_id, room_id, uid, uname, price, message, message_trans, start_time,"
           " end_time, received_at, guard_level, medal_name, medal_level, medal_color,"
           " raw_json FROM sc_message WHERE start_time > ? ORDER BY start_time", (%(sc_from)d,))
"""


def marks(db_path):
    con = sqlite3.connect(db_path)
    try:
        dm = con.execute('SELECT max(received_at) FROM danmaku').fetchone()[0] or 0
        sc = con.execute('SELECT max(start_time) FROM sc_message').fetchone()[0] or 0
    finally:
        con.close()
    return dm, sc


def pull(db_path, ssh='v20', remote_db='~/live-capture/data/capture.db', timeout=300):
    """返回 {'danmaku': 新增条数, 'sc': 新增条数, 'seconds': 耗时, 'window': (起, 止)}"""
    started = time.time()
    dm_max, sc_max = marks(db_path)
    dm_from = max(0, dm_max - OVERLAP_MS)
    sc_from = max(0, sc_max - SC_OVERLAP_S)
    script = REMOTE % {'db': remote_db, 'dm_from': dm_from, 'sc_from': sc_from}

    cmd = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ssh, 'python3 - | gzip -c']
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    try:
        raw, err = proc.communicate(script.encode('utf-8'), timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise RuntimeError('拉取超时（%d 秒），手机可能不在线' % timeout)
    if proc.returncode != 0:
        msg = (err or b'').decode('utf-8', 'replace').strip().splitlines()
        raise RuntimeError('ssh 失败：' + (msg[-1] if msg else '退出码 %d' % proc.returncode))

    con = sqlite3.connect(db_path)
    added_dm = added_sc = 0
    try:
        have = set(con.execute(
            'SELECT room_id, received_at, uid, text FROM danmaku WHERE received_at > ?',
            (dm_from,)).fetchall())
        for line in gzip.decompress(raw).decode('utf-8').splitlines():
            if not line.strip():
                continue
            obj = json.loads(line)
            if obj['t'] == 'dm':
                rows = []
                for r in obj['r']:
                    _seq, room, uid, uname, text, et, ra, mn, ml, gl, ad, emo = r
                    if not text or (room, ra, uid, text) in have:
                        continue
                    have.add((room, ra, uid, text))
                    rows.append((room, uid, uname, text, et, ra, mn, ml, gl, ad, emo))
                if rows:
                    con.executemany(
                        'INSERT INTO danmaku(room_id, uid, uname, text, event_time, received_at,'
                        ' medal_name, medal_level, guard_level, is_admin, is_emoticon)'
                        ' VALUES (?,?,?,?,?,?,?,?,?,?,?)', rows)
                    added_dm += len(rows)
            elif obj['t'] == 'sc':
                rows = []
                for r in obj['r']:
                    (sc_id, room, uid, uname, price, msg, mt, st, et, ra, gl, mn, ml,
                     mc, raw_json) = r
                    if not sc_id:
                        continue
                    rows.append((sc_id, room, uid, uname, price, msg, st, et, ra, gl, mn, ml,
                                 None, mc, raw_json or '{}', mt))
                if rows:
                    before = con.total_changes
                    con.executemany(
                        'INSERT OR IGNORE INTO sc_message(sc_id, room_id, uid, uname, price,'
                        ' message, start_time, end_time, received_at, guard_level, medal_name,'
                        ' medal_level, medal_anchor_roomid, medal_color, raw_json, message_trans)'
                        ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', rows)
                    added_sc += con.total_changes - before
        con.commit()
    finally:
        con.close()

    return {'danmaku': added_dm, 'sc': added_sc, 'seconds': round(time.time() - started, 1),
            'window': (dm_from, dm_max)}
