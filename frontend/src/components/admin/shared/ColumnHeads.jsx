import React from 'react';

/**
 * A table's header row: one `<th scope="col">` per label. Every cell gets
 * `cellClassName`; the last one gets `lastCellClassName` when it differs
 * (a last column without right padding, say).
 *
 * @param {object} props
 * @param {string[]} props.labels
 * @param {string} props.cellClassName
 * @param {string} [props.lastCellClassName]
 */
export default function ColumnHeads({ labels, cellClassName, lastCellClassName = cellClassName }) {
  const last = labels.length - 1;
  return (
    <tr>
      {/* Keyed by position and label: two blank headers would share a key
          if the label were used alone. */}
      {labels.map((label, index) => (
        <th
          key={`${index}-${label}`}
          scope="col"
          className={index === last ? lastCellClassName : cellClassName}
        >
          {label}
        </th>
      ))}
    </tr>
  );
}
