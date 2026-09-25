import { ChatView } from '@/components/ChatView';

export default async function ChatPage({ params }: PageProps<'/messages/[assignmentId]'>) {
  const { assignmentId } = await params;
  return <ChatView assignmentId={assignmentId} />;
}
