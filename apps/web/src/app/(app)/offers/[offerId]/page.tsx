import { OfferDetail } from '../../../../components/offers-screen';

export default async function OfferPage({ params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
  return <OfferDetail offerId={offerId} />;
}
