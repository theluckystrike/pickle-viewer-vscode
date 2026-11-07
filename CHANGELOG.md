# Changelog

## 0.1.3 (2026-11-07)

- The Marketplace name is now "Pickle Viewer & PKL Viewer (No Python)" (it was "PKL Viewer & Pickle Viewer"), so it matches what people type in the Extensions search. The extension id, commands and settings stay the same.
- The Marketplace description now starts with "Pickle viewer and PKL viewer for Python pickle files (".
- Marketplace search keywords updated, with the phrases people search for first.

## 0.1.2 (2026-11-07)

- "More free viewers" now starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.

## 0.1.1 (2026-11-06)

- The end of the viewer page has two small links, "Sponsor" (GitHub Sponsors) and "More free viewers". The new setting `pickleViewer.showSupportLinks` (default `true`) hides them, and so does the "Hide" link next to them. There is no popup, and nothing is sent anywhere.
- New commands "PKL Viewer: Support the developer" and "PKL Viewer: More free viewers". The second one lists the other Zovo extensions and installs only the one you pick. Ones that are not on the Marketplace yet open their GitHub page.
- The listing gets a Sponsor button. The README has a short Support section and lists all Zovo extensions.
- The "More free viewers" list and the README list now show the 15 Zovo extensions on the Marketplace under their current names, and 11 that are coming soon.
- Extensions for related files now come first, starting with GGUF, Safetensors & NPY Viewer (NumPy Viewer) and CSV Viewer, Excel Viewer & Parquet Viewer.

## 0.1.0

- First release. Opens `.pkl` and `.pickle` files by default and `.p` files from the Explorer menu, without Python.
- Tree with Python types, NumPy arrays with stats and a heatmap, pandas DataFrames as a table, an opcode listing and a safety check.
- Decoding runs in a worker thread. Files over 512 MB show a message and are not read.
