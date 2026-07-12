'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/services/api';
import { useState, useEffect } from 'react';
import { Save, AlertCircle, CheckCircle2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState({
    businessHoursStart: '09:00',
    businessHoursEnd: '17:00',
    performanceThreshold: 70.0,
  });
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const { data } = await api.get('/settings');
      return data;
    },
  });

  useEffect(() => {
    if (settings) {
      setFormData({
        businessHoursStart: settings.businessHoursStart || '09:00',
        businessHoursEnd: settings.businessHoursEnd || '17:00',
        performanceThreshold: settings.performanceThreshold || 70.0,
      });
    }
  }, [settings]);

  const updateSettingsMutation = useMutation({
    mutationFn: async (data) => {
      const { data: response } = await api.put('/settings', data);
      return response;
    },
    onSuccess: () => {
      setSaveStatus('success');
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setTimeout(() => setSaveStatus('idle'), 3000);
    },
    onError: () => {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateSettingsMutation.mutate(formData as any);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: name === 'performanceThreshold' ? parseFloat(value) : value,
    }));
  };

  if (isLoading) return <div className="p-8 text-gray-500">Loading settings...</div>;

  return (
    <div className="p-8 space-y-8 max-w-[1400px]">
      <PageHeader eyebrow="Configuration" title="Settings" subtitle="Manage your company settings and preferences." />

      {/* Business Hours */}
      <div className="glass-card p-6 space-y-6">
        <div>
          <h2 className="text-lg font-semibold mb-2">Business Hours</h2>
          <p className="text-sm text-gray-500">Set your company's standard business hours for email tracking and analytics.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Business Hours Start
              </label>
              <input
                type="time"
                name="businessHoursStart"
                value={formData.businessHoursStart}
                onChange={handleChange}
                className="input-field font-tabular"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Business Hours End
              </label>
              <input
                type="time"
                name="businessHoursEnd"
                value={formData.businessHoursEnd}
                onChange={handleChange}
                className="input-field font-tabular"
              />
            </div>
          </div>

          {/* Performance Threshold */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Performance Threshold (%)
            </label>
            <input
              type="number"
              name="performanceThreshold"
              value={formData.performanceThreshold}
              onChange={handleChange}
              min="0"
              max="100"
              step="0.1"
              className="input-field font-tabular max-w-xs"
            />
            <p className="text-xs text-gray-500 mt-2">
              Employees with productivity scores below this threshold will be flagged.
            </p>
          </div>

          {/* Save Status */}
          {saveStatus === 'success' && (
            <div className="flex items-center gap-3 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
              <span className="text-sm text-emerald-700 dark:text-emerald-300">Settings saved successfully!</span>
            </div>
          )}

          {saveStatus === 'error' && (
            <div className="flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
              <span className="text-sm text-red-700 dark:text-red-300">Failed to save settings. Please try again.</span>
            </div>
          )}

          <button
            type="submit"
            disabled={updateSettingsMutation.isPending}
            className="btn-primary flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            {updateSettingsMutation.isPending ? 'Saving...' : 'Save Settings'}
          </button>
        </form>
      </div>

      {/* Additional Settings Sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Email Configuration */}
        <div className="glass-card p-6">
          <h3 className="text-[15px] font-semibold mb-2">Email Configuration</h3>
          <p className="text-sm text-gray-500 mb-4">Configure SMTP settings for email notifications.</p>
          <button className="btn-secondary">Configure SMTP</button>
        </div>

        {/* Notification Rules */}
        <div className="glass-card p-6">
          <h3 className="text-[15px] font-semibold mb-2">Notification Rules</h3>
          <p className="text-sm text-gray-500 mb-4">Set up alerts and notification preferences.</p>
          <button className="btn-secondary">Configure Notifications</button>
        </div>
      </div>

      {/* Security Settings */}
      <div className="glass-card p-6 space-y-4">
        <h3 className="text-[15px] font-semibold">Security</h3>
        <div className="space-y-3">
          <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-900/60 rounded-lg">
            <div>
              <div className="font-medium text-[13.5px]">Two-Factor Authentication</div>
              <p className="text-sm text-gray-500">Add an extra layer of security to your account.</p>
            </div>
            <button className="btn-secondary">Enable</button>
          </div>
          <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-900/60 rounded-lg">
            <div>
              <div className="font-medium text-[13.5px]">Session Management</div>
              <p className="text-sm text-gray-500">View and manage active sessions.</p>
            </div>
            <button className="btn-secondary">Manage</button>
          </div>
        </div>
      </div>
    </div>
  );
}
