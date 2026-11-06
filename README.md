# PKL Viewer & Pickle Viewer

Open Python `.pkl`, `.pickle` and `.p` files in VS Code without Python, and see what a pickle would do before you load it.

![PKL Viewer showing a pickle as a tree with types, a custom class placeholder and the "Opened without Python" header](images/tree.png)

*Screenshot of VS Code 1.142 with a sample made by `scripts/make_samples.py`.*

- Nothing runs. The file is decoded by a reader that never imports or calls anything, so a hostile pickle cannot touch your machine.
- Your data stays readable. You get a tree with Python types, NumPy arrays with stats and a heatmap, and pandas DataFrames as a table.
- A safety check that lists every name the file would import or call in Python, with risky ones like `os.system` and `builtins.eval` flagged.

## Quick start

1. Install PKL Viewer & Pickle Viewer.
2. Click a `.pkl` or `.pickle` file in the Explorer. For a `.p` file, right-click it and pick Open in PKL Viewer.

## What you see

| Tab | Shows |
|---|---|
| Tree | The decoded object with types, lengths and values. Dicts keep any key type, tuples stay tuples, and bytes, sets, datetimes and big integers keep their Python type. A class the viewer cannot rebuild shows as a placeholder named `module.Class`, with the attributes the file stores for it. |
| Arrays | NumPy arrays rebuilt from their bytes when the dtype is a plain number type. It shows the shape, dtype, order, min, max, mean, NaN count, a heatmap for 2-D and larger arrays, and a grid of the first values. |
| Tables | pandas DataFrames as a table, with column dtypes and the index, when the column blocks are plain numbers, bools or Python objects. Other column types fall back to the tree with a note. |
| Opcodes | A listing like `pickletools.dis`, with byte offsets, MARK nesting and a count of each opcode. |
| Safety | Every GLOBAL, STACK_GLOBAL, REDUCE and BUILD target, with the byte where it appears and the arguments a call gets. |

![Safety tab flagging os.system in a pickle](images/safety.png)

## The safety check

`pickle.load` imports every name in a GLOBAL or STACK_GLOBAL opcode and then calls the REDUCE targets. That is how a model file from the internet can run a shell command. PKL Viewer lists those names and rates each one as the table below shows.

| Rating | Meaning | Examples |
|---|---|---|
| Risky | Runs commands or code, or touches files or the network | `os.system`, `subprocess.Popen`, `builtins.eval`, `builtins.exec`, `socket`, `shutil` |
| Check | Helpers that attacks chain together | `builtins.getattr`-style helpers, `operator.attrgetter`, `functools.partial` |
| Needs package | A class from a package outside the standard data types | your own classes, `__main__.Model` |
| Data type | Plain data | NumPy, pandas, datetime, collections |

When a file is risky, a red banner says what it would call, for example `os.system('true',)`, and the viewer opens on the Safety tab. A clean list is not a promise that a file is safe, so only load pickles you trust.

![NumPy array with stats and a heatmap](images/arrays.png)

![pandas DataFrame shown as a table](images/table.png)

## Formats

- Pickle protocols 0 to 5, including Python 2 strings, out-of-band buffers (shown as placeholders) and persistent ids (shown as placeholders, as in PyTorch files).
- NumPy arrays from protocol 2 (`_reconstruct`) and protocol 5 (`_frombuffer`), C or Fortran order, NumPy 1.x and 2.x names.
- pandas DataFrames in the pandas 2.x layout and the older block manager layout.

## Big files

Decoding runs in a worker thread, so VS Code stays responsive. Files over 512 MB show a message and are not read (setting `pickleViewer.maxFileMB`, up to 2048). Large containers show their first 1,000 items, the tree stops at 50,000 nodes, tables show the first 1,000 rows and the opcode listing shows the first 20,000 lines. The opcode counts and the safety check always cover the whole file.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `pickleViewer.maxFileMB` | 512 | Largest file to decode. |
| `pickleViewer.askForRating` | true | Ask one time for a rating after a few days of use. |

## Privacy

PKL Viewer works offline. It makes no network calls and sends no telemetry. The webview runs under a strict Content Security Policy, and file text is always inserted as text.

## Limits

- Joblib files with compressed arrays, PyTorch `.pt` zip archives and `.npy` files are not pickles in this sense and are not opened.
- datetime64, structured and string dtypes of NumPy show in the tree and the grid, not as numbers.
- pandas Series, Categorical, nullable and Arrow columns show in the tree.
- `.p` opens by choice, not by default, because Progress ABL uses the same extension for source code.

## Support

Zovo extensions have no ads and no tracking, and sponsors pay for the time that goes into fixes and new viewers. You can sponsor the work on [GitHub Sponsors](https://github.com/sponsors/theluckystrike).

## More viewers by Zovo

- [GGUF, Safetensors & NPY Viewer (NumPy Viewer)](https://marketplace.visualstudio.com/items?itemName=zovo.tensor-viewer) shows NPY, NPZ, Safetensors and GGUF tensors with stats and heatmaps.
- [CSV Viewer, Excel Viewer & Parquet Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.table-viewer-vscode) opens CSV, TSV, Excel and Parquet files as a sortable, filterable table.
- [HDF5 & NetCDF Explorer (H5 Viewer)](https://marketplace.visualstudio.com/items?itemName=zovo.hdf5-netcdf-explorer) browses groups, attributes and values in HDF5 and NetCDF files and plots slices.
- [PDF Viewer & PDF Reader with Dark Mode](https://marketplace.visualstudio.com/items?itemName=zovo.pdf-viewer-dark) reads PDFs with a real dark mode, search, an outline and thumbnails.
- [DOCX Viewer & Word Viewer with Dark Mode](https://marketplace.visualstudio.com/items?itemName=zovo.docx-viewer-vscode) previews Word and ODT files with dark mode, an outline and search.
- [PPTX Viewer & PowerPoint Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.pptx-slide-viewer) shows PowerPoint slides, thumbnails and speaker notes.
- [Large JSON Viewer & JSON Tree](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-json-tree-viewer) shows large JSON files as a searchable tree, copies JSONPath and turns arrays of objects into a table.
- [JSONL Viewer & NDJSON Table Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-jsonl-viewer) opens JSONL and NDJSON files as a table, as records or as a chat view.
- [SQLite Viewer & DB Viewer (Read-Only)](https://marketplace.visualstudio.com/items?itemName=zovo.sqlite-table-viewer) browses SQLite tables read-only and runs SELECT queries.
- [MP4 Video Player & Video Preview with Sound](https://marketplace.visualstudio.com/items?itemName=zovo.video-preview-with-sound) plays MP4, MOV, MKV and WebM files with their sound.
- [DXF Viewer & CAD Viewer for 2D Drawings](https://marketplace.visualstudio.com/items?itemName=zovo.dxf-viewer) opens ASCII and binary DXF drawings with layers, measuring and PNG or SVG export.
- [AGENTS.md & CLAUDE.md Linter (Context Drift)](https://marketplace.visualstudio.com/items?itemName=zovo.context-drift) finds stale commands, paths and versions in AGENTS.md and CLAUDE.md files.
- [Agent Skills & Claude Skills (Skill Shelf)](https://marketplace.visualstudio.com/items?itemName=zovo.skill-shelf) lists, checks and toggles the Agent Skills that Claude Code, Codex and Cursor load.
- [Claude Code History & Codex History Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.agent-session-viewer) browses and searches your local Claude Code and Codex sessions.
- [Claude Code Usage & Codex Usage Cost Meter](https://marketplace.visualstudio.com/items?itemName=zovo.ai-usage-meter) shows Claude Code and Codex tokens and estimated cost from your local session files.

Coming soon to the Marketplace, with the code on GitHub now.

- [Avro Viewer, Arrow Viewer & Feather Viewer](https://github.com/theluckystrike/arrow-avro-viewer-vscode) opens Avro, Arrow and Feather files as a paged table.
- [Audio Preview & Loudness Meter](https://github.com/theluckystrike/audio-preview-vscode) plays audio files with a waveform, a spectrogram and LUFS loudness.
- [Graphviz Preview & DOT Viewer](https://github.com/theluckystrike/graphviz-preview-vscode) shows a live preview of DOT files and exports SVG or PNG.
- [TIFF Viewer (16-bit, Float, GeoTIFF)](https://github.com/theluckystrike/tiff-viewer-vscode) opens 16-bit, float, multi-page and GeoTIFF images.
- [EML Viewer & MBOX Email Viewer](https://github.com/theluckystrike/eml-viewer-vscode) reads EML, EMLX and MBOX email files with remote images blocked.
- [3D Model Viewer (GLB, glTF, STL, OBJ, PLY)](https://github.com/theluckystrike/model-viewer-vscode) views GLB, glTF, STL, OBJ, PLY and 3MF models.
- [DICOM Viewer & NIfTI Viewer for CT and MRI](https://github.com/theluckystrike/dicom-nifti-viewer-vscode) opens CT and MRI scans, DICOM folders and NIfTI volumes with window presets and three views.
- [ZIP Viewer & Archive Explorer (JAR, TAR, GZ)](https://github.com/theluckystrike/archive-explorer-vscode) browses ZIP, JAR, VSIX, TAR and GZ files, opens entries in tabs and extracts them safely.
- [GCode Viewer & 3D Print Preview](https://github.com/theluckystrike/gcode-viewer-vscode) shows GCode toolpaths in 3D layer by layer, with print time and filament use.
- [EPUB Reader & EPUB Viewer](https://github.com/theluckystrike/epub-reader-vscode) reads EPUB books with a table of contents, search and light, sepia or dark themes.
- [File Viewers Pack](https://github.com/theluckystrike/zovo-file-viewers) installs the PDF, table, Word, PowerPoint, HDF5 and tensor viewers in one step.

## License

MIT. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the pickleparser notice.
