# Third-party notices

## pickleparser 0.2.1

The pickle stack machine in `src/core/unpickler.js` and the opcode reader in `src/core/opcodes.js` follow the design of pickleparser by ewfian (https://github.com/ewfian/pickleparser). This copy is changed: names are never resolved or called, tuples, bytes and sets keep their type, LONG1 and LONG4 are signed, and big lists do not overflow the stack.

MIT License

Copyright (c) 2023 ewfian

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Our own code reused

`src/core/dtypes.js` and the heatmap colors come from Zovo's GGUF, Safetensors & NPY Tensor Viewer. `src/rate.js` comes from Zovo's audio preview extension.
