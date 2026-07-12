'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/services/api';
import { X, Loader2 } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AddDepartmentModal({ open, onClose }: Props) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const createMutation = useMutation({
    mutationFn: () => api.post('/departments', { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['departments'] });
      handleClose();
    },
    onError: (err: any) => setError(err?.response?.data?.error ?? 'Failed to create department'),
  });

  if (!open) return null;

  const handleClose = () => {
    setName('');
    setError('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4" onClick={handleClose}>
      <div
        className="glass-card w-full max-w-sm p-6 space-y-4 animate-fade-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[17px] font-semibold">Add Department</h2>
          <button onClick={handleClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 p-1 -m-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            <X className="w-4.5 h-4.5" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError('');
            createMutation.mutate();
          }}
          className="space-y-3"
        >
          <input
            placeholder="Department name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input-field"
          />
          {error && <p className="text-sm text-red-600 bg-red-50 dark:bg-red-950/30 rounded-lg px-3 py-2">{error}</p>}
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Create Department
          </button>
        </form>
      </div>
    </div>
  );
}
