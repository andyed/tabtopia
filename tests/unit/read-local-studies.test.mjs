import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "read-local-studies.py");
const EXT = "testextensionid";

const varint = n => { const o = []; while (n >= 0x80) { o.push((n & 0x7f) | 0x80); n >>>= 7; } o.push(n); return Buffer.from(o); };

// One WriteBatch as a single FULL write-ahead-log record (crc is not checked by the reader).
function logRecord(seq, ops) {
    const parts = [];
    const head = Buffer.alloc(12);
    head.writeBigUInt64LE(BigInt(seq)); head.writeUInt32LE(ops.length, 8);
    parts.push(head);
    for (const [type, key, value] of ops) {
        parts.push(Buffer.from([type]), varint(key.length), Buffer.from(key));
        if (type === 1) parts.push(varint(value.length), Buffer.from(value));
    }
    const body = Buffer.concat(parts);
    const hdr = Buffer.alloc(7);
    hdr.writeUInt16LE(body.length, 4); hdr[6] = 1;
    return Buffer.concat([hdr, body]);
}

test("read-local-studies.py keeps the highest-sequence value per key and skips deletes/secrets", () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tt-profile-"));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "tt-out-"));
    try {
        const dir = path.join(profile, "Local Extension Settings", EXT);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "000003.log"), Buffer.concat([
            logRecord(1, [[1, "tabtopiaStudyV1", '{"n":1}'], [1, "tabtopiaGoneV1", '{"x":1}'], [1, "tabtopiaRevisitSecretV1", '"s3"'], [1, "other", "ignored"]]),
            logRecord(5, [[1, "tabtopiaStudyV1", '{"n":2}']]),   // overwrite: seq 5 beats seq 1
            logRecord(6, [[0, "tabtopiaGoneV1"]])                 // tombstone
        ]));
        const run = spawnSync("python3", [SCRIPT, "--profile-dir", profile, "--extension-id", EXT, "--out", out], { encoding: "utf8" });
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "tabtopiaStudyV1.json"), "utf8")), { n: 2 });
        assert.deepEqual(fs.readdirSync(out), ["tabtopiaStudyV1.json"]);
        // The live directory must be untouched: no files added or removed.
        assert.deepEqual(fs.readdirSync(dir), ["000003.log"]);
    } finally {
        fs.rmSync(profile, { recursive: true, force: true });
        fs.rmSync(out, { recursive: true, force: true });
    }
});
