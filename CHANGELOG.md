# Changelog

## 0.1.1 (2026-11-06)

- The end of the viewer page has two small links, "Sponsor" (GitHub Sponsors) and "More free viewers". The new setting `pickleViewer.showSupportLinks` (default `true`) hides them, and so does the "Hide" link next to them. There is no popup, and nothing is sent anywhere.
- New commands "PKL Viewer: Support the developer" and "PKL Viewer: More free viewers". The second one lists the other Zovo extensions and installs only the one you pick. Ones that are not on the Marketplace yet open their GitHub page.
- The listing gets a Sponsor button. The README has a short Support section and lists all Zovo extensions.

## 0.1.0

- First release. Opens `.pkl` and `.pickle` files by default and `.p` files from the Explorer menu, without Python.
- Tree with Python types, NumPy arrays with stats and a heatmap, pandas DataFrames as a table, an opcode listing and a safety check.
- Decoding runs in a worker thread. Files over 512 MB show a message and are not read.
