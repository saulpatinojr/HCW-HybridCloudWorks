// How a provider is named on the AI Engine page. Re-exported by
// selectionModel.js, where the rest of the page's rules live.

/**
 * The media providers' names (ADR 0034 slice 5, #860). They have no card —
 * a key is what switches them on — so no document carries a name for them;
 * these are provider names, not model ids, which never appear in UI code.
 */
export const MEDIA_PROVIDER_LABELS = Object.freeze({
  elevenlabs: 'ElevenLabs',
  replicate: 'Replicate',
});

/** A provider's display name: the card's, else a media provider's, else the id. */
export function providerLabel(id, providers = []) {
  return providers.find((p) => p.id === id)?.name || MEDIA_PROVIDER_LABELS[id] || id;
}
