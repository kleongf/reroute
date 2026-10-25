import type { Offer } from '@backend/domain/types.ts';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils.ts';
import { offerText } from './model.ts';

const TONE = {
  pending: 'bg-amber-100 text-amber-900',
  accepted: 'bg-emerald-100 text-emerald-900',
  declined: 'bg-red-100 text-red-900',
  unanswered: 'bg-red-100 text-red-900',
} as const satisfies Record<Offer['status'], string>;

/** An Offer's status, including the simulated Offer label. */
export function OfferBadge({ offer }: { offer: Offer }) {
  return (
    <Badge
      variant="secondary"
      data-offer-status={offer.status}
      className={cn('h-auto max-w-full text-left whitespace-normal', TONE[offer.status])}
    >
      {offerText(offer)}
    </Badge>
  );
}
