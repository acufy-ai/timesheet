import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Briefcase, Loader2 } from 'lucide-react';

import { Empty, Toast } from '@/components/ui';
import { clientPortalApi } from '@/api/client';
import { ProjectCard } from './ClientPortalPage';

// A single client project, opened from the sidebar project list. Reuses the
// same scoped data (`myProjects`) and the same ProjectCard the overview uses, so
// behavior + capability gating stay identical — just focused on one project.
export function ClientProjectDetailPage() {
  const { id } = useParams();
  const projectId = Number(id);
  const qc = useQueryClient();
  const projectsQ = useQuery({
    queryKey: ['client-portal', 'projects'],
    queryFn: () => clientPortalApi.myProjects().then((r) => r.data),
  });
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const flashAndFade = (tone: 'ok' | 'err', text: string) => {
    setFlash({ tone, text });
    window.setTimeout(() => setFlash(null), 4000);
  };
  const refresh = () => qc.invalidateQueries({ queryKey: ['client-portal', 'projects'] });

  const project = (projectsQ.data ?? []).find((p) => p.id === projectId) ?? null;

  return (
    <div className="space-y-5">
      <Link to="/portal" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-primary">
        <ArrowLeft className="h-4 w-4" /> All projects
      </Link>

      {flash ? (
        <Toast tone={flash.tone} message={flash.text} onDismiss={() => setFlash(null)} />
      ) : null}

      {projectsQ.isLoading ? (
        <div className="grid place-items-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : !project ? (
        <Empty Icon={Briefcase} title="Project not found"
          description="This project may no longer be shared with you. Pick another from the list on the left." />
      ) : (
        <ProjectCard
          project={project}
          open
          onToggle={() => { /* always open on the detail page */ }}
          onFlash={flashAndFade}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
