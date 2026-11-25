import { useRef, useReducer } from 'react';

function stopEvent(e) {
  e.stopPropagation();
}

function leaveEvent() {}

/**
 * Unified drag-and-drop hook.
 * Uses refs for drag state so there's no re-render on every dragOver event —
 * only on dragEnter and dragEnd (when visible state actually changes).
 *
 * @param {Array}    items            - The array being reordered (used for bounds checking)
 * @param {Function} onReorder        - Called with (fromIndex, toIndex) when a drop completes
 * @param {Object}   [opts]
 * @param {boolean}  [opts.stopPropagation=false] - Add e.stopPropagation() to all handlers
 *                                                  (needed when modules are nested inside section draggables)
 */
export function useDragDrop(items, onReorder, { stopPropagation = false } = {}) {
  const draggedIndexRef = useRef(-1);
  const dragOverIndexRef = useRef(-1);
  // A single counter used only to force a re-render when visible drag state changes.
  const [, forceUpdate] = useReducer((n) => n + 1, 0);
  // Every handler calls this first; it stops the event only when asked to.
  const maybeStop = stopPropagation ? stopEvent : leaveEvent;

  // Forget the drag and re-render so no row stays highlighted.
  function clearDrag() {
    draggedIndexRef.current = -1;
    dragOverIndexRef.current = -1;
    forceUpdate();
  }

  function dragHandlers(index) {
    return {
      draggable: true,

      onDragStart(e) {
        maybeStop(e);
        draggedIndexRef.current = index;
        dragOverIndexRef.current = index;
        e.dataTransfer.effectAllowed = 'move';
        // Store index in dataTransfer for cross-component drops (defensive)
        e.dataTransfer.setData('text/plain', String(index));
      },

      onDragOver(e) {
        maybeStop(e);
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // No state update here — avoids re-render on every pixel of movement
      },

      onDragEnter(e) {
        maybeStop(e);
        e.preventDefault();
        if (draggedIndexRef.current < 0 || dragOverIndexRef.current === index) return;
        dragOverIndexRef.current = index;
        forceUpdate(); // Only re-render when the drop target visually changes
      },

      onDrop(e) {
        maybeStop(e);
        e.preventDefault();
        const from = draggedIndexRef.current;
        clearDrag();
        // A drop on the row it started from, or with no drag running, moves nothing.
        if (from >= 0 && from !== index) onReorder(from, index);
      },

      onDragEnd(e) {
        maybeStop(e);
        clearDrag();
      },
    };
  }

  function isDragging(index) {
    return draggedIndexRef.current === index;
  }

  function isDraggingOver(index) {
    return dragOverIndexRef.current === index && draggedIndexRef.current !== index;
  }

  return { dragHandlers, isDragging, isDraggingOver };
}
