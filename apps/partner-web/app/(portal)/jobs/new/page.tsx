import { JobEditor } from '@/components/JobEditor';

export default async function NewJobPage({ searchParams }: PageProps<'/jobs/new'>) {
  const sp = await searchParams;
  const from = typeof sp.from === 'string' && /^[0-9a-fA-F-]{36}$/.test(sp.from) ? sp.from : undefined;
  return <JobEditor mode="create" fromJobId={from} />;
}
