'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/services/api';
import { X, Loader2 } from 'lucide-react';

interface Department {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

const ROLES = ['EMPLOYEE', 'MANAGER', 'ADMIN'] as const;

export function AddEmployeeModal({ open, onClose }: Props) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    employeeCode: '',
    email: '',
    firstName: '',
    lastName: '',
    role: 'EMPLOYEE' as (typeof ROLES)[number],
    departmentId: '',
  });
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [error, setError] = useState('');

  const { data: departments } = useQuery({
    queryKey: ['departments'],
    queryFn: async () => {
      const { data } = await api.get<Department[]>('/departments');
      return data;
    },
    enabled: open,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post('/employees', {
        ...form,
        departmentId: form.departmentId || null,
      });
      return data;
    },
    onSuccess: (data) => {
      setTempPassword(data.tempPassword);
      queryClient.invalidateQueries({ queryKey: ['employees'] });
    },
    onError: (err: any) => setError(err?.response?.data?.error ?? 'Failed to create employee'),
  });

  if (!open) return null;

  const handleClose = () => {
    setForm({ employeeCode: '', email: '', firstName: '', lastName: '', role: 'EMPLOYEE', departmentId: '' });
    setTempPassword(null);
    setError('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4" onClick={handleClose}>
      <div
        className="glass-card w-full max-w-md p-6 space-y-4 animate-fade-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[17px] font-semibold">Add Employee</h2>
          <button onClick={handleClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 p-1 -m-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            <X className="w-4.5 h-4.5" />
          </button>
        </div>

        {tempPassword ? (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              Employee created. Share this temporary password with them directly — there's no automated invite email
              yet, so this is shown once and can't be retrieved again (use "Reset password" later if it's lost).
            </p>
            <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg px-4 py-3 font-mono text-sm break-all">
              {tempPassword}
            </div>
            <button onClick={handleClose} className="btn-primary w-full">
              Done
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError('');
              createMutation.mutate();
            }}
            className="space-y-3"
          >
            <div className="grid grid-cols-2 gap-3">
              <input
                placeholder="First name"
                required
                value={form.firstName}
                onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                className="input-field"
              />
              <input
                placeholder="Last name"
                required
                value={form.lastName}
                onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                className="input-field"
              />
            </div>
            <input
              placeholder="Employee code (e.g. EMP-0005)"
              required
              value={form.employeeCode}
              onChange={(e) => setForm({ ...form, employeeCode: e.target.value })}
              className="input-field w-full"
            />
            <input
              type="email"
              placeholder="Work email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="input-field w-full"
            />
            <div className="grid grid-cols-2 gap-3">
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as typeof form.role })}
                className="input-field"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <select
                value={form.departmentId}
                onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
                className="input-field"
              >
                <option value="">No department</option>
                {departments?.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>

            {error && <p className="text-sm text-red-600 bg-red-50 dark:bg-red-950/30 rounded-lg px-3 py-2">{error}</p>}

            <button
              type="submit"
              disabled={createMutation.isPending}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Create Employee
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
