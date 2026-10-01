'use client';

import { useState } from 'react';
import { EmployeeTable } from '@/components/employees/EmployeeTable';
import { MsiStaffTable } from '@/components/employees/MsiStaffTable';
import { AddEmployeeModal } from '@/components/employees/AddEmployeeModal';
import { PageHeader } from '@/components/layout/PageHeader';
import { Plus, FileSpreadsheet, Mail } from 'lucide-react';
import { cn } from '@/utils/cn';

type Tab = 'mis' | 'mail';

export default function EmployeesPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('mis');

  const tabs: { key: Tab; label: string; icon: typeof Mail; hint: string }[] = [
    {
      key: 'mis',
      label: 'MIS staff',
      icon: FileSpreadsheet,
      hint: 'People who fill an MIS spreadsheet. They sign in on the Employee Portal with their name as username and their name in CAPITALS as password.',
    },
    { key: 'mail', label: 'Mail accounts', icon: Mail, hint: 'Company mailboxes and people who sign in with an email address.' },
  ];
  const current = tabs.find((t) => t.key === tab)!;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-[1400px]">
      <PageHeader
        eyebrow="Crew Roster"
        title="Employees"
        subtitle="MIS staff and mail accounts are managed separately."
        actions={
          tab === 'mail' ? (
            <button onClick={() => setModalOpen(true)} className="btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              Add Mail Account
            </button>
          ) : undefined
        }
      />

      <div className="flex items-center gap-1 border-b border-gray-200 dark:border-gray-800">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              '-mb-px flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
              tab === t.key ? 'border-primary text-primary' : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200',
            )}
          >
            <t.icon className="w-4 h-4" /> {t.label}
          </button>
        ))}
      </div>
      <p className="text-sm text-gray-500 -mt-3">{current.hint}</p>

      {tab === 'mis' ? <MsiStaffTable /> : <EmployeeTable />}
      <AddEmployeeModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
