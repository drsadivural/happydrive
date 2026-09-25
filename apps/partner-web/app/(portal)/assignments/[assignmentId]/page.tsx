import { AssignmentDetail } from '@/components/AssignmentDetail';

export default async function AssignmentPage({ params }: PageProps<'/assignments/[assignmentId]'>) {
  const { assignmentId } = await params;
  return <AssignmentDetail assignmentId={assignmentId} />;
}
