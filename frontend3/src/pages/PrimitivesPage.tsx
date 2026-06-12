import {
  Activity,
  CheckCircle2,
  Clock,
  Inbox,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';

import { ThemePicker } from '@/components/layout/ThemePicker';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Empty,
  Input,
  StatTile,
  StatusBadge,
  TonePill,
} from '@/components/ui';
import { useTheme } from '@/contexts/ThemeContext';

// /primitives — a self-contained playground showing every UI primitive in
// the currently-active theme. Used to verify visual coherence in every
// theme via the matrix capture script.
export function PrimitivesPage() {
  const { variant } = useTheme();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <img src={variant.logoPath} alt="" className="h-8 w-8 rounded" />
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] font-semibold text-muted-foreground">
                Acufy AI Timesheet
              </p>
              <p className="text-sm font-semibold leading-none text-foreground">
                frontend3 · /primitives
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <p className="hidden sm:block text-xs text-muted-foreground">
              Active theme: <span className="font-medium text-foreground">{variant.label}</span>
            </p>
            <ThemePicker />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8 space-y-10">
        {/* Buttons */}
        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-3">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">
              <Trash2 className="h-4 w-4" />
              Destructive
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Button size="sm">Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg">Large</Button>
            <Button disabled>Disabled</Button>
          </div>
        </Section>

        {/* Pills (raw classes — used by nav) */}
        <Section title="Pills (nav vocabulary)">
          <div className="flex flex-wrap items-center gap-2">
            <button className="pill pill-active">Active</button>
            <button className="pill pill-idle">Idle</button>
            <button className="pill pill-idle bg-muted">Idle (muted bg)</button>
            <button className="pill pill-active">
              <CheckCircle2 className="h-4 w-4" />
              With icon
            </button>
            <button className="pill pill-active">
              Pending
              <span className="ml-1 rounded-full bg-white/20 px-1.5 text-[10px]">10</span>
            </button>
          </div>
        </Section>

        {/* Stat tiles */}
        <Section title="Stat tiles">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile Icon={Clock} tone="amber" label="Pending" value={36} hint="awaiting review" />
            <StatTile Icon={Activity} tone="sky" label="Under review" value={2} hint="open right now" />
            <StatTile Icon={CheckCircle2} tone="emerald" label="Approved" value={28} hint="this month" />
            <StatTile Icon={Users} tone="violet" label="Team" value={6} hint="direct reports" />
          </div>
          <div className="grid grid-cols-2 gap-3 pt-2 lg:grid-cols-4">
            <StatTile Icon={Sparkles} tone="primary" label="Brand" value={'★'} hint="primary tone" />
            <StatTile Icon={Inbox} tone="rose" label="Rose" value={3} hint="rose tone" />
          </div>
        </Section>

        {/* Status badges — both tables */}
        <Section title="Status badges">
          <div className="space-y-3">
            <div>
              <p className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-2">
                Timesheet statuses
              </p>
              <div className="flex flex-wrap gap-2">
                <StatusBadge status="draft" />
                <StatusBadge status="submitted" />
                <StatusBadge status="approved" />
                <StatusBadge status="rejected" />
              </div>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-2">
                Ingestion statuses
              </p>
              <div className="flex flex-wrap gap-2">
                <StatusBadge status="pending" variant="ingestion" />
                <StatusBadge status="under_review" variant="ingestion" />
                <StatusBadge status="approved" variant="ingestion" />
                <StatusBadge status="rejected" variant="ingestion" />
                <StatusBadge status="on_hold" variant="ingestion" />
                <StatusBadge status="skipped" variant="ingestion" />
              </div>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-2">
                Tone pills (ad-hoc, for role tags etc.)
              </p>
              <div className="flex flex-wrap gap-2">
                <TonePill tone="success">Success</TonePill>
                <TonePill tone="warning">Warning</TonePill>
                <TonePill tone="info">Info</TonePill>
                <TonePill tone="danger">Danger</TonePill>
                <TonePill tone="neutral">Neutral</TonePill>
                <TonePill tone="brand">Brand</TonePill>
              </div>
            </div>
          </div>
        </Section>

        {/* Inputs */}
        <Section title="Form inputs">
          <div className="grid grid-cols-2 gap-3">
            <Input placeholder="Email" type="email" />
            <Input placeholder="Password" type="password" />
            <Input placeholder="Disabled" disabled />
            <Input placeholder="Pre-filled" defaultValue="John Doe" />
          </div>
        </Section>

        {/* Card with header/body */}
        <Section title="Cards">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <p className="text-sm font-semibold text-foreground">Header section</p>
                <Button size="sm" variant="ghost">
                  Action
                </Button>
              </CardHeader>
              <CardBody>
                <p className="text-sm text-muted-foreground">
                  Cards consume the theme <code>card</code> token so they re-tint with the theme. The
                  header divider uses <code>border</code>.
                </p>
              </CardBody>
            </Card>
            <Card className="p-4">
              <p className="text-sm font-semibold text-foreground mb-1">Compact card</p>
              <p className="text-sm text-muted-foreground">
                Without CardHeader/CardBody — just a padded surface. The 2xl-rounded shape is the
                default for every primary container.
              </p>
            </Card>
          </div>
        </Section>

        {/* Empty state */}
        <Section title="Empty state">
          <Empty
            Icon={Inbox}
            title="No timesheets here"
            description="Submit a week to see it appear in this list."
            action={<Button>Submit week</Button>}
          />
        </Section>

        <footer className="border-t border-border pt-6 text-xs text-muted-foreground">
          <p>
            Every component uses theme CSS custom properties for its tinting; semantic status tones
            stay fixed. Use the palette icon in the top-right to switch themes — everything re-tints
            without a reload.
          </p>
        </footer>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <p className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">{title}</p>
      {children}
    </section>
  );
}
