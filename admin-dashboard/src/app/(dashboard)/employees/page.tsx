'use client';

import { useState } from 'react';
import { EmployeeTable } from '@/components/employees/EmployeeTable';
import { MsiStaffTable } from '@/components/employees/MsiStaffTable';
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
        subtitle="Mail accounts and MSI staff, managed separately."
        actions={
          <>
            <button className="btn-secondary">
              <Download className="w-4 h-4" />
              Export
            </button>
            <button onClick={() => setModalOpen(true)} className="btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              Add Mail Account
            </button>
          </>
        }
      />

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Mail accounts</h2>
          <p className="text-sm text-gray-500">Company mailboxes and people who sign in with an email address.</p>
        </div>
        <EmployeeTable />
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">MSI staff</h2>
          <p className="text-sm text-gray-500">
            Only submit the MSI Daily Report. They sign in on the Employee Portal with their name as username and
            their name in CAPITALS as password.
          </p>
        </div>
        <MsiStaffTable />
      </section>
      <AddEmployeeModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
