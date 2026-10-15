/**
 * What the Image Gallery does to images (split out of ImageGalleryPage.jsx
 * for PR #841): bulk actions that patch each selected image against its own
 * document (POST cms/images/bulk), the per-image save and permanent delete,
 * copy, reuse, folders, and the one status sentence each of them leaves.
 */
import { useState } from 'react';
import {
  bulkGalleryImages,
  deleteGalleryImage,
  saveGalleryFolders,
  updateGalleryImage,
} from '@/lib/imageGallery';
import { resolveMediaUrl } from '@/lib/functionsBase';
import {
  DEFAULT_FILTERS,
  bulkClearsSelection,
  bulkClosesDetails,
  bulkMessage,
  deletionMessage,
  reason,
} from './galleryPageModel';

/**
 * @param {ReturnType<import('./useGalleryListing').default>} listing
 * @param {ReturnType<import('./useGallerySelection').default>} selection
 * @param {(to: string) => void} navigate
 */
export default function useGalleryActions({ listing, selection, navigate }) {
  const { items, refresh, setError, setFilters, setPersistedFolders } = listing;
  const { clearSelection, deselect, withBusy, setCopiedId, detailsId, setDetailsId } = selection;
  const [bulkBusy, setBulkBusy] = useState(false);
  const [message, setMessage] = useState('');

  const say = (text) => {
    setMessage(text);
    setError('');
  };
  const fail = (text) => setError(text);

  /** The selection and the open details after a bulk action has landed. */
  const settleAfterBulk = (targets, action) => {
    if (bulkClearsSelection(action)) {
      clearSelection();
      if (bulkClosesDetails(targets, action, detailsId)) setDetailsId('');
    }
    refresh();
  };

  const runBulk = async (targets, action, extra = {}) => {
    if (!targets.length) return;
    setBulkBusy(true);
    try {
      await withBusy(
        targets.map((t) => t.id),
        async () => {
          const res = await bulkGalleryImages(targets, action, extra);
          say(bulkMessage(action, extra, res));
          settleAfterBulk(targets, action);
        }
      );
    } catch (err) {
      fail(`${action} failed: ${reason(err)}`);
    } finally {
      setBulkBusy(false);
    }
  };

  const copyText = async (text, id) => {
    try {
      await navigator.clipboard.writeText(resolveMediaUrl(text));
      setCopiedId(id);
      setTimeout(() => setCopiedId(''), 2000);
    } catch (err) {
      fail(`Could not copy: ${reason(err)}`);
    }
  };

  const reuse = (item) => {
    if (item?.imageUrl)
      navigate(`/admin/new-content?reuseImage=${encodeURIComponent(item.imageUrl)}`);
  };

  const saveDetails = async (item, fields) => {
    try {
      await withBusy([item.id], async () => {
        await updateGalleryImage(item, fields);
        say(`"${fields.title || item.title}" saved.`);
        refresh();
      });
    } catch (err) {
      fail(`Save failed: ${reason(err)}`);
    }
  };

  const deleteOne = async (item) => {
    try {
      await withBusy([item.id], async () => {
        const res = await deleteGalleryImage(item);
        say(deletionMessage(item, res));
        setDetailsId('');
        deselect(item.id);
        refresh();
      });
    } catch (err) {
      fail(`Delete failed: ${reason(err)}`);
    }
  };

  const changeFolders = async (next) => {
    try {
      setPersistedFolders(await saveGalleryFolders(next));
    } catch (err) {
      fail(`Folders could not be saved: ${reason(err)}`);
    }
  };

  /** A variant on screen opens in place; one on another page becomes the search. */
  const openVariant = (id) => {
    if (items.some((item) => item.id === id)) setDetailsId(id);
    else setFilters({ ...DEFAULT_FILTERS, state: 'all', q: id });
  };

  return {
    message,
    say,
    bulkBusy,
    runBulk,
    copyText,
    reuse,
    saveDetails,
    deleteOne,
    changeFolders,
    openVariant,
  };
}
