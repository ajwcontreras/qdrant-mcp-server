#!/usr/bin/env python3
"""
POC 1: Checkpoint file round-trips correctly

Proves: We can write and read a JSONL checkpoint file that tracks per-chunk
indexing state (pending → hyde_done → embedded → upserted) and survives
process restart. Append-only writes, last-write-wins on duplicate point_ids.

Input: None
Output: Validates checkpoint format and resume logic

Pass criteria:
  - Checkpoint file is valid JSONL, each line parses independently
  - Round-trip 100 records with zero data loss
  - Filter correctly identifies records at each stage
  - File append (not rewrite) for new records — simulates crash-safe writes
  - Handles duplicate point_ids (last-write-wins on load)
"""

import json
import os
import sys
import tempfile
import time
import uuid

STAGES = ("pending", "hyde_done", "embedded", "upserted")


def write_checkpoint_record(f, record: dict) -> None:
    """Append a single checkpoint record. Flush immediately for crash safety."""
    f.write(json.dumps(record, separators=(",", ":")) + "\n")
    f.flush()


def load_checkpoint(path: str) -> dict[str, dict]:
    """Load checkpoint file. Returns {point_id: record}, last-write-wins."""
    state = {}
    if not os.path.exists(path):
        return state
    with open(path, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)  # let it raise on corrupt lines
            state[record["point_id"]] = record
    return state


def filter_by_stage(state: dict[str, dict], stage: str) -> list[dict]:
    """Return records at a specific stage."""
    return [r for r in state.values() if r["stage"] == stage]


def make_record(point_id: str, rel_path: str, chunk_index: int,
                content_hash: str, stage: str, hyde_payload: dict | None = None) -> dict:
    """Create a checkpoint record."""
    rec = {
        "point_id": point_id,
        "rel_path": rel_path,
        "chunk_index": chunk_index,
        "content_hash": content_hash,
        "stage": stage,
        "ts": time.time(),
    }
    if hyde_payload is not None:
        rec["hyde_payload"] = hyde_payload
    return rec


def run():
    print("POC 1: Checkpoint file round-trips correctly\n")

    with tempfile.TemporaryDirectory() as tmpdir:
        cp_path = os.path.join(tmpdir, "checkpoint.jsonl")

        # ── Test 1: Write 100 records via append ──
        print("  Writing 100 records via append...")
        records_written = []
        with open(cp_path, "a", encoding="utf-8") as f:
            for i in range(100):
                point_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"test/file.py_{i}"))
                rec = make_record(
                    point_id=point_id,
                    rel_path="test/file.py",
                    chunk_index=i,
                    content_hash=f"hash_{i:04d}",
                    stage="pending",
                )
                write_checkpoint_record(f, rec)
                records_written.append(rec)

        # Verify file size grew (append, not rewrite)
        size_after_first_write = os.path.getsize(cp_path)

        # ── Test 2: Round-trip read ──
        print("  Reading back checkpoint...")
        state = load_checkpoint(cp_path)
        roundtrip_ok = len(state) == 100
        print(f"    Records written: 100, read back: {len(state)}")

        # Verify every field round-trips
        data_fidelity = True
        for orig in records_written:
            loaded = state.get(orig["point_id"])
            if loaded is None:
                data_fidelity = False
                break
            for key in ("point_id", "rel_path", "chunk_index", "content_hash", "stage"):
                if loaded[key] != orig[key]:
                    data_fidelity = False
                    break

        # ── Test 3: Each line parses independently ──
        print("  Verifying each line parses independently...")
        with open(cp_path, "r", encoding="utf-8") as f:
            lines = [l.strip() for l in f if l.strip()]
        independent_parse = True
        for line in lines:
            try:
                json.loads(line)
            except json.JSONDecodeError:
                independent_parse = False
                break

        # ── Test 4: Stage filtering ──
        print("  Testing stage filtering...")
        # Simulate progression: move first 30 to hyde_done, first 10 to upserted
        with open(cp_path, "a", encoding="utf-8") as f:
            for i in range(30):
                point_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"test/file.py_{i}"))
                rec = make_record(
                    point_id=point_id,
                    rel_path="test/file.py",
                    chunk_index=i,
                    content_hash=f"hash_{i:04d}",
                    stage="hyde_done",
                    hyde_payload={"hyde_questions": [f"Q{j}" for j in range(3)]},
                )
                write_checkpoint_record(f, rec)
            for i in range(10):
                point_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"test/file.py_{i}"))
                rec = make_record(
                    point_id=point_id,
                    rel_path="test/file.py",
                    chunk_index=i,
                    content_hash=f"hash_{i:04d}",
                    stage="upserted",
                )
                write_checkpoint_record(f, rec)

        # Verify file grew (append, not rewrite)
        size_after_updates = os.path.getsize(cp_path)
        append_only = size_after_updates > size_after_first_write

        # Reload with last-write-wins
        state = load_checkpoint(cp_path)
        pending = filter_by_stage(state, "pending")
        hyde_done = filter_by_stage(state, "hyde_done")
        upserted = filter_by_stage(state, "upserted")

        stage_filter_ok = (len(pending) == 70 and len(hyde_done) == 20 and len(upserted) == 10)
        print(f"    pending={len(pending)}, hyde_done={len(hyde_done)}, upserted={len(upserted)}")

        # ── Test 5: Duplicate point_ids — last-write-wins ──
        print("  Testing last-write-wins on duplicates...")
        lww_ok = True
        # The first 10 should be "upserted" (last write), not "hyde_done" or "pending"
        for i in range(10):
            point_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"test/file.py_{i}"))
            if state[point_id]["stage"] != "upserted":
                lww_ok = False
                break
        # Records 10-29 should be "hyde_done"
        for i in range(10, 30):
            point_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"test/file.py_{i}"))
            if state[point_id]["stage"] != "hyde_done":
                lww_ok = False
                break

        # ── Test 6: Resume simulation ──
        print("  Simulating resume from checkpoint...")
        not_yet_upserted = [r for r in state.values() if r["stage"] != "upserted"]
        needs_hyde = filter_by_stage(state, "pending")
        needs_embed_and_upsert = filter_by_stage(state, "hyde_done")
        resume_ok = (len(not_yet_upserted) == 90
                     and len(needs_hyde) == 70
                     and len(needs_embed_and_upsert) == 20)
        print(f"    Would resume: {len(needs_hyde)} need HyDE, {len(needs_embed_and_upsert)} need embed+upsert, {len(upserted)} already done")

        # ── Test 7: hyde_payload preserved in hyde_done records ──
        print("  Verifying hyde_payload preserved...")
        hyde_payload_ok = True
        for r in hyde_done:
            if "hyde_payload" not in r or len(r["hyde_payload"]["hyde_questions"]) != 3:
                hyde_payload_ok = False
                break

        # ── Pass Criteria ──
        print("\n-- Pass Criteria --")
        checks = {
            "JSONL lines parse independently": independent_parse,
            "Round-trip 100 records, zero loss": roundtrip_ok,
            "Full data fidelity on round-trip": data_fidelity,
            "Stage filter correct (70/20/10)": stage_filter_ok,
            "Append-only writes (file grew)": append_only,
            "Last-write-wins on duplicates": lww_ok,
            "Resume identifies correct work": resume_ok,
            "HyDE payload preserved": hyde_payload_ok,
        }

        all_pass = True
        for label, ok in checks.items():
            status = "\u2705" if ok else "\u274c"
            print(f"  {status} {label}")
            if not ok:
                all_pass = False

        print(f"\n{'  \u2705 POC 1: PASS' if all_pass else '  \u274c POC 1: FAIL'}")
        if not all_pass:
            sys.exit(1)


if __name__ == "__main__":
    run()
