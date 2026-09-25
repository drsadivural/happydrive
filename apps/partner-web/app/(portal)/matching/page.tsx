import { MatchingView } from '@/components/MatchingView';

export default async function MatchingPage({ searchParams }: PageProps<'/matching'>) {
  const sp = await searchParams;
  const job = typeof sp.job === 'string' && /^[0-9a-fA-F-]{36}$/.test(sp.job) ? sp.job : undefined;
  return <MatchingView initialJobId={job} />;
}
