import { CandidateProfileScreen } from '../../../../components/candidate-profile';

export default async function CandidatePage({ params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId } = await params;
  return <CandidateProfileScreen candidateId={candidateId} />;
}
