/**
 * The value of the first field in `keys` that is set (truthy) on `record`,
 * or `fallback` when none is. Gives the same result as writing
 * `record.a || record.b || ... || fallback`, for records whose fields come
 * in several spellings (old and new documents, different feeds).
 *
 * @param {object|null|undefined} record
 * @param {string[]} keys
 * @param {*} fallback
 */
export function firstField(record, keys, fallback) {
  for (const key of keys) {
    if (record?.[key]) return record[key];
  }
  return fallback;
}
