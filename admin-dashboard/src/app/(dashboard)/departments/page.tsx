'use client';

import { useState } from 'react';
import { DepartmentTable } from '@/components/departments/DepartmentTable';
import { AddDepartmentModal } from '@/components/departments/AddDepartmentModal';
import { PageHeader } from '@/components/layout/PageHeader';
import { Plus, Download } from 'lucide-react';

export default function DepartmentsPage() {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="p-8 space-y-8 max-w-[1400px]">
      <PageHeader
        eyebrow="Org Structure"
        title="Departments"
        subtitle="Organize and manage your company departments."
        actions={
          <>
            <button className="btn-secondary">
              <Download className="w-4 h-4" />
              Export
            </button>
            <button onClick={() => setModalOpen(true)} className="btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              Add Department
            </button>
          </>
        }
      />

      <DepartmentTable />
      <AddDepartmentModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
