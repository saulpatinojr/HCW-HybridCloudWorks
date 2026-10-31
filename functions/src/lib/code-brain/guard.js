import { createWorkspaceSyncGuard } from '../brain/guard.js';
import { CODE_SYNC_SCOPE } from './config.js';

let guard;
/** The only guard the Code Conductor brain's routes use: code_brain_sync tokens. */
export function getCodeBrainSyncGuard() {
  guard ||= createWorkspaceSyncGuard(CODE_SYNC_SCOPE);
  return guard;
}
