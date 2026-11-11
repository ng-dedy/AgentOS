"use client";

import { useRouter } from "next/navigation";
import { AgentForm } from "@/components/agent-form";
import { PageHeader } from "@/components/common";
import { Card, CardContent } from "@/components/ui";

export default function NewAgentPage() {
  const router = useRouter();
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Create agent" description="Agents can only use the tools you allow here, and cannot change their own settings." />
      <Card>
        <CardContent className="pt-5">
          <AgentForm onSaved={(a) => router.push(`/agents/${a.id}`)} />
        </CardContent>
      </Card>
    </div>
  );
}
