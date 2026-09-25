import { JobEditor } from '@/components/JobEditor';

export default async function EditJobPage({ params }: PageProps<'/jobs/[jobId]/edit'>) {
  const { jobId } = await params;
  return <JobEditor mode="edit" jobId={jobId} />;
}
