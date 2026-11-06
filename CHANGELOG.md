# Changelog

## 0.1.0

- First release. Opens `.pkl` and `.pickle` files by default and `.p` files from the Explorer menu, without Python.
- Tree with Python types, NumPy arrays with stats and a heatmap, pandas DataFrames as a table, an opcode listing and a safety check.
- Decoding runs in a worker thread. Files over 512 MB show a message and are not read.
