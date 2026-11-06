## Size limit

`pickleViewer.maxFileMB` (default 512) is the largest file PKL Viewer decodes. A bigger file shows a message and is not read. Decoding runs in a background thread, so VS Code stays responsive while a big file loads.
