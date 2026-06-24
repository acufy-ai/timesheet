import type { ManagedUser } from '@/types/admin';

// Resolve who may be staffed onto a project or task, honoring the workspace
// "allow cross-team staffing" setting.
//
//   OFF (default): only employees who report (org tree) to one of the project's
//                  selected PMs. Keeps staffing inside the project's chain.
//   ON:            widen to the client's whole management chain + their reports —
//                  i.e. anyone reporting to ANY PM on the client. Lets specialists
//                  from other teams be staffed without opening the entire tenant.
//
// The backend auto-adds a chosen assignee to the project roster, so this pool
// only governs what the picker OFFERS, not what's ultimately permitted.
export function staffingPool(
  users: ManagedUser[],
  opts: { pmIds: number[]; clientPmIds: number[]; allowCrossTeam: boolean },
): ManagedUser[] {
  const { pmIds, clientPmIds, allowCrossTeam } = opts;
  // The set of managers whose reports are eligible. Restricted = the project's
  // selected PMs; widened = every PM on the client.
  const eligibleManagerIds = new Set(allowCrossTeam ? clientPmIds : pmIds);
  if (eligibleManagerIds.size === 0) return [];
  return users
    .filter((u) => u.manager_id != null && eligibleManagerIds.has(u.manager_id))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}
