## Check a file before you load it

`pickle.load` imports every name in a GLOBAL or STACK_GLOBAL opcode and calls every REDUCE target. That is how a pickle can run `os.system` on your machine.

The Safety tab lists those names with the byte where each one appears, and rates each one:

- Risky: runs commands, runs code, touches files or the network (os, subprocess, builtins.eval, builtins.exec and similar).
- Check: helpers that attacks chain together, such as getattr or operator.attrgetter.
- Needs package: a class from a package outside the standard data types.
- Data type: NumPy, pandas, datetime, collections and other plain data.

PKL Viewer reads these names. It never imports or calls them.
