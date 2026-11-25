/**
 * Small builders for the rows the provider education catalogues repeat. Each
 * returns the same plain object the education pages read, keys in the same
 * order, so a catalogue lists its rows one per line or two.
 */

/** A learning path's modules, from their titles. */
export const titledModules = (...titles) => titles.map((title) => ({ title }));

/**
 * A link on the Resources strip. `[type, icon]` is the label shown above the
 * card and the icon beside it.
 */
export const resourceRow = (id, title, [type, icon], url, description) => ({
  id,
  title,
  description,
  type,
  icon,
  url,
});
