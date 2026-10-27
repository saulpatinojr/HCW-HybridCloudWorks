/** Intake status is advisory: recording it must never fail a completed import. */
export async function recordRun(store, source, status, { fetchedAt, itemCount } = {}) {
  if (!source?.id) return;
  try {
    await store.upsertDoc('admin_settings', {
      id: `run-${source.id}`,
      settingKind: 'blog_source_run',
      sourceId: source.id,
      status,
      fetchedAt,
      ...(Number.isFinite(itemCount) ? { itemCount } : {}),
    });
  } catch {
    // The content/cache writes remain authoritative when this diagnostic is unavailable.
  }
}
