## Arrays and tables

- NumPy arrays are rebuilt from the bytes in the file when the dtype is a plain number type (bool, int, uint, float, complex). The Arrays tab shows the shape, dtype, min, max and mean, a heatmap for 2-D and larger arrays, and a grid with the first values.
- pandas DataFrames show as a table when the column blocks use plain dtypes or Python objects. Other column types (Categorical, nullable integers, Arrow strings) fall back to the tree, with a note that says why.
- Custom classes stay as placeholders named module.Class, with the attributes the file stores for them.
