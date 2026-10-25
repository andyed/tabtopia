#!/usr/bin/env python3
"""Dump Tabtopia's chrome.storage.local keys from Chrome's on-disk LevelDB.

Read-only by construction: the extension's storage directory is copied to a
temp dir first and only the copy is parsed, so a running Chrome (which holds
the live directory's LOCK and may be mid-compaction) is never disturbed.

Why a hand-rolled reader: no interpreter on the usual machine has plyvel or
python-snappy, and the format is small enough (write-ahead .log blocks, .ldb
SSTables with snappy-compressed blocks) to read with the stdlib. Highest
sequence number wins per key; a delete tombstone at the top means "gone".

Output: <out>/<key>.json for every live key starting with "tabtopia" (except *Secret* keys). Values
are content-free aggregates plus HMAC identities -- keep them out of git.
Feed the directory to scripts/summarize-local-studies.mjs.
"""
import argparse, glob, os, shutil, struct, sys, tempfile



def default_profile():
    """Chrome's default profile directory for this platform; --profile-dir overrides it."""
    if sys.platform == "win32":
        return os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser(r"~\AppData\Local")),
                            "Google", "Chrome", "User Data", "Default")
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/Google/Chrome/Default")
    return os.path.expanduser("~/.config/google-chrome/Default")


DEFAULT_PROFILE = default_profile()
DEFAULT_EXTENSION_ID = "moaofehfbphhadakgfiejlpgjdcggfho"
TABLE_MAGIC = bytes.fromhex("57fb808b247547db")  # LevelDB SSTable footer magic
BLOCK = 32768  # write-ahead log block size
TYPE_VALUE = 1  # internal key type: 1 = put, 0 = delete


def varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1
        r |= (c & 0x7F) << s
        if c < 0x80:
            return r, i
        s += 7


def snappy(b):
    n, i = varint(b, 0)
    out = bytearray()
    while i < len(b):
        t = b[i]; i += 1
        kind = t & 3
        if kind == 0:  # literal
            ln = t >> 2
            if ln >= 60:
                nb = ln - 59
                ln = int.from_bytes(b[i:i + nb], "little"); i += nb
            ln += 1
            out += b[i:i + ln]; i += ln
            continue
        if kind == 1:
            ln = 4 + ((t >> 2) & 7); off = ((t >> 5) << 8) | b[i]; i += 1
        elif kind == 2:
            ln = (t >> 2) + 1; off = int.from_bytes(b[i:i + 2], "little"); i += 2
        else:
            ln = (t >> 2) + 1; off = int.from_bytes(b[i:i + 4], "little"); i += 4
        start = len(out) - off
        if off <= 0 or start < 0:
            raise ValueError("snappy: bad back-reference")
        for j in range(ln):  # byte-wise: copies may overlap their own output
            out.append(out[start + j])
    if len(out) != n:
        raise ValueError("snappy: length mismatch")
    return bytes(out)


def read_block(f, off, size):
    f.seek(off)
    raw = f.read(size + 5)  # +1 compression byte, +4 crc
    if len(raw) < size + 1:
        raise ValueError("truncated block")
    data, ctype = raw[:size], raw[size]
    if ctype == 1:
        return snappy(data)
    if ctype != 0:
        raise ValueError("unknown compression %d" % ctype)
    return data


def block_entries(data):
    nrest = struct.unpack("<I", data[-4:])[0]
    end = len(data) - 4 - 4 * nrest
    i = 0; key = b""; out = []
    while i < end:
        shared, i = varint(data, i); nonshared, i = varint(data, i); vlen, i = varint(data, i)
        key = key[:shared] + data[i:i + nonshared]; i += nonshared
        out.append((key, data[i:i + vlen])); i += vlen
    return out


def put(store, key, seq, typ, val):
    cur = store.get(key)
    if cur is None or seq > cur[0]:
        store[key] = (seq, typ, val)


def read_sst(path, store):
    with open(path, "rb") as f:
        f.seek(-48, 2)
        foot = f.read(48)
        if foot[-8:] != TABLE_MAGIC:
            raise ValueError("bad SSTable magic")
        _, i = varint(foot, 0); _, i = varint(foot, i)  # metaindex handle (unused)
        ioff, i = varint(foot, i); isz, i = varint(foot, i)
        for _, handle in block_entries(read_block(f, ioff, isz)):
            boff, j = varint(handle, 0); bsz, j = varint(handle, j)
            for ikey, val in block_entries(read_block(f, boff, bsz)):
                tag = struct.unpack("<Q", ikey[-8:])[0]
                put(store, ikey[:-8], tag >> 8, tag & 0xFF, val)


def read_log(path, store):
    b = open(path, "rb").read()
    i = 0; buf = b""
    while i + 7 <= len(b):
        if (i % BLOCK) + 7 > BLOCK:  # block trailer too small for a header: padding
            i = (i // BLOCK + 1) * BLOCK; continue
        _crc, ln, typ = struct.unpack("<IHB", b[i:i + 7]); i += 7
        if typ == 0 and ln == 0:
            i = (i // BLOCK + 1) * BLOCK; continue
        if i + ln > len(b):
            break  # Chrome was mid-write when we copied; drop the torn tail
        buf += b[i:i + ln]; i += ln
        if typ not in (1, 4):  # FIRST/MIDDLE fragments keep accumulating
            continue
        rec, buf = buf, b""
        seq = struct.unpack("<Q", rec[:8])[0]; count = struct.unpack("<I", rec[8:12])[0]; j = 12
        for n in range(count):
            t = rec[j]; j += 1
            kl, j = varint(rec, j); k = rec[j:j + kl]; j += kl
            v = b""
            if t == TYPE_VALUE:
                vl, j = varint(rec, j); v = rec[j:j + vl]; j += vl
            put(store, k, seq + n, t, v)


def read_store(directory):
    """Latest (seq, type, value) per user key across every .ldb and .log file."""
    store = {}
    for p in sorted(glob.glob(os.path.join(directory, "*.ldb"))):
        read_sst(p, store)
    for p in sorted(glob.glob(os.path.join(directory, "*.log"))):
        read_log(p, store)
    return store


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--profile-dir", default=DEFAULT_PROFILE, help="Chrome profile directory (default: %(default)s)")
    ap.add_argument("--extension-id", default=DEFAULT_EXTENSION_ID, help="extension id (default: %(default)s)")
    ap.add_argument("--include-secrets", action="store_true",
                    help="also dump keys whose name contains 'Secret' (the HMAC key that makes identities reversible)")
    ap.add_argument("--out", help="output directory (default: a fresh temp dir, printed)")
    args = ap.parse_args()

    src = os.path.join(args.profile_dir, "Local Extension Settings", args.extension_id)
    if not os.path.isdir(src):
        sys.exit("no extension storage at %s" % src)
    snapshot = tempfile.mkdtemp(prefix="tabtopia-ldb-")
    try:
        # LOCK is Chrome's; the copy doesn't need it and must not look held.
        shutil.copytree(src, snapshot, dirs_exist_ok=True, ignore=shutil.ignore_patterns("LOCK"))
        store = read_store(snapshot)
    finally:
        shutil.rmtree(snapshot, ignore_errors=True)

    out = args.out or tempfile.mkdtemp(prefix="tabtopia-studies-")
    os.makedirs(out, exist_ok=True)
    for key, (seq, typ, val) in sorted(store.items()):
        name = key.decode("utf-8", "replace")
        live = typ == TYPE_VALUE
        # The revisit HMAC secret would let a reader of the dump re-derive identities
        # from known URLs; no summary needs it, so it stays on disk in Chrome only.
        secret = "Secret" in name and not args.include_secrets
        if live and name.startswith("tabtopia") and "/" not in name and not secret:
            with open(os.path.join(out, name + ".json"), "wb") as fh:
                fh.write(val)
        print("%-45s seq=%-10d %-8s %d bytes" % (name, seq, "live" if live else "deleted", len(val)), file=sys.stderr)
    print(out)


if __name__ == "__main__":
    main()
