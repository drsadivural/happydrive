import { UserDetail } from '@/components/UserDetail';

export default async function UserPage({ params }: PageProps<'/users/[userId]'>) {
  const { userId } = await params;
  return <UserDetail userId={userId} />;
}
