'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/services/api';
import { Search, Filter, Trash2, Edit } from 'lucide-react';
import { useState } from 'react';
import { useAuthStore } from '@/store/authStore';

interface Department {
  id: string;
  name: string;
  createdAt: string;
  manager: { firstName: string; lastName: string; email: string } | null;
  _count: { employees: number };
}

export const DepartmentTable = () => {
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const canManage = currentUser && ['ADMIN', 'COO', 'CEO'].includes(currentUser.role);

  const { data: departments, isLoading } = useQuery({
    queryKey: ['departments'],
    queryFn: async () => {
      const { data } = await api.get<Department[]>('/departments');
      return data;
    },
  });

  const renameMutation = useMutation({
    mutationFn: (args: { id: string; name: string }) => api.patch(`/departments/${args.id}`, { name: args.name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['departments'] });
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/departments/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['departments'] }),
    onError: (err: any) => alert(err?.response?.data?.error ?? 'Failed to delete department'),
  });

  const filteredDepartments = departments?.filter((dept) => dept.name.toLowerCase().includes(search.toLowerCase()));

  if (isLoading) {
    return (
      <div className="glass-card overflow-hidden">
        <div className="p-4 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 bg-gray-50 dark:bg-gray-900 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card overflow-hidden">
      <div className="p-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search departments..."
            className="w-full pl-10 pr-4 py-2 bg-gray-50 dark:bg-gray-900 border-none rounded-lg focus:ring-2 focus:ring-primary/20 outline-none text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-900 rounded-lg transition-colors">
            <Filter className="w-4 h-4" />
            Filter
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="text-[11px] font-semibold tracking-wider uppercase text-gray-400 font-mono border-b border-gray-100 dark:border-gray-800">
              <th className="px-6 py-3.5">Department</th>
              <th className="px-6 py-3.5">Manager</th>
              <th className="px-6 py-3.5">Employees</th>
              <th className="px-6 py-3.5">Created</th>
              <th className="px-6 py-3.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {filteredDepartments?.map((department) => (
              <tr key={department.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-900/50 transition-colors group">
                <td className="px-6 py-4">
                  {editingId === department.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        renameMutation.mutate({ id: department.id, name: editName });
                      }}
                      className="flex items-center gap-2"
                    >
                      <input
                        autoFocus
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="px-2 py-1 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded text-sm outline-none focus:ring-2 focus:ring-primary/20"
                      />
                      <button type="submit" className="text-xs text-primary font-medium">
                        Save
                      </button>
                      <button type="button" onClick={() => setEditingId(null)} className="text-xs text-gray-400">
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <div className="font-medium">{department.name}</div>
                  )}
                </td>
                <td className="px-6 py-4">
                  <div className="text-sm">
                    {department.manager ? (
                      <div>
                        <div className="font-medium">
                          {department.manager.firstName} {department.manager.lastName}
                        </div>
                        <div className="text-xs text-gray-500">{department.manager.email}</div>
                      </div>
                    ) : (
                      <span className="text-gray-400">Unassigned</span>
                    )}
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span className="text-sm font-tabular font-medium">{department._count?.employees || 0}</span>
                </td>
                <td className="px-6 py-4 text-sm font-tabular text-gray-500">
                  {new Date(department.createdAt).toLocaleDateString()}
                </td>
                <td className="px-6 py-4 text-right">
                  {canManage && (
                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity justify-end">
                      <button
                        onClick={() => {
                          setEditingId(department.id);
                          setEditName(department.name);
                        }}
                        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                      >
                        <Edit className="w-4 h-4 text-gray-400" />
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`Delete "${department.name}"? This can't be undone.`)) {
                            deleteMutation.mutate(department.id);
                          }
                        }}
                        className="p-2 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg transition-colors"
                      >
                        <Trash2 className="w-4 h-4 text-red-400" />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
