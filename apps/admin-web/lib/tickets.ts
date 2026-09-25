import type { components } from '@happydrive/contracts';

type Ticket = components['schemas']['SupportTicket'];

/** マッチングへの異議申立て（POST /matching/appeals）は category=matching_appeal */
export function isAppeal(t: Pick<Ticket, 'category'>): boolean {
  return t.category === 'matching_appeal';
}
