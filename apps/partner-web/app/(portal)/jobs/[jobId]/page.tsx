import { JobDetail } from '@/components/JobDetail';

export default async function JobDetailPage({ params }: PageProps<'/jobs/[jobId]'>) {
  const { jobId } = await params;
  return <JobDetail jobId={jobId} />;
}
