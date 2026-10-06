import Workspace from '../models/workspace.model.js';

export const FOXPACK_SHOPPING_WORKSPACE = '6ab82a6847ab241dfafe4bc0';

const fail = (message, statusCode) => Object.assign(new Error(message), { statusCode });
const eligible = id => String(id || '') === FOXPACK_SHOPPING_WORKSPACE;
const scope = workspaceId => ({ _id: workspaceId, deleted_at: null, is_active: { $ne: false } });

export function createOrganizationToolsService(Workspaces = Workspace) {
  const status = async ({ workspaceId, actorId = null }) => {
    if (!eligible(workspaceId)) return { available: false, enabled: false, can_manage: false };
    const row = await Workspaces.findOne(scope(workspaceId)).select('user_id amazon_lookup_enabled').lean();
    if (!row) return { available: false, enabled: false, can_manage: false };
    return { available: true, enabled: row.amazon_lookup_enabled !== false,
      can_manage: Boolean(actorId && String(row.user_id) === String(actorId)) };
  };
  return {
    status,
    async set({ workspaceId, actorId, enabled }) {
      if (typeof enabled !== 'boolean') throw fail('enabled must be a boolean', 400);
      const current = await status({ workspaceId, actorId });
      if (!current.available) throw fail('Amazon lookup is not available in this workspace', 403);
      if (!current.can_manage) throw fail('Only the workspace owner can change this tool', 403);
      const result = await Workspaces.updateOne({ ...scope(workspaceId), user_id: actorId },
        { $set: { amazon_lookup_enabled: enabled } });
      if (result.matchedCount !== 1) throw fail('Workspace is no longer available', 409);
      return status({ workspaceId, actorId });
    },
    async isEnabled(workspaceId) {
      try { return (await status({ workspaceId })).enabled; }
      catch { return false; } // A settings/database failure must never start a lookup.
    }
  };
}

export default createOrganizationToolsService();
