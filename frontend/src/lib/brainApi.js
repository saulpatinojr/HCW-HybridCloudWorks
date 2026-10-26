import { getJSON, postJSON } from '@/lib/api';
const path = (action, params = {}) => {
  const query = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)])
  );
  return `cms/brain/${action}${query.size ? `?${query}` : ''}`;
};
export const brainApi = {
  status: () => getJSON(path('status')),
  list: (params) => getJSON(path('items', params)),
  get: (id) => getJSON(path(`items/${encodeURIComponent(id)}`)),
  save: (item, version, mutationId) => postJSON(path('items'), { item, version, mutationId }),
  history: (id, before) => getJSON(path(`history/${encodeURIComponent(id)}`, { before })),
  search: (params = {}) => postJSON(path('search'), params),
  graph: (params) => getJSON(path('graph', params)),
  reindex: () => postJSON(path('reindex'), {}),
  ask: (question, mode, contextId) => postJSON(path('ask'), { question, mode, contextId }),
  context: (contentId) => getJSON(path('context', { contentId })),
  draft: (id, fields, requestId) =>
    postJSON(path(`draft/${encodeURIComponent(id)}`), { fields, requestId }),
};
