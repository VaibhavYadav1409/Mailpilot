'use client';

import { useState } from 'react';
import { EmployeeTable } from '@/components/employees/EmployeeTable';
import { AddEmployeeModal } from '@/components/employees/AddEmployeeModal';
import { PageHeader } from '@/components/layout/PageHeader';
import { Plus, Download } from 'lucide-react';

export default function EmployeesPage() {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="p-8 space-y-8 max-w-[1400px]">
      <PageHeader
        eyebrow="Crew Roster"
        title="Employees"
        subtitle="Manage and monitor your team members."
        actions={
          <>
            <button className="btn-secondary">
              <Download className="w-4 h-4" />
              Export
            </button>
            <button onClick={() => setModalOpen(true)} className="btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              Add Employee
            </button>
          </>
        }
      />

      <EmployeeTable />
      <AddEmployeeModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
