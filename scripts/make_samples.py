#!/usr/bin/env python3
"""Write the sample pickle files used by the tests, the README screenshots and the release check.

usage: python3 scripts/make_samples.py <out_dir> [--fallback]

--fallback writes the NumPy and pandas samples as hand-written opcode streams even when
numpy and pandas are installed (the tests use it to check both paths).

The file risky-os-system.pkl is written as raw bytes. This script never loads it, and no
sample is ever unpickled here.
"""
import datetime
import io
import os
import pickle
import struct
import sys
import types

MAX_BYTES = 5 * 1024 * 1024


# A custom class that lives in a module called lab.models, so the viewer shows "lab.models.Experiment".
lab = types.ModuleType("lab")
lab_models = types.ModuleType("lab.models")
sys.modules["lab"] = lab
sys.modules["lab.models"] = lab_models
lab.models = lab_models


class Experiment:
    def __init__(self, name, seed, tags):
        self.name = name
        self.seed = seed
        self.tags = tags
        self.started = datetime.datetime(2026, 11, 6, 9, 30, 15, 250000)


Experiment.__module__ = "lab.models"
Experiment.__qualname__ = "Experiment"
lab_models.Experiment = Experiment


def basic_object():
    return {
        "name": "sensor run 42",
        "count": 3,
        "big_int": 2 ** 70,
        "negative": -123456789012,
        "ratio": 0.875,
        "whole_float": 2.0,
        "flags": [True, False, None],
        "point": (1.5, -2.25, 3),
        "labels": {"cat", "dog"},
        "frozen": frozenset([1, 2]),
        "payload": b"\x00\x01\x02PKL\xff",
        "buffer": bytearray(b"abc"),
        "when": datetime.datetime(2026, 11, 6, 14, 5, 9),
        "day": datetime.date(2026, 1, 31),
        "elapsed": datetime.timedelta(days=1, seconds=3661, microseconds=5),
        "nested": {"levels": [[1, 2], [3, [4, 5]]], 7: "int key", (1, 2): "tuple key"},
        "unicode": "café ✓",
        "experiment": Experiment("baseline", 1234, ["fast", "cpu"]),
    }


# ---------- hand-written opcode streams (used when numpy or pandas is missing, or with --fallback) ----------

class Ops:
    """Tiny protocol-2 opcode writer. Only the opcodes needed for the samples."""

    def __init__(self):
        self.b = io.BytesIO()
        self.w(b"\x80\x02")  # PROTO 2

    def w(self, data):
        self.b.write(data)
        return self

    def glob(self, module, name):
        return self.w(b"c" + module.encode() + b"\n" + name.encode() + b"\n")

    def mark(self):
        return self.w(b"(")

    def tuple(self):
        return self.w(b"t")

    def reduce(self):
        return self.w(b"R")

    def build(self):
        return self.w(b"b")

    def none(self):
        return self.w(b"N")

    def bool(self, v):
        return self.w(b"\x88" if v else b"\x89")

    def int(self, v):
        if 0 <= v < 256:
            return self.w(b"K" + bytes([v]))
        return self.w(b"J" + struct.pack("<i", v))

    def str(self, s):
        data = s.encode("utf-8")
        return self.w(b"X" + struct.pack("<I", len(data)) + data)

    def bytes_py2(self, data):
        # Python 3 writes bytes for protocol 2 as _codecs.encode(<latin-1 text>, 'latin1').
        self.glob("_codecs", "encode").mark().str(data.decode("latin-1")).str("latin1").tuple().reduce()
        return self

    def empty_list(self):
        return self.w(b"]")

    def append(self):
        return self.w(b"a")

    def empty_dict(self):
        return self.w(b"}")

    def setitem(self):
        return self.w(b"s")

    def stop(self):
        return self.w(b".").b.getvalue()


def nd_dtype(o, code):
    # numpy.dtype('<f8') as numpy pickles it: dtype(code, False, True) then BUILD (3, '<', None, ...).
    o.glob("numpy", "dtype").mark().str(code[1:]).bool(False).bool(True).tuple().reduce()
    o.mark().int(3).str(code[0] if code[0] in "<>|" else "<").none().none().none().int(-1).int(-1).int(0).tuple().build()


def nd_array(o, shape, code, raw, fortran=False):
    # numpy.core.multiarray._reconstruct(ndarray, (0,), b'b') then BUILD (1, shape, dtype, is_fortran, rawdata)
    o.glob("numpy.core.multiarray", "_reconstruct").mark().glob("numpy", "ndarray").mark().int(0).tuple().bytes_py2(b"b").tuple().reduce()
    o.mark().int(1).mark()
    for s in shape:
        o.int(s)
    o.tuple()
    nd_dtype(o, code)
    o.bool(fortran).bytes_py2(raw).tuple().build()


def wave_values(rows, cols):
    import math
    out = []
    for r in range(rows):
        for c in range(cols):
            out.append(math.sin(r / 6.0) * math.cos(c / 9.0) + (r * cols + c) % 7 * 0.01)
    return out


def handwritten_numpy():
    rows, cols = 48, 64
    vals = wave_values(rows, cols)
    o = Ops()
    o.empty_dict()
    o.str("weights")
    nd_array(o, (rows, cols), "<f4", struct.pack("<%df" % len(vals), *vals))
    o.setitem()
    o.str("labels")
    nd_array(o, (10,), "<i8", struct.pack("<10q", *range(10)))
    o.setitem()
    return o.stop()


def handwritten_dataframe():
    """A 3-column frame (id int64, score float64, city object) in the pandas 2.x layout:
    BlockManager(blocks, axes) where each block is pandas._libs.internals._unpickle_block(values, slice, 2)."""
    o = Ops()
    n = 4
    o.glob("pandas.core.frame", "DataFrame").w(b")").w(b"\x81")  # EMPTY_TUPLE, NEWOBJ
    o.empty_dict().str("_mgr")
    o.glob("pandas.core.internals.managers", "BlockManager").mark().mark()

    def block(shape, code, raw, start, items=None):
        o.glob("pandas._libs.internals", "_unpickle_block")
        if items is None:
            nd_array(o, shape, code, raw)
        else:
            o.glob("numpy.core.multiarray", "_reconstruct").mark().glob("numpy", "ndarray").mark().int(0).tuple().bytes_py2(b"b").tuple().reduce()
            o.mark().int(1).mark()
            for s in shape:
                o.int(s)
            o.tuple()
            nd_dtype(o, "|O8")
            o.bool(False).empty_list()
            for it in items:
                o.str(it).append()
            o.tuple().build()
        o.glob("__builtin__", "slice").mark().int(start).int(start + 1).int(1).tuple().reduce()
        o.int(2).w(b"\x87").reduce()  # TUPLE3, REDUCE

    block((1, n), "<i8", struct.pack("<4q", 101, 102, 103, 104), 0)
    block((1, n), "<f8", struct.pack("<4d", 0.5, 0.25, 0.125, 1.0), 1)
    block((1, n), "|O8", None, 2, ["Oslo", "Lima", "Pune", "Kyiv"])
    o.tuple()  # blocks
    o.empty_list()
    o.glob("pandas.core.indexes.base", "_new_Index").mark().glob("pandas.core.indexes.base", "Index").empty_dict()
    o.str("data")
    o.glob("numpy.core.multiarray", "_reconstruct").mark().glob("numpy", "ndarray").mark().int(0).tuple().bytes_py2(b"b").tuple().reduce()
    o.mark().int(1).mark().int(3).tuple()
    nd_dtype(o, "|O8")
    o.bool(False).empty_list().str("id").append().str("score").append().str("city").append().tuple().build()
    o.setitem().str("name").none().setitem()
    o.tuple().reduce().append()
    o.glob("pandas.core.indexes.base", "_new_Index").mark().glob("pandas.core.indexes.range", "RangeIndex").empty_dict()
    o.str("name").none().setitem().str("start").int(0).setitem().str("stop").int(n).setitem().str("step").int(1).setitem()
    o.tuple().reduce().append()
    o.tuple().reduce()  # BlockManager(blocks, axes)
    o.setitem()
    o.str("_typ").str("dataframe").setitem()
    o.build()
    return o.stop()


def handwritten_dataframe_legacy():
    """A 3-column frame (id int64, score float64, city object) in the older pandas layout (BlockManager state "0.14.1")."""
    o = Ops()
    n = 4
    # DataFrame instance via copyreg._reconstructor-free path: pandas uses copyreg.__newobj__ style
    o.glob("copy_reg", "_reconstructor").mark().glob("pandas.core.frame", "DataFrame").glob("__builtin__", "object").none().tuple().reduce()
    o.empty_dict()
    o.str("_mgr")
    # BlockManager: pandas.core.internals.managers.BlockManager.__new__ then BUILD with its state tuple
    o.glob("copy_reg", "_reconstructor").mark().glob("pandas.core.internals.managers", "BlockManager").glob("__builtin__", "object").none().tuple().reduce()
    o.mark()
    # axes: [columns Index (object), RangeIndex]
    o.empty_list()
    o.glob("pandas.core.indexes.base", "_new_Index").mark().glob("pandas.core.indexes.base", "Index").empty_dict()
    o.str("data")
    o.glob("numpy.core.multiarray", "_reconstruct").mark().glob("numpy", "ndarray").mark().int(0).tuple().bytes_py2(b"b").tuple().reduce()
    o.mark().int(1).mark().int(3).tuple()
    nd_dtype(o, "|O8")
    o.bool(False).empty_list().str("id").append().str("score").append().str("city").append().tuple().build()
    o.setitem().str("name").none().setitem()
    o.tuple().reduce().append()
    o.glob("pandas.core.indexes.base", "_new_Index").mark().glob("pandas.core.indexes.range", "RangeIndex").empty_dict()
    o.str("name").none().setitem().str("start").int(0).setitem().str("stop").int(n).setitem().str("step").int(1).setitem()
    o.tuple().reduce().append()
    # block values and items (old style, kept empty like pandas does), then extra state with the blocks
    o.empty_list().empty_list()
    o.empty_dict().str("0.14.1").empty_dict()
    o.str("axes").empty_list().setitem()  # pandas repeats the axes here; the viewer reads the first list
    o.str("blocks").empty_list()
    # block 1: int64 values shape (1, n), mgr_locs slice(0, 1, 1)
    o.empty_dict().str("values")
    nd_array(o, (1, n), "<i8", struct.pack("<4q", 101, 102, 103, 104))
    o.setitem().str("mgr_locs").glob("__builtin__", "slice").mark().int(0).int(1).int(1).tuple().reduce().setitem().append()
    o.empty_dict().str("values")
    nd_array(o, (1, n), "<f8", struct.pack("<4d", 0.5, 0.25, 0.125, 1.0))
    o.setitem().str("mgr_locs").glob("__builtin__", "slice").mark().int(1).int(2).int(1).tuple().reduce().setitem().append()
    # block 3: object strings
    o.empty_dict().str("values")
    o.glob("numpy.core.multiarray", "_reconstruct").mark().glob("numpy", "ndarray").mark().int(0).tuple().bytes_py2(b"b").tuple().reduce()
    o.mark().int(1).mark().int(1).int(n).tuple()
    nd_dtype(o, "|O8")
    o.bool(False).empty_list()
    for city in ["Oslo", "Lima", "Pune", "Kyiv"]:
        o.str(city).append()
    o.tuple().build()
    o.setitem().str("mgr_locs").glob("__builtin__", "slice").mark().int(2).int(3).int(1).tuple().reduce().setitem().append()
    o.setitem()  # "blocks"
    o.setitem()  # "0.14.1"
    o.tuple().build()
    o.setitem()  # "_mgr"
    o.str("_typ").str("dataframe").setitem()
    o.str("_metadata").empty_list().setitem()
    o.str("attrs").empty_dict().setitem()
    o.build()
    return o.stop()


def risky_bytes():
    # Protocol 0 stream for os.system('true'). Written as bytes, never loaded.
    return b"cos\nsystem\n(S'true'\ntR."


def risky_stack_global_bytes():
    # Protocol 4 stream: subprocess.check_output(['true']) through STACK_GLOBAL, plus builtins.eval in a list.
    # Written as bytes, never loaded.
    def su(s):
        d = s.encode()
        return b"\x8c" + bytes([len(d)]) + d
    body = (b"\x80\x04" + b"]" + b"(" +
            su("subprocess") + su("check_output") + b"\x93" + b"]" + su("true") + b"a" + b"\x85" + b"R" +
            su("builtins") + su("eval") + b"\x93" + su("1+1") + b"\x85" + b"R" +
            b"e" + b".")
    return body


def write(out, name, data, made):
    if len(data) > MAX_BYTES:
        raise SystemExit(f"{name} is {len(data)} bytes, over the 5 MB sample limit")
    with open(os.path.join(out, name), "wb") as f:
        f.write(data)
    made.append((name, len(data)))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    fallback = "--fallback" in sys.argv
    out = args[0] if args else "samples"
    os.makedirs(out, exist_ok=True)
    made = []
    obj = basic_object()
    write(out, "basic-protocol0.pkl", pickle.dumps(obj, protocol=0), made)
    write(out, "basic-protocol2.pkl", pickle.dumps(obj, protocol=2), made)
    write(out, "basic-protocol4.pickle", pickle.dumps(obj, protocol=4), made)
    write(out, "basic-protocol5.p", pickle.dumps(obj, protocol=5), made)

    np = pd = None
    if not fallback:
        try:
            import numpy as np  # noqa: F811
        except ImportError:
            np = None
        try:
            import pandas as pd  # noqa: F811
        except ImportError:
            pd = None

    if np is not None:
        rows, cols = 96, 128
        y, x = np.mgrid[0:rows, 0:cols]
        weights = (np.sin(y / 9.0) * np.cos(x / 13.0) + 0.15 * np.sin((x + y) / 4.0)).astype(np.float32)
        arrays = {
            "weights": weights,
            "bias": np.linspace(-1, 1, 16, dtype=np.float64),
            "labels": np.arange(200, dtype=np.int64) % 10,
            "image": ((x[:64, :64] ^ y[:64, :64]) & 0xFF).astype(np.uint8),
            "mask": (weights > 0)[:8, :8],
            "fortran": np.asfortranarray(np.arange(12, dtype=np.int32).reshape(3, 4)),
            "scalar": np.float64(3.25),
        }
        write(out, "numpy-arrays-protocol2.pkl", pickle.dumps(arrays, protocol=2), made)
        write(out, "numpy-arrays-protocol5.pkl", pickle.dumps(arrays, protocol=5), made)
    else:
        write(out, "numpy-arrays-protocol2.pkl", handwritten_numpy(), made)

    if pd is not None:
        df = pd.DataFrame({
            "city": ["Oslo", "Lima", "Pune", "Kyiv", "Accra", "Quito"],
            "population_k": [709, 10719, 7764, 2952, 2660, 2011],
            "area_km2": [454.0, 2672.3, 331.3, 839.0, 225.7, 372.4],
            "coastal": [True, True, False, False, True, False],
        })
        write(out, "dataframe.pkl", pickle.dumps(df, protocol=5), made)
    else:
        write(out, "dataframe.pkl", handwritten_dataframe(), made)
    if fallback or pd is None or np is None:
        write(out, "handwritten-numpy.pkl", handwritten_numpy(), made)
        write(out, "handwritten-dataframe.pkl", handwritten_dataframe(), made)
        write(out, "handwritten-dataframe-legacy.pkl", handwritten_dataframe_legacy(), made)

    write(out, "risky-os-system.pkl", risky_bytes(), made)
    write(out, "risky-stack-global.pkl", risky_stack_global_bytes(), made)
    for name, size in made:
        print(f"{name}\t{size}")


if __name__ == "__main__":
    main()
