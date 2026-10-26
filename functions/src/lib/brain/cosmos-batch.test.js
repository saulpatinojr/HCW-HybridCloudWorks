import { describe, it, expect, vi } from 'vitest';
const batch = vi.hoisted(() => vi.fn());
vi.mock('../cosmos-client.js', () => ({
  getContainer: () => ({ items: { batch } }),
}));
import { cosmosBrainBatch } from './repository.js';
describe('Cosmos transaction boundary', () => {
  it('sends all operations to one explicitly scoped owner partition', async () => {
    batch.mockResolvedValueOnce({ code: 200, result: [{ statusCode: 201 }] });
    const operations = [
      {
        operationType: 'Create',
        resourceBody: { id: 'note', ownerId: 'owner' },
      },
    ];
    await cosmosBrainBatch('owner', operations);
    expect(batch).toHaveBeenCalledWith(operations, 'owner');
  });
  it('does not report success when a record precondition fails inside the batch', async () => {
    batch.mockResolvedValueOnce({
      code: 207,
      result: [{ statusCode: 424 }, { statusCode: 412 }],
    });
    await expect(cosmosBrainBatch('owner', [])).rejects.toMatchObject({
      code: 412,
    });
  });
});
