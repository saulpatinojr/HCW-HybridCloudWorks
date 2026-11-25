/**
 * A table's header row from a list of columns, each [label, className].
 * Used where a page's tables had their <th> cells written out one by one.
 */
import React from 'react';

export default function ColumnHeads({ className, columns }) {
  return (
    <thead>
      <tr className={className}>
        {columns.map(([label, cellClass]) => (
          <th key={label} scope="col" className={cellClass}>
            {label}
          </th>
        ))}
      </tr>
    </thead>
  );
}
